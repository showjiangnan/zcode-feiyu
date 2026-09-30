// Modified by ZCode Feiyu contributors (2026).
import { join, relative, sep } from "node:path";
import type {
  FileSystemReadTextRequest,
  FileSystemReadTextRangeRequest,
  FileSystemRevision,
} from "@zcode/contracts";
import { withSecureMemoryFile, type SecureMemoryContent } from "./secure-memory-file.js";

export function memoryRootForPath(directory: string | undefined, path: string): string | undefined {
  if (!directory) return;
  const parts = relative(directory, path).split(sep);
  if (parts.length >= 2 && parts[0] !== ".." && parts[1] === "memory")
    return join(directory, parts[0]!, "memory");
}

export function memoryRevision(value: SecureMemoryContent): FileSystemRevision {
  return {
    id: `mtime:${Math.trunc(value.mtimeMs)}:size:${value.size}`,
    mtimeMs: value.mtimeMs,
    sizeBytes: value.size,
    hash: value.hash,
  };
}

export async function readSecureMemory(root: string, request: FileSystemReadTextRequest) {
  const value = await withSecureMemoryFile(root, request.path, false, (file) => file.read());
  const bytes = Buffer.from(value.bytes ?? Buffer.from(value.content));
  const content = request.maxBytes === undefined ? bytes : bytes.subarray(0, request.maxBytes);
  return {
    path: request.path,
    content: content.toString("utf8").replace(/\r\n/g, "\n"),
    encoding: "utf8" as const,
    lineEndings: value.content.includes("\r\n") ? ("CRLF" as const) : ("LF" as const),
    bytesRead: content.length,
    sizeBytes: value.size,
    truncated: content.length < value.size,
    revision: memoryRevision(value),
  };
}

export async function readSecureMemoryRange(root: string, request: FileSystemReadTextRangeRequest) {
  const value = await readSecureMemory(root, { path: request.path });
  if (request.maxBytes !== undefined && value.sizeBytes > request.maxBytes)
    throw new Error("Memory range exceeds size limit");
  const lines = value.content.length ? value.content.split("\n") : [];
  const offset = request.offsetLine ?? 0;
  const selected = lines.slice(
    offset,
    request.limitLines === undefined ? undefined : offset + request.limitLines,
  );
  return {
    ...value,
    content: selected.join("\n"),
    startLine: offset + 1,
    lineCount: selected.length,
    totalLines: lines.length,
  };
}
