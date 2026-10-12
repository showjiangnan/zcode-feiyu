// Modified by ZCode Feiyu.
import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  createFileSystemError,
  type FileSystemCreateDirectoryRequest,
  type FileSystemCreateDirectoryResult,
  type FileSystemReadBytesRequest,
  type FileSystemReadBytesResult,
  type FileSystemReadTextRequest,
  type FileSystemReadTextRangeRequest,
  type FileSystemReadTextRangeResult,
  type FileSystemReadTextResult,
  type FileSystemStatRequest,
  type FileSystemStatResult,
  type MemoryBatchInput,
  type MemoryBatchSettlement,
} from "@zcode/contracts";
import {
  decodeTextBuffer,
  detectLineEndings,
  normalizeLineEndings,
  shouldNormalizeLineEndings,
} from "./text-metadata.js";
import { readTextFileRangeFromNode } from "./text-range-reader.js";
import { maybeThrowStorageFsFault } from "../storage/fs-fault-injection.js";
import {
  memoryRootForPath,
  readSecureMemory,
  readSecureMemoryRange,
  memoryRevision,
} from "./memory-files.js";
import { recoverMemoryHistory } from "./memory-history.js";
import { withSecureMemoryFile } from "./secure-memory-file.js";
import { MemoryBatchCoordinator } from "./memory-batch.js";
import { type NodeFileSystemAdapterOptions } from "./file-system-options.js";
import {
  resolveAbsoluteRequestPath,
  toFileSystemError,
  nodeKind,
  revisionId,
  readFirstBytes,
  hashBuffer,
  formatByteCount,
  readAtMostBytes,
} from "./file-operations.js";

