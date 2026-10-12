// Modified by ZCode Feiyu.
import { constants } from "node:fs";
import { mkdir, open, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  createFileSystemError,
  isFileSystemPortError,
  type FileSystemPort,
  type FileSystemListDirectoryRequest,
  type FileSystemListDirectoryResult,
  type FileSystemRemoveFileRequest,
  type FileSystemRemoveFileResult,
  type FileSystemRevision,
  type FileSystemSearchFilesRequest,
  type FileSystemSearchFilesResult,
  type FileSystemSearchTextRequest,
  type FileSystemSearchTextResult,
  type FileSystemWriteTextRequest,
  type FileSystemWriteTextResult,
} from "@zcode/contracts";
import { applyRequestedLineEndings, encodeTextContent } from "./text-metadata.js";
import { maybeThrowStorageFsFault } from "../storage/fs-fault-injection.js";
import { memoryRootForPath, memoryRevision } from "./memory-files.js";
import { commitMemoryHistory } from "./memory-history.js";
import { withSecureMemoryFile } from "./secure-memory-file.js";
import { NodeFileSystemReadAdapter } from "./file-system-read.js";
import {
  resolveAbsoluteRequestPath,
  atomicWrite,
  getNodeErrorCode,
  staleAbsentWriteError,
  revisionId,
  hashBuffer,
  toFileSystemError,
  direntKind,
} from "./file-operations.js";
import { throwIfAborted, createGlobMatcher, toPosixRelative, walkFiles } from "./search-paths.js";
import { walkProtectedMemoryFiles, searchTextWithJavaScript } from "./search-javascript.js";
import {
  DEFAULT_GLOB_MAX_RESULTS,
  type NodeFileSystemAdapterOptions,
} from "./file-system-options.js";
import { searchTextWithRipgrep } from "./ripgrep-search.js";
import { RipgrepRuntimeFailure } from "./ripgrep-worker.js";

