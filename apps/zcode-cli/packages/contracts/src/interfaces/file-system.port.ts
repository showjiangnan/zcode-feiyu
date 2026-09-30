// Modified by ZCode Feiyu contributors (2026).
// ============================================================
// FileSystem Port - file I/O boundary
// ============================================================

import type { ExecutionContext, TraceContext } from "../tracing/tracer.js";

export type FileSystemErrorCode =
  | "not_found"
  | "permission_denied"
  | "is_directory"
  | "not_file"
  | "too_large"
  | "stale_write"
  | "invalid_path"
  | "invalid_pattern"
  | "unsupported"
  | "cancelled"
  | "io_error";

export interface FileSystemErrorDetails {
  code: FileSystemErrorCode;
  path?: string;
  message: string;
  cause?: unknown;
}

export class FileSystemPortError extends Error {
  readonly code: FileSystemErrorCode;
  readonly path?: string;
  override readonly cause?: unknown;

  constructor(details: FileSystemErrorDetails) {
    super(details.message);
    this.name = "FileSystemPortError";
    this.code = details.code;
    this.path = details.path;
    this.cause = details.cause;
  }
}

export function createFileSystemError(details: FileSystemErrorDetails): FileSystemPortError {
  return new FileSystemPortError(details);
}

export function isFileSystemPortError(error: unknown): error is FileSystemPortError {
  return error instanceof FileSystemPortError;
}

export type FileSystemNodeKind = "file" | "directory" | "symlink" | "other" | "missing";

export interface FileSystemRevision {
  id: string;
  mtimeMs?: number;
  sizeBytes?: number;
  hash?: string;
}

export type FileSystemLineEndings = "LF" | "CRLF";
export type FileSystemTextEncoding = BufferEncoding | "gb2312" | "gbk" | "gb18030";

export interface FileSystemStatRequest {
  /** Normalized absolute path. Relative paths are resolved by the tool layer. */
  path: string;
  trace?: TraceContext;
}

export interface FileSystemStatResult {
  path: string;
  kind: FileSystemNodeKind;
  sizeBytes: number;
  mtimeMs?: number;
  revision?: FileSystemRevision;
}

export interface FileSystemCreateDirectoryRequest {
  /** Normalized absolute path. Parent directories are created recursively. */
  path: string;
  trace?: TraceContext;
}

export interface FileSystemCreateDirectoryResult {
  path: string;
}

export interface FileSystemReadTextRequest {
  /** Normalized absolute path. Relative paths are resolved by the tool layer. */
  path: string;
  encoding?: FileSystemTextEncoding;
  maxBytes?: number;
  trace?: TraceContext;
}

export interface FileSystemReadTextResult {
  path: string;
  /**
   * Text content normalized to LF line endings for tool/core consumption.
   * The original dominant file line ending is reported via `lineEndings`.
   */
  content: string;
  encoding: FileSystemTextEncoding;
  /** Dominant line ending style observed before LF normalization. */
  lineEndings?: FileSystemLineEndings;
  bytesRead: number;
  sizeBytes: number;
  truncated: boolean;
  revision?: FileSystemRevision;
}

export interface FileSystemReadBytesRequest {
  /** Normalized absolute path. Relative paths are resolved by the tool layer. */
  path: string;
  /** Optional total file size guard. Exceeding it fails with `too_large`; it does not truncate. */
  maxBytes?: number;
  trace?: TraceContext;
}

export interface FileSystemReadBytesResult {
  path: string;
  content: Uint8Array;
  bytesRead: number;
  sizeBytes: number;
  revision?: FileSystemRevision;
}

export interface FileSystemReadTextRangeRequest {
  /** Normalized absolute path. Relative paths are resolved by the tool layer. */
  path: string;
  encoding?: FileSystemTextEncoding;
  /** Zero-based logical line offset. Tool-facing one-based offsets are translated before this port. */
  offsetLine?: number;
  /** Number of logical lines to return. Omit to return from offset through EOF. */
  limitLines?: number;
  /** Optional total file size guard. Exceeding it fails with `too_large`; it does not truncate. */
  maxBytes?: number;
  trace?: TraceContext;
}

