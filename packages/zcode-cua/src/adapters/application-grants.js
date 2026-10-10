// Modified by ZCode Feiyu contributors (2026).
import { readFile, mkdir, writeFile, rename, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { CuaError } from "../domain/protocol.js";
const initial = "initial";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const workspace = (context) =>
  typeof context === "string"
    ? context
    : context.workspaceIdentity?.trim() || context.workspacePath || context.workspaceKey;
const key = (context, app) =>
  JSON.stringify([workspace(context), app.appKey || app.appId, app.path, app.fileIdentity || ""]);
async function read(path) {
  try {
    const data = await readFile(path, "utf8");
    if (data.length > 1024 * 1024)
      throw new CuaError(
        "authorization_unavailable",
        "Application approval data exceeds its limit",
      );
    return JSON.parse(data);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}
async function atomic(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
export function persistentGrants(directory) {
  const records = join(directory, "grants-v2"),
    epochs = join(directory, "epochs-v2");
  const gatePath = (context) => join(epochs, `${digest(workspace(context))}.json`);
  async function gate(context) {
    const path = gatePath(context);
    let value;
    try {
      value = await read(path);
    } catch {
      throw new CuaError(
        "authorization_unavailable",
        "Cannot verify application approval revision",
      );
    }
    if (
      value &&
      (value.schemaVersion !== 1 ||
        typeof value.epoch !== "string" ||
        !/^[a-f0-9-]{36}$/u.test(value.epoch))
    )
      throw new CuaError("authorization_unavailable", "Application approval revision is invalid");
    return { path, epoch: value?.epoch || initial };
  }
  async function load(context, app, expected) {
    if (!app.path || !app.fileIdentity) return false;
    const current = expected || (await gate(context));
    const record = await read(join(records, `${digest(key(context, app))}.${current.epoch}.json`));
    const approved =
      record?.schemaVersion === 2 && record.epoch === current.epoch && record.approved === true;
    if (!approved && current.epoch === initial) {
      const legacy = await read(join(directory, "application-grants.json"));
      if (legacy?.[key(context, app)] !== true) return false;
    } else if (!approved) return false;
    return (await gate(context)).epoch === current.epoch;
  }
  async function save(context, app, expected) {
    if (!app.path || !app.fileIdentity)
      throw new CuaError("not_persistable", "This application needs approval for each turn");
    const current = expected || (await gate(context));
    if ((await gate(context)).epoch !== current.epoch)
      throw new CuaError("permission_revoked", "Application approval changed while saving");
    await mkdir(records, { recursive: true, mode: 0o700 });
    const path = join(records, `${digest(key(context, app))}.${current.epoch}.json`);
    await atomic(path, {
      schemaVersion: 2,
      workspaceDigest: digest(workspace(context)),
      epoch: current.epoch,
      approved: true,
    });
    if ((await gate(context)).epoch !== current.epoch) {
      await rm(path, { force: true });
      throw new CuaError("permission_revoked", "Application approval was revoked while saving");
    }
  }
  async function revoke(context) {
    await mkdir(epochs, { recursive: true, mode: 0o700 });
    const epoch = randomUUID();
    await atomic(gatePath(context), { schemaVersion: 1, epoch });
    // 按工作区和旧 epoch 清理，不做全局 map 覆盖；新 epoch 的并发保存必须保留。
    for (const entry of await readdir(records).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    })) {
      if (!/^[a-f0-9]{64}\.(?:initial|[a-f0-9-]{36})\.json$/u.test(entry)) continue;
      const path = join(records, entry),
        value = await read(path);
      if (
        value?.workspaceDigest === digest(workspace(context)) &&
        value.epoch !== (await gate(context)).epoch
      )
        await rm(path, { force: true });
    }
    return { path: gatePath(context), epoch };
  }
  return { gate, load, save, revoke };
}
