// Modified by ZCode Feiyu.
import { mkdir, readFile, readdir, lstat, link, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { object } from "../domain/history.js";
import { atomicPrivateFile } from "./privateState.js";
import { containedPath, digest } from "./sourceFiles.js";

const secretKey =
  /(?:api.?key|token|secret|password|authorization|credential|(?:^|[_-])auth(?:$|[_-]))/iu;
export function isCredentialFileName(name: string): boolean {
  return (
    /^(?:\.?auth\.json|\.?credentials(?:\..*)?|\.env(?:\..*)?|id_(?:rsa|ed25519|ecdsa|dsa)(?:\..*)?)$/iu.test(
      name,
    ) ||
    /\.(?:p12|pfx)$/iu.test(name) ||
    /(?:private[-_.]?key|secret[-_.]?key)\.pem$/iu.test(name)
  );
}
export function sensitive(value: unknown): boolean {
  if (typeof value === "string") {
    if (
      /\bsk-[a-z0-9_-]{12,}|Bearer\s+\S+|-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----|^--?(?:token|secret|password|api.?key|authorization|credential|auth)(?:[= ]|$)/iu.test(
        value,
      )
    )
      return true;
    try {
      const url = new URL(value);
      return (
        Boolean(url.username || url.password) ||
        [...url.searchParams.keys()].some((key) => secretKey.test(key))
      );
    } catch {
      return false;
    }
  }
  if (Array.isArray(value)) return value.some(sensitive);
  return Object.entries(object(value)).some(
    ([key, item]) => secretKey.test(key) || sensitive(item),
  );
}
export async function resourceRevision(
  root: string,
  path: string,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  if (isCredentialFileName(basename(path))) throw new Error("requires_reauthorization");
  if ((await lstat(path)).isSymbolicLink()) throw new Error("resource_symlink_requires_review");
  const verified = await containedPath(root, path);
  const info = await lstat(verified);
  if (info.isDirectory()) {
    const children = (await readdir(verified)).sort();
    return digest(
      JSON.stringify(
        await Promise.all(
          children.map(async (name) => [
            name,
            await resourceRevision(root, join(verified, name), signal),
          ]),
        ),
      ),
    );
  }
  const bytes = await readFile(verified);
  const content = bytes.toString("utf8");
  if (sensitive(content)) throw new Error("requires_reauthorization");
  if (path.endsWith(".json")) {
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      throw new Error("resource_json_invalid");
    }
    if (sensitive(value)) throw new Error("requires_reauthorization");
  }
  return digest(bytes.toString("base64"));
}
async function copyTree(
  root: string,
  source: string,
  target: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  if ((await lstat(source)).isSymbolicLink()) throw new Error("resource_symlink_requires_review");
  const verified = await containedPath(root, source);
  if ((await lstat(verified)).isDirectory()) {
    await mkdir(target, { recursive: true, mode: 0o700 });
    for (const name of await readdir(verified))
      await copyTree(root, join(verified, name), join(target, name), signal);
  } else await atomicPrivateFile(target, await readFile(verified));
}
export async function copyResource(
  root: string,
  path: string,
  target: string,
  revision: string,
  signal: AbortSignal,
): Promise<void> {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const stage = `${target}.${randomUUID()}.stage`;
  try {
    await resourceRevision(root, path, signal);
    await copyTree(root, path, stage, signal);
    // 来源可能在扫描后或复制期间变化；已验证内容与实际复制内容必须一致。
    if (
      (await resourceRevision(root, path, signal)) !== revision ||
      (await resourceRevision(dirname(stage), stage, signal)) !== revision
    )
      throw new Error("source_changed_rescan_required");
    signal.throwIfAborted();
    if ((await lstat(stage)).isDirectory()) {
      // 目标目录预先独占，避免 rename 覆盖其他写入者建立的空目录。
      await mkdir(target, { mode: 0o700 });
      try {
        for (const name of await readdir(stage))
          await rename(join(stage, name), join(target, name));
      } catch (error) {
        throw new Error("resource_partial_copy_requires_review", { cause: error });
      }
    } else await link(stage, target);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