export interface FileSystemReadTextRangeResult {
  path: string;
  /**
   * Selected text content normalized to LF line endings for tool/core consumption.
   * The original dominant file line ending is reported via `lineEndings`.
   */
  content: string;
  encoding: FileSystemTextEncoding;
  /** Dominant line ending style observed before LF normalization. */
  lineEndings?: FileSystemLineEndings;
  /** Number of bytes consumed by the adapter while producing this range. */
  bytesRead: number;
  /** Total file size in bytes. */
  sizeBytes: number;
  /** True only for adapters that intentionally truncate range reads. Node adapter range reads fail instead. */
  truncated: boolean;
  /** One-based line number of the first returned/requested line. */
  startLine: number;
  /** Number of lines returned in `content`. */
  lineCount: number;
  /** Total logical line count in the file. */
  totalLines: number;
  revision?: FileSystemRevision;
}

/**
 * 调用方长期所有权的提交点断言。由会话存储提供实现，在写租约排他事务内同步调用，
 * 读取调用方租约（如整理任务）的当前 epoch，失效时抛错。
 */
export interface MemoryCommitFence {
  workspaceKey: string;
  ownerId: string;
  epoch: number;
  assertHeld: () => void;
}

export interface FileSystemWriteTextRequest {
  /** 内部记忆修改统一在最终文件提交时验证租约；不进入模型工具参数。 */
  memoryCommit?: {
    rootDir: string;
    operationId: string;
    sourceSessionId: string;
    guard: <T>(commit: () => Promise<T>) => Promise<T>;
    /**
     * 调用方自身的长期所有权栅栏（如整理任务租约）。在写租约排他事务内、文件替换之前再次
     * 断言，使调用方在租约被抢占后不能继续提交。断言失败必须抛错，禁止静默跳过。
     */
    fence?: MemoryCommitFence;
  };
  /** Normalized absolute path. Relative paths are resolved by the tool layer. */
  path: string;
  content: string;
  encoding?: FileSystemTextEncoding;
  /** Restore this line ending style while writing logical LF-normalized text. */
  lineEndings?: FileSystemLineEndings;
  createParents?: boolean;
  atomic?: boolean;
  expectedRevision?: FileSystemRevision;
  /** Only commit a new file if the target still does not exist. */
  expectedAbsent?: boolean;
  trace?: TraceContext;
}

export interface FileSystemWriteTextResult {
  path: string;
  bytesWritten: number;
  revision?: FileSystemRevision;
}

export interface MemoryBatchInput {
  operationId: string;
  sessionId: string;
  boundaryMessageId: string;
  rootDir: string;
}
export interface MemoryBatchSettlement {
  assertAllowed?: () => void;
  commit: (
    request: FileSystemWriteTextRequest,
    source?: {
      batch: MemoryBatchInput;
      operationId: string;
    },
  ) => Promise<FileSystemWriteTextResult>;
  settleCursor: (batch: MemoryBatchInput) => Promise<void>;
  isCurrent: (batch: MemoryBatchInput) => Promise<boolean>;
}

export interface MemoryBatchRecoveryResult {
  recovered: number;
  failedOperationIds: string[];
}

export interface FileSystemRemoveFileRequest {
  /** Normalized absolute path. Relative paths are resolved by the tool layer. */
  path: string;
  /** Treat a missing file as a completed no-op. */
  missingOk?: boolean;
  trace?: TraceContext;
}

export interface FileSystemRemoveFileResult {
  path: string;
  removed: boolean;
}

export interface FileSystemListDirectoryRequest {
  /** Normalized absolute directory path. Relative paths are resolved by the caller. */
  path: string;
  trace?: TraceContext;
}

export interface FileSystemListDirectoryEntry {
  kind: FileSystemNodeKind;
  name: string;
  path: string;
}

export interface FileSystemListDirectoryResult {
  durationMs: number;
  entries: FileSystemListDirectoryEntry[];
  numEntries: number;
  path: string;
}