export class NodeFileSystemReadAdapter {
  protected readonly memoryBatches?: MemoryBatchCoordinator;
  constructor(protected readonly adapterOptions: NodeFileSystemAdapterOptions = {}) {
    if (adapterOptions.memoryHistoryDirectory)
      this.memoryBatches = new MemoryBatchCoordinator(adapterOptions.memoryHistoryDirectory);
  }
  async runMemoryBatch<T>(
    input: MemoryBatchInput,
    operation: () => Promise<T>,
    settlement: MemoryBatchSettlement,
  ): Promise<T | undefined> {
    if (!this.memoryBatches) throw new Error("Memory batch storage unavailable");
    return this.memoryBatches.run(input, operation, settlement);
  }
  async recoverMemoryBatches(sessionId: string, settlement: MemoryBatchSettlement): Promise<void> {
    await this.memoryBatches?.recover(sessionId, settlement);
  }
  async recoverWorkspaceMemoryBatches(rootDir: string, settlement: MemoryBatchSettlement) {
    if (!this.memoryBatches) throw new Error("Memory batch storage unavailable");
    return this.memoryBatches.recoverWorkspace(rootDir, settlement);
  }
  async recoverMemoryHistory(rootDir: string): Promise<void> {
    if (!this.adapterOptions.memoryHistoryDirectory) throw new Error("Memory history unavailable");
    await recoverMemoryHistory(this.adapterOptions.memoryHistoryDirectory, rootDir);
  }
  async createDirectory(
    request: FileSystemCreateDirectoryRequest,
  ): Promise<FileSystemCreateDirectoryResult> {
    const path = resolveAbsoluteRequestPath(request.path);
    try {
      maybeThrowStorageFsFault({ operation: "mkdir", path });
      const root = memoryRootForPath(this.adapterOptions.memoryRootsDirectory, path);
      if (root)
        await withSecureMemoryFile(root, join(path, ".directory-probe"), true, async () => {});
      else await mkdir(path, { recursive: true });
      return { path };
    } catch (error) {
      throw toFileSystemError(error, path);
    }
  }
  async stat(request: FileSystemStatRequest): Promise<FileSystemStatResult> {
    const path = resolveAbsoluteRequestPath(request.path);
    try {
      const staged = this.memoryBatches?.read(path);
      if (staged)
        return {
          path,
          kind: "file",
          sizeBytes: staged.size,
          mtimeMs: staged.mtimeMs,
          revision: memoryRevision(staged),
        };
      const root = memoryRootForPath(this.adapterOptions.memoryRootsDirectory, path);
      if (root)
        return { path, ...(await withSecureMemoryFile(root, path, false, (file) => file.stat())) };
      const info = await stat(path);
      const kind = nodeKind(info);
      return {
        path,
        kind,
        sizeBytes: info.size,
        mtimeMs: info.mtimeMs,
        revision:
          kind === "file"
            ? {
                id: revisionId(info.mtimeMs, info.size),
                mtimeMs: info.mtimeMs,
                sizeBytes: info.size,
              }
            : undefined,
      };
    } catch (error) {
      throw toFileSystemError(error, path);
    }
  }
  async readTextFile(request: FileSystemReadTextRequest): Promise<FileSystemReadTextResult> {
    const path = resolveAbsoluteRequestPath(request.path);

    try {
      const staged = this.memoryBatches?.read(path);
      if (staged)
        return {
          path,
          content: staged.content,
          encoding: "utf8",
          bytesRead: staged.size,
          sizeBytes: staged.size,
          truncated: false,
          revision: memoryRevision(staged),
        };
      const root = memoryRootForPath(this.adapterOptions.memoryRootsDirectory, path);
      if (root) return await readSecureMemory(root, request);
      const info = await stat(path);
      if (info.isDirectory()) {
        throw createFileSystemError({
          code: "is_directory",
          path,
          message: `Cannot read directory as text file: ${path}`,
        });
      }
      if (!info.isFile()) {
        throw createFileSystemError({
          code: "not_file",
          path,
          message: `Cannot read non-file path as text: ${path}`,
        });
      }

      const maxBytes = request.maxBytes;
      const truncated = maxBytes !== undefined && info.size > maxBytes;
      const buffer = truncated ? await readFirstBytes(path, maxBytes) : await readFile(path);
      const decoded = decodeTextBuffer({ buffer, encoding: request.encoding, path });
      const rawContent = decoded.content;
      const encoding = decoded.encoding;
      const isText = shouldNormalizeLineEndings(encoding);
      const lineEndings = isText ? detectLineEndings(rawContent) : undefined;
      const content = isText ? normalizeLineEndings(rawContent) : rawContent;

      return {
        path,
        content,
        encoding,
        lineEndings,
        bytesRead: buffer.byteLength,
        sizeBytes: info.size,
        truncated,
        revision: {
          id: revisionId(info.mtimeMs, info.size),
          mtimeMs: info.mtimeMs,
          sizeBytes: info.size,
          hash: hashBuffer(buffer),
        },
      };
    } catch (error) {
      throw toFileSystemError(error, path);
    }
  }
  async readBinaryFile(request: FileSystemReadBytesRequest): Promise<FileSystemReadBytesResult> {
    const path = resolveAbsoluteRequestPath(request.path);

    try {
      const root = memoryRootForPath(this.adapterOptions.memoryRootsDirectory, path);
      if (root) {
        const value =
          this.memoryBatches?.read(path) ??
          (await withSecureMemoryFile(root, path, false, (file) => file.read()));
        if (request.maxBytes !== undefined && value.size > request.maxBytes)
          throw createFileSystemError({
            code: "too_large",
            path,
            message: "Memory file exceeds binary read limit",
          });
        return {
          path,
          content: Buffer.from(value.bytes ?? Buffer.from(value.content)),
          bytesRead: value.size,
          sizeBytes: value.size,
          revision: memoryRevision(value),
        };
      }
      const info = await stat(path);
      if (info.isDirectory()) {
        throw createFileSystemError({
          code: "is_directory",
          path,
          message: `Cannot read directory as binary file: ${path}`,
        });
      }
      if (!info.isFile()) {
        throw createFileSystemError({
          code: "not_file",
          path,
          message: `Cannot read non-file path as binary: ${path}`,
        });
      }
      if (request.maxBytes !== undefined && info.size > request.maxBytes) {
        throw createFileSystemError({
          code: "too_large",
          path,
          message: `File content (${formatByteCount(info.size)}) exceeds maximum allowed size (${formatByteCount(request.maxBytes)}). Use a smaller file.`,
        });
      }

      const buffer =
        request.maxBytes === undefined
          ? await readFile(path)
          : await readAtMostBytes(path, request.maxBytes + 1, info.size);
      if (request.maxBytes !== undefined && buffer.byteLength > request.maxBytes) {
        // stat 与 readFile 之间文件可能增长；实际读取也必须保持有界，
        // 否则 maxBytes 既挡不住超限内容，也挡不住一次性大内存分配。
        throw createFileSystemError({
          code: "too_large",
          path,
          message: `File content exceeds maximum allowed size (${formatByteCount(request.maxBytes)}). Use a smaller file.`,
        });
      }
      return {
        path,
        content: buffer,
        bytesRead: buffer.byteLength,
        sizeBytes: info.size,
        revision: {
          id: revisionId(info.mtimeMs, info.size),
          mtimeMs: info.mtimeMs,
          sizeBytes: info.size,
          hash: hashBuffer(buffer),
        },
      };
    } catch (error) {
      throw toFileSystemError(error, path);
    }
  }
  async readTextFileRange(
    request: FileSystemReadTextRangeRequest,
    options?: { signal?: AbortSignal },
  ): Promise<FileSystemReadTextRangeResult> {
    const path = resolveAbsoluteRequestPath(request.path);

    try {
      const staged = this.memoryBatches?.read(path);
      if (staged) {
        const lines = staged.content.split("\n");
        const offset = request.offsetLine ?? 0;
        const selected = lines.slice(
          offset,
          request.limitLines === undefined ? undefined : offset + request.limitLines,
        );
        return {
          path,
          content: selected.join("\n"),
          encoding: "utf8",
          bytesRead: staged.size,
          sizeBytes: staged.size,
          truncated: false,
          revision: memoryRevision(staged),
          startLine: offset + 1,
          lineCount: selected.length,
          totalLines: lines.length,
        };
      }
      const root = memoryRootForPath(this.adapterOptions.memoryRootsDirectory, path);
      if (root) return await readSecureMemoryRange(root, request);
      const info = await stat(path);
      if (info.isDirectory()) {
        throw createFileSystemError({
          code: "is_directory",
          path,
          message: `Cannot read directory as text file: ${path}`,
        });
      }
      if (!info.isFile()) {
        throw createFileSystemError({
          code: "not_file",
          path,
          message: `Cannot read non-file path as text: ${path}`,
        });
      }

      return await readTextFileRangeFromNode({ ...request, path }, info, options?.signal);
    } catch (error) {
      throw toFileSystemError(error, path);
    }
  }
}
