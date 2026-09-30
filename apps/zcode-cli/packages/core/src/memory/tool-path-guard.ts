// Modified by ZCode Feiyu contributors (2026).
import { lstat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { resolveSafeMemoryFilePath } from "./memory-file-path.js";
import type { FileSystemPort } from "@zcode/contracts";

export async function assertMemoryToolPathSafe(input: {
  rootDir: string;
  toolCall: { name: string; input: unknown };
  workingDirectory: string;
  workspaceRoot: string;
  fileSystem?: FileSystemPort;
}): Promise<void> {
  const { name } = input.toolCall;
  if (!["Read", "Write", "Edit", "Grep", "Glob"].includes(name)) return;
  const raw = input.toolCall.input;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Memory tool path is missing");
  }
  const property = name === "Grep" || name === "Glob" ? "path" : "file_path";
  const value = (raw as Record<string, unknown>)[property];
  if (typeof value !== "string" || !value.trim()) throw new Error("Memory tool path is missing");

  const rootDir = resolve(input.rootDir);
  const target =
    value === rootDir
      ? rootDir
      : resolveSafeMemoryFilePath({
          filePath: value,
          rootDir,
          workingDirectory: input.workingDirectory,
          workspaceRoot: input.workspaceRoot,
        });
  if (!target) throw new Error("Memory tool path is outside the permitted directory");
  if (input.fileSystem && !["Grep", "Glob"].includes(name)) {
    // Adapter 通过固定目录句柄读写；暂存提取文件也必须经同一端口判定。
    try {
      const entry = await input.fileSystem.stat({ path: target });
      if (entry.kind !== "file") throw new Error("Memory tool target is not a regular file");
    } catch (error) {
      if (
        name !== "Write" ||
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "not_found"
      )
        throw error;
    }
    return;
  }
  const suffix = relative(rootDir, target);
  if (suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    throw new Error("Memory tool path escapes the permitted directory");
  }

  const root = await lstat(rootDir);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error("Memory root must be a regular directory");
  }
  const segments = suffix ? suffix.split(sep) : [];
  let current = rootDir;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    const isLast = index === segments.length - 1;
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink()) throw new Error("Memory tool path contains a symbolic link");
      if (!isLast && !entry.isDirectory()) throw new Error("Memory tool parent is not a directory");
      if (isLast && name !== "Grep" && name !== "Glob" && !entry.isFile()) {
        throw new Error("Memory tool target is not a regular file");
      }
    } catch (error) {
      if (!isNotFound(error) || !isLast || name !== "Write") throw error;
    }
  }
  if (segments.length === 0 && name !== "Grep" && name !== "Glob") {
    throw new Error("Memory tool requires a Markdown file");
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
