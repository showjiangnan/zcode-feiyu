// Modified by ZCode Feiyu.
import { readFile, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import {
  createFileSystemError,
  type FileSystemSearchTextEntry,
  type FileSystemSearchTextRequest,
  type FileSystemSearchTextResult,
} from "@zcode/contracts";
import type { FileSystemPort } from "@zcode/contracts";

type ProtectedFileSystem = Pick<FileSystemPort, "listDirectory" | "stat" | "readTextFile">;
import { resolveAbsoluteRequestPath, toFileSystemError } from "./file-operations.js";
import {
  throwIfAborted,
  looksBinary,
  type FileSearchCandidate,
  createGlobMatcher,
  toPosixRelative,
  matchesFileType,
  walkFiles,
  createTextResultFilter,
} from "./search-paths.js";
import { searchMultilineContent, searchLineContent } from "./search-matching.js";
import { finishTextSearchResult } from "./search-results.js";

export async function searchTextWithJavaScript(
  request: FileSystemSearchTextRequest,
  signal?: AbortSignal,
  protectedFs?: ProtectedFileSystem,
): Promise<FileSystemSearchTextResult> {
  const path = resolveAbsoluteRequestPath(request.path);
  const pattern = request.pattern.trim();
  const startedAt = Date.now();

  if (pattern.length === 0) {
    throw createFileSystemError({
      code: "invalid_pattern",
      path,
      message: "Grep pattern must not be empty",
    });
  }

  try {
    throwIfAborted(signal);
    const regex = compileSearchRegex(pattern, request);
    const mode = request.outputMode ?? "files_with_matches";
    const candidates = protectedFs
      ? await collectProtectedMemoryCandidates(protectedFs, path, request, signal)
      : await collectTextSearchCandidates(path, await stat(path), request, signal);

    const searchRequest = mode === "content" ? request : { ...request, onlyMatching: false };
    const contentEntries: FileSystemSearchTextEntry[] = [];
    const countEntries: FileSystemSearchTextEntry[] = [];
    const matchingFiles: Array<{ path: string; mtimeMs: number }> = [];
    let numMatches = 0;

    for (const candidate of candidates) {
      throwIfAborted(signal);
      const content = protectedFs
        ? (await protectedFs.readTextFile({ path: candidate.path })).content
        : await readFile(candidate.path, "utf8");
      if (looksBinary(content)) continue;

      const search = request.multiline
        ? searchMultilineContent(candidate.path, content, regex, searchRequest)
        : searchLineContent(candidate.path, content, regex, searchRequest);

      if (search.matchCount === 0) continue;

      numMatches += search.matchCount;
      matchingFiles.push({ path: candidate.path, mtimeMs: candidate.mtimeMs });
      if (mode === "content") {
        contentEntries.push(...search.entries);
      } else if (mode === "count") {
        countEntries.push({
          path: candidate.path,
          count: search.matchCount,
        });
      }
    }

    matchingFiles.sort((left, right) => {
      const timeComparison = right.mtimeMs - left.mtimeMs;
      return timeComparison === 0 ? left.path.localeCompare(right.path) : timeComparison;
    });

    return finishTextSearchResult({
      path,
      pattern,
      mode,
      startedAt,
      request,
      files: matchingFiles.map((item) => item.path),
      entries: mode === "content" ? contentEntries : countEntries,
      numMatches,
    });
  } catch (error) {
    throw toFileSystemError(error, path);
  }
}

export function compileSearchRegex(pattern: string, request: FileSystemSearchTextRequest): RegExp {
  try {
    const flags = `${request.ignoreCase ? "i" : ""}${request.multiline ? "s" : ""}`;
    return new RegExp(pattern, flags);
  } catch (error) {
    throw createFileSystemError({
      code: "invalid_pattern",
      path: request.path,
      message: `Invalid grep regular expression: ${pattern}`,
      cause: error,
    });
  }
}

export async function collectTextSearchCandidates(
  path: string,
  rootInfo: Awaited<ReturnType<typeof stat>>,
  request: FileSystemSearchTextRequest,
  signal?: AbortSignal,
): Promise<FileSearchCandidate[]> {
  const candidates: FileSearchCandidate[] = [];
  const globMatcher = request.glob ? createGlobMatcher(request.glob) : undefined;
  const root = rootInfo.isDirectory() ? path : dirname(path);

  const addIfCandidate = async (filePath: string, info: Awaited<ReturnType<typeof stat>>) => {
    if (!info.isFile()) return;
    const relativePath = toPosixRelative(root, filePath);
    if (globMatcher && !globMatcher(relativePath, basename(filePath))) return;
    if (request.type && !matchesFileType(filePath, request.type)) return;
    candidates.push({ path: filePath, mtimeMs: Number(info.mtimeMs ?? 0) });
  };

  if (rootInfo.isFile()) {
    await addIfCandidate(path, rootInfo);
    return candidates;
  }

  if (!rootInfo.isDirectory()) {
    throw createFileSystemError({
      code: "not_file",
      path,
      message: `Grep search path must be a file or directory: ${path}`,
    });
  }

  await walkFiles(root, signal, addIfCandidate);
  candidates.sort((left, right) => left.path.localeCompare(right.path));
  return candidates;
}

export async function walkProtectedMemoryFiles(
  fs: ProtectedFileSystem,
  directory: string,
  signal: AbortSignal | undefined,
  visitor: (path: string, info: { mtimeMs?: number | bigint }) => void | Promise<void>,
): Promise<void> {
  throwIfAborted(signal);
  for (const entry of (await fs.listDirectory({ path: directory }, { signal })).entries) {
    throwIfAborted(signal);
    if (entry.kind === "directory") await walkProtectedMemoryFiles(fs, entry.path, signal, visitor);
    else if (entry.kind === "file") await visitor(entry.path, await fs.stat({ path: entry.path }));
  }
}

export async function collectProtectedMemoryCandidates(
  fs: ProtectedFileSystem,
  path: string,
  request: FileSystemSearchTextRequest,
  signal?: AbortSignal,
): Promise<FileSearchCandidate[]> {
  const info = await fs.stat({ path });
  const accept = createTextResultFilter(info.kind === "directory" ? path : dirname(path), request);
  const candidates: FileSearchCandidate[] = [];
  const visit = (filePath: string, metadata: { mtimeMs?: number | bigint }) => {
    if (accept(filePath))
      candidates.push({ path: filePath, mtimeMs: Number(metadata.mtimeMs ?? 0) });
  };
  if (info.kind === "directory") await walkProtectedMemoryFiles(fs, path, signal, visit);
  else if (info.kind === "file") visit(path, info);
  else
    throw createFileSystemError({
      code: "not_file",
      path,
      message: "Memory search requires a regular file or directory",
    });
  return candidates.sort((a, b) => a.path.localeCompare(b.path));
}
