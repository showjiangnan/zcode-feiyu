// Modified by ZCode Feiyu.
import { stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { RgArg } from "ripgrep";
import {
  createFileSystemError,
  type FileSystemTextSearchOutputMode,
  type FileSystemSearchTextRequest,
  type FileSystemSearchTextResult,
} from "@zcode/contracts";
import { resolveAbsoluteRequestPath, toFileSystemError } from "./file-operations.js";
import {
  throwIfAborted,
  type RipgrepSearchPlan,
  VCS_DIRECTORIES_TO_EXCLUDE,
  TYPE_EXTENSION_MAP,
} from "./search-paths.js";
import { runBundledRipgrep } from "./ripgrep-worker.js";
import {
  toRipgrepFileSystemError,
  parseRipgrepJsonOutput,
  parseRipgrepCountOutput,
} from "./ripgrep-output.js";
import { sortPathsByMtime, finishTextSearchResult } from "./search-results.js";

export async function searchTextWithRipgrep(
  request: FileSystemSearchTextRequest,
  signal?: AbortSignal,
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

  let rootInfo: Awaited<ReturnType<typeof stat>>;
  try {
    throwIfAborted(signal);
    rootInfo = await stat(path);
  } catch (error) {
    throw toFileSystemError(error, path);
  }

  if (!rootInfo.isFile() && !rootInfo.isDirectory()) {
    throw createFileSystemError({
      code: "not_file",
      path,
      message: `Grep search path must be a file or directory: ${path}`,
    });
  }

  const mode = request.outputMode ?? "files_with_matches";
  const plan = createRipgrepSearchPlan(path, rootInfo, request, mode);
  const result = await runBundledRipgrep(plan.args, plan.preopens, { signal });
  throwIfAborted(signal);

  if (result.code === 2) {
    throw toRipgrepFileSystemError(result.stderr, path, pattern);
  }
  if (result.code !== 0 && result.code !== 1) {
    throw createFileSystemError({
      code: "io_error",
      path,
      message: `ripgrep exited with code ${result.code}: ${result.stderr || "unknown error"}`,
    });
  }

  const parsed =
    mode === "content"
      ? parseRipgrepJsonOutput(result.stdout, plan.outputRoot, request)
      : parseRipgrepCountOutput(result.stdout, plan.outputRoot, request);
  const files = await sortPathsByMtime(parsed.files);

  return finishTextSearchResult({
    path,
    pattern,
    mode,
    startedAt,
    request,
    files,
    entries: mode === "files_with_matches" ? [] : parsed.entries,
    numMatches: parsed.numMatches,
  });
}

export function createRipgrepSearchPlan(
  path: string,
  rootInfo: Awaited<ReturnType<typeof stat>>,
  request: FileSystemSearchTextRequest,
  mode: FileSystemTextSearchOutputMode,
): RipgrepSearchPlan {
  const outputRoot = rootInfo.isDirectory() ? path : dirname(path);
  const target = rootInfo.isDirectory() ? "." : basename(path);
  const args: RgArg[] = [
    "--no-config",
    "--hidden",
    "--color",
    "never",
    "--no-heading",
    "--with-filename",
    "--max-columns",
    "500",
  ];

  for (const dir of VCS_DIRECTORIES_TO_EXCLUDE) {
    args.push("--glob", `!${dir}`, "--glob", `!**/${dir}/**`);
  }

  if (request.multiline) {
    args.push("-U", "--multiline-dotall");
  }

  if (request.ignoreCase) {
    args.push("-i");
  }

  if (mode === "content") {
    args.push("--json");
    if (request.onlyMatching) {
      args.push("--only-matching");
    }
    addRipgrepContextArgs(args, request);
  } else {
    args.push("-c");
  }

  if (request.glob) {
    addRipgrepGlobArgs(args, request.glob);
  }
  if (request.type) {
    addRipgrepTypeArgs(args, request.type);
  }

  args.push("-e", request.pattern.trim(), "--", target);

  return {
    args,
    outputRoot,
    preopens: { ".": outputRoot },
  };
}

export function addRipgrepContextArgs(args: RgArg[], request: FileSystemSearchTextRequest): void {
  if (request.context !== undefined) {
    args.push("-C", String(request.context));
    return;
  }
  if (request.beforeContext !== undefined) {
    args.push("-B", String(request.beforeContext));
  }
  if (request.afterContext !== undefined) {
    args.push("-A", String(request.afterContext));
  }
}

export function addRipgrepGlobArgs(args: RgArg[], glob: string): void {
  for (const pattern of splitRipgrepGlobPatterns(glob)) {
    args.push("--glob", pattern);
  }
}

export function splitRipgrepGlobPatterns(glob: string): string[] {
  const patterns: string[] = [];
  for (const rawPattern of glob.split(/\s+/)) {
    if (rawPattern.includes("{") && rawPattern.includes("}")) {
      patterns.push(rawPattern);
      continue;
    }
    patterns.push(...rawPattern.split(","));
  }
  return patterns.map((pattern) => pattern.trim()).filter(Boolean);
}

export function addRipgrepTypeArgs(args: RgArg[], type: string): void {
  for (const pattern of fileTypeGlobPatterns(type)) {
    args.push("--glob", pattern);
  }
}

export function fileTypeGlobPatterns(type: string): string[] {
  const normalized = normalizeFileType(type);
  if (!/^[a-z0-9_+-]+$/i.test(normalized)) return [];
  const extensions = TYPE_EXTENSION_MAP[normalized] ?? [`.${normalized}`];
  return extensions.flatMap((extension) => [`*${extension}`, `**/*${extension}`]);
}

export function normalizeFileType(type: string): string {
  return type.toLowerCase().replace(/^\./, "");
}
