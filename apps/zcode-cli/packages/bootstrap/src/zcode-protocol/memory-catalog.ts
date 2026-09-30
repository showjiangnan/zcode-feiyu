// Modified by ZCode Feiyu contributors (2026).
import { basename, join } from "node:path";
import { withSecureMemoryFile } from "@zcode/adapters/fs";
import type { WorkspaceMemoryResult } from "@zcode/shared";

type Catalog = Extract<WorkspaceMemoryResult, { type: "catalog" }>["workspaces"];
const MAX_TEXT_BYTES = 5 * 1024 * 1024;
const ignored = (error: unknown) =>
  ["ENOENT", "ELOOP", "ENOTDIR"].includes(String((error as NodeJS.ErrnoException)?.code));
const validName = (name: string) =>
  name !== "." &&
  name !== ".." &&
  basename(name) === name &&
  !/[\\/]/.test(name) &&
  !name.includes("\0");
export async function readMemoryCatalog(root: string): Promise<Catalog> {
  let names: string[];
  try {
    names = await withSecureMemoryFile(root, root, false, (file) => file.list());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const workspaces: Catalog = [];
  for (const id of names) {
    if (!validName(id)) continue;
    const directory = join(root, id, "memory");
    try {
      const entries = await withSecureMemoryFile(root, directory, false, (file) => file.list());
      const files: Catalog[number]["files"] = [];
      for (const name of entries.filter((entry) => validName(entry) && entry.endsWith(".md"))) {
        try {
          const path = join(directory, name);
          const metadata = await withSecureMemoryFile(root, path, false, (file) => file.stat());
          if (metadata.kind === "file")
            files.push({
              name,
              path,
              kind: name === "MEMORY.md" ? "index" : "item",
              size: metadata.sizeBytes,
              updatedAt: metadata.mtimeMs,
            });
        } catch (error) {
          if (!ignored(error)) throw error;
        }
      }
      files.sort((a, b) =>
        a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "index" ? -1 : 1,
      );
      if (files.length)
        workspaces.push({
          id,
          label: id.replace(/-[a-f0-9]{16}$/i, ""),
          files,
          updatedAt: Math.max(...files.map((file) => file.updatedAt)),
        });
    } catch (error) {
      if (!ignored(error)) throw error;
    }
  }
  return workspaces.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

export async function readMemoryCatalogFile(
  root: string,
  input: { workspaceId: string; fileName: string },
): Promise<WorkspaceMemoryResult> {
  if (!validName(input.workspaceId)) throw new Error("Invalid memory path");
  return readMemoryFile(root, join(root, input.workspaceId, "memory"), input.fileName);
}

export async function readMemoryFile(
  root: string,
  directory: string,
  fileName: string,
): Promise<WorkspaceMemoryResult> {
  if (!validName(fileName) || !fileName.endsWith(".md")) throw new Error("Invalid memory filename");
  const names = await withSecureMemoryFile(root, directory, false, (file) => file.list());
  if (!names.includes(fileName)) throw new Error("Memory filename must match the catalog exactly");
  const file = await withSecureMemoryFile(root, join(directory, fileName), false, (handle) =>
    handle.read(MAX_TEXT_BYTES),
  );
  // 直接解码 content 会把二进制替换成 U+FFFD；文本预览须校验原始字节，且保留 BOM/CRLF 对应同一 hash。
  if (!file.bytes) throw new Error("Memory text preview requires raw bytes");
  const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(file.bytes);
  if (content.includes("\0")) throw new Error("Memory preview requires UTF-8 text without NUL");
  return { type: "file", content, hash: file.hash, updatedAt: file.mtimeMs };
}