export interface FileSystemSearchFilesRequest {
  /** Normalized absolute directory path. Relative paths are resolved by the tool layer. */
  path: string;
  /** Glob pattern relative to path unless the adapter documents additional support. */
  pattern: string;
  maxResults?: number;
  offset?: number;
  trace?: TraceContext;
}

export interface FileSystemSearchFilesResult {
  path: string;
  pattern: string;
  durationMs: number;
  files: string[];
  numFiles: number;
  truncated: boolean;
}

export type FileSystemTextSearchOutputMode = "content" | "files_with_matches" | "count";

export interface FileSystemSearchTextRequest {
  /** Normalized absolute file or directory path. Relative paths are resolved by the tool layer. */
  path: string;
  pattern: string;
  glob?: string;
  outputMode?: FileSystemTextSearchOutputMode;
  beforeContext?: number;
  afterContext?: number;
  context?: number;
  showLineNumbers?: boolean;
  onlyMatching?: boolean;
  ignoreCase?: boolean;
  type?: string;
  headLimit?: number;
  offset?: number;
  multiline?: boolean;
  trace?: TraceContext;
}

export interface FileSystemSearchTextEntry {
  path: string;
  lineNumber?: number;
  text?: string;
  count?: number;
  matched?: boolean;
}

export interface FileSystemSearchTextResult {
  path: string;
  pattern: string;
  mode: FileSystemTextSearchOutputMode;
  durationMs: number;
  files: string[];
  entries: FileSystemSearchTextEntry[];
  numMatches: number;
  truncated: boolean;
  appliedLimit?: number;
  appliedOffset?: number;
}

export interface FileSystemOperationOptions {
  signal?: AbortSignal;
  context?: ExecutionContext;
}

export interface FileSystemPort {
  runMemoryBatch?<T>(
    input: MemoryBatchInput,
    operation: () => Promise<T>,
    settlement: MemoryBatchSettlement,
  ): Promise<T | undefined>;
  recoverMemoryBatches?(sessionId: string, settlement: MemoryBatchSettlement): Promise<void>;
  recoverWorkspaceMemoryBatches?(
    rootDir: string,
    settlement: MemoryBatchSettlement,
  ): Promise<MemoryBatchRecoveryResult>;
  recoverMemoryHistory?(rootDir: string): Promise<void>;
  createDirectory(
    request: FileSystemCreateDirectoryRequest,
    options?: FileSystemOperationOptions,
  ): Promise<FileSystemCreateDirectoryResult>;
  stat(
    request: FileSystemStatRequest,
    options?: FileSystemOperationOptions,
  ): Promise<FileSystemStatResult>;
  readTextFile(
    request: FileSystemReadTextRequest,
    options?: FileSystemOperationOptions,
  ): Promise<FileSystemReadTextResult>;
  readBinaryFile(
    request: FileSystemReadBytesRequest,
    options?: FileSystemOperationOptions,
  ): Promise<FileSystemReadBytesResult>;
  readTextFileRange(
    request: FileSystemReadTextRangeRequest,
    options?: FileSystemOperationOptions,
  ): Promise<FileSystemReadTextRangeResult>;
  writeTextFile(
    request: FileSystemWriteTextRequest,
    options?: FileSystemOperationOptions,
  ): Promise<FileSystemWriteTextResult>;
  removeFile(
    request: FileSystemRemoveFileRequest,
    options?: FileSystemOperationOptions,
  ): Promise<FileSystemRemoveFileResult>;
  listDirectory(
    request: FileSystemListDirectoryRequest,
    options?: FileSystemOperationOptions,
  ): Promise<FileSystemListDirectoryResult>;
  searchFiles(
    request: FileSystemSearchFilesRequest,
    options?: FileSystemOperationOptions,
  ): Promise<FileSystemSearchFilesResult>;
  searchText(
    request: FileSystemSearchTextRequest,
    options?: FileSystemOperationOptions,
  ): Promise<FileSystemSearchTextResult>;
}