export class NodeFileSystemAdapter extends NodeFileSystemReadAdapter implements FileSystemPort {
  async writeTextFile(
    request: FileSystemWriteTextRequest,
    options?: { signal?: AbortSignal },
  ): Promise<FileSystemWriteTextResult> {
    const path = resolveAbsoluteRequestPath(request.path);
    const encoding = request.encoding ?? "utf8";
    const textContent = applyRequestedLineEndings(request.content, request.lineEndings);
    const content = encodeTextContent({ content: textContent, encoding, path });

    try {
      options?.signal?.throwIfAborted();
      const root =
        memoryRootForPath(this.adapterOptions.memoryRootsDirectory, path) ??
        request.memoryCommit?.rootDir;
      if (root) {
        if (
          !request.memoryCommit ||
          request.memoryCommit.rootDir !== root ||
          !this.adapterOptions.memoryHistoryDirectory
        ) {
          throw new Error("Memory mutation requires the managed commit port");
        }
        const staged = await this.memoryBatches?.stage({ ...request, path, content: textContent });
        if (staged) return staged;
        const result = await commitMemoryHistory(
          this.adapterOptions.memoryHistoryDirectory,
          { ...request, path, content: textContent },
          options?.signal,
        );
        return { path, bytesWritten: result.size, revision: memoryRevision(result) };
      }
      if (request.expectedRevision && request.expectedAbsent) {
        throw new Error("Cannot require both an existing revision and an absent target");
      }
      if (request.expectedRevision) {
        await this.assertExpectedRevision(path, request.expectedRevision);
      }

      if (request.createParents) {
        maybeThrowStorageFsFault({ operation: "mkdir", path: dirname(path) });
        await mkdir(dirname(path), { recursive: true });
      }

      if (request.atomic ?? true) {
        const expectedRevision = request.expectedRevision;
        await atomicWrite(
          path,
          content,
          expectedRevision ? () => this.assertExpectedRevision(path, expectedRevision) : undefined,
          options?.signal,
          request.expectedAbsent === true,
        );
      } else {
        options?.signal?.throwIfAborted();
        maybeThrowStorageFsFault({ operation: "writeFile", path });
        try {
          await writeFile(path, content, request.expectedAbsent ? { flag: "wx" } : undefined);
        } catch (error) {
          if (request.expectedAbsent && getNodeErrorCode(error) === "EEXIST") {
            throw staleAbsentWriteError(path);
          }
          throw error;
        }
      }

      const info = await stat(path);
      return {
        path,
        bytesWritten: content.byteLength,
        revision: {
          id: revisionId(info.mtimeMs, info.size),
          mtimeMs: info.mtimeMs,
          sizeBytes: info.size,
          hash: hashBuffer(content),
        },
      };
    } catch (error) {
      throw toFileSystemError(error, path);
    }
  }
  async removeFile(
    request: FileSystemRemoveFileRequest,
    options?: { signal?: AbortSignal },
  ): Promise<FileSystemRemoveFileResult> {
    const path = resolveAbsoluteRequestPath(request.path);

    try {
      throwIfAborted(options?.signal);
      maybeThrowStorageFsFault({ operation: "rm", path });
      // 记忆删除必须经过带租约的历史提交；普通文件 API 不能绕过唯一写入者。
      if (memoryRootForPath(this.adapterOptions.memoryRootsDirectory, path))
        throw createFileSystemError({
          code: "permission_denied",
          path,
          message: "Memory deletion requires a fenced history commit",
        });
      await unlink(path);
      return { path, removed: true };
    } catch (error) {
      const normalized = toFileSystemError(error, path);
      if (
        request.missingOk === true &&
        isFileSystemPortError(normalized) &&
        normalized.code === "not_found"
      ) {
        return { path, removed: false };
      }
      throw normalized;
    }
  }
  async listDirectory(
    request: FileSystemListDirectoryRequest,
    options?: { signal?: AbortSignal },
  ): Promise<FileSystemListDirectoryResult> {
    const path = resolveAbsoluteRequestPath(request.path);
    const startedAt = Date.now();

    try {
      throwIfAborted(options?.signal);
      const root = memoryRootForPath(this.adapterOptions.memoryRootsDirectory, path);
      if (root) {
        const names = new Set(await withSecureMemoryFile(root, path, false, (file) => file.list()));
        for (const staged of this.memoryBatches?.stagedPaths(path) ?? [])
          names.add(basename(staged));
        const entries: FileSystemListDirectoryResult["entries"] = [];
        for (const name of names) {
          const child = join(path, name);
          try {
            const info = await this.stat({ path: child });
            entries.push({ name, path: child, kind: info.kind });
          } catch (error) {
            // 符号链接及已删除目录项不进入受限记忆视图，其他 IO 错误必须可见。
            if (
              !["ENOENT", "ELOOP", "not_found"].includes(String(getNodeErrorCode(error) ?? "")) &&
              !(error instanceof Error && String(getNodeErrorCode(error.cause)) === "ELOOP")
            )
              throw error;
          }
        }
        return { path, durationMs: Date.now() - startedAt, entries, numEntries: entries.length };
      }
      const info = await stat(path);
      if (!info.isDirectory()) {
        throw createFileSystemError({
          code: "not_file",
          path,
          message: `Directory listing path must be a directory: ${path}`,
        });
      }

      const entries = await readdir(path, { withFileTypes: true });
      throwIfAborted(options?.signal);
      const mapped = entries
        .map((entry) => ({
          kind: direntKind(entry),
          name: entry.name,
          path: join(path, entry.name),
        }))
        .sort((left, right) => left.name.localeCompare(right.name));

      return {
        path,
        durationMs: Math.max(0, Date.now() - startedAt),
        entries: mapped,
        numEntries: mapped.length,
      };
    } catch (error) {
      throw toFileSystemError(error, path);
    }
  }
  async searchFiles(
    request: FileSystemSearchFilesRequest,
    options?: { signal?: AbortSignal },
  ): Promise<FileSystemSearchFilesResult> {
    const path = resolveAbsoluteRequestPath(request.path);
    const pattern = request.pattern.trim();
    const startedAt = Date.now();

    if (pattern.length === 0) {
      throw createFileSystemError({
        code: "invalid_pattern",
        path,
        message: "Glob pattern must not be empty",
      });
    }

    try {
      throwIfAborted(options?.signal);
      const managed = Boolean(memoryRootForPath(this.adapterOptions.memoryRootsDirectory, path));
      const rootInfo = await this.stat({ path });
      if (rootInfo.kind !== "directory") {
        throw createFileSystemError({
          code: "not_file",
          path,
          message: `Glob search path must be a directory: ${path}`,
        });
      }

      const matcher = createGlobMatcher(pattern);
      const matches: Array<{ path: string; mtimeMs: number }> = [];

      const visit = async (filePath: string, info: { mtimeMs?: number | bigint }) => {
        const relativePath = toPosixRelative(path, filePath);
        if (matcher(relativePath, basename(filePath))) {
          matches.push({ path: filePath, mtimeMs: Number(info.mtimeMs ?? 0) });
        }
      };
      if (managed) await walkProtectedMemoryFiles(this, path, options?.signal, visit);
      else await walkFiles(path, options?.signal, visit);

      matches.sort((left, right) => {
        const timeComparison = right.mtimeMs - left.mtimeMs;
        return timeComparison === 0 ? left.path.localeCompare(right.path) : timeComparison;
      });

      const offset = request.offset ?? 0;
      const maxResults = request.maxResults ?? DEFAULT_GLOB_MAX_RESULTS;
      const files = matches.slice(offset, offset + maxResults).map((match) => match.path);

      return {
        path,
        pattern,
        durationMs: Math.max(0, Date.now() - startedAt),
        files,
        numFiles: files.length,
        truncated: matches.length > offset + maxResults,
      };
    } catch (error) {
      throw toFileSystemError(error, path);
    }
  }
  async searchText(
    request: FileSystemSearchTextRequest,
    options?: { signal?: AbortSignal },
  ): Promise<FileSystemSearchTextResult> {
    const path = resolveAbsoluteRequestPath(request.path);
    const normalizedRequest = request.path === path ? request : { ...request, path };

    if (memoryRootForPath(this.adapterOptions.memoryRootsDirectory, path))
      return searchTextWithJavaScript(normalizedRequest, options?.signal, this);
    if (this.adapterOptions.textSearchEngine === "javascript") {
      return searchTextWithJavaScript(normalizedRequest, options?.signal);
    }

    try {
      return await searchTextWithRipgrep(normalizedRequest, options?.signal);
    } catch (error) {
      if (error instanceof RipgrepRuntimeFailure) {
        return searchTextWithJavaScript(normalizedRequest, options?.signal);
      }
      throw toFileSystemError(error, path);
    }
  }
  protected async assertExpectedRevision(
    path: string,
    expected: FileSystemRevision,
  ): Promise<void> {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let stale = false;
    try {
      const info = await handle.stat();
      stale = revisionId(info.mtimeMs, info.size) !== expected.id;
      if (!stale && expected.hash) {
        // 原因：外部编辑器可能在同一时间戳粒度内写入等长内容；仅比较 mtime/size 会误放行。
        stale = hashBuffer(await handle.readFile()) !== expected.hash;
      }
    } finally {
      await handle.close();
    }
    if (stale) {
      throw createFileSystemError({
        code: "stale_write",
        path,
        message: `File changed since it was read: ${path}`,
      });
    }
  }
}

export function createNodeFileSystemAdapter(
  options: NodeFileSystemAdapterOptions = {},
): NodeFileSystemAdapter {
  return new NodeFileSystemAdapter(options);
}

export {
  listMemoryHistory,
  readMemoryHistory,
  recoverMemoryHistory,
  commitMemoryHistory,
} from "./memory-history.js";
export { withSecureMemoryFile } from "./secure-memory-file.js";
export { type NodeFileSystemAdapterOptions } from "./file-system-options.js";
export { setRipgrepWorkerFactoryForTests } from "./ripgrep-worker.js";
export { setRipgrepTimeoutMsForTests } from "./ripgrep-worker.js";
