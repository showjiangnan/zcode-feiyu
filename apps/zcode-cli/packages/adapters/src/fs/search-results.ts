// Modified by ZCode Feiyu.
import { stat } from "node:fs/promises";
import { type FileSystemSearchTextResult } from "@zcode/contracts";
import { type FinishTextSearchParams } from "./search-paths.js";

export const DEFAULT_GREP_HEAD_LIMIT = 250;

export function finishTextSearchResult(params: FinishTextSearchParams): FileSystemSearchTextResult {
  if (params.mode === "files_with_matches") {
    const limited = applyHeadLimit(params.files, params.request.headLimit, params.request.offset);
    return {
      path: params.path,
      pattern: params.pattern,
      mode: params.mode,
      durationMs: Math.max(0, Date.now() - params.startedAt),
      files: limited.items,
      entries: [],
      numMatches: params.numMatches,
      truncated: limited.truncated,
      appliedLimit: limited.appliedLimit,
      appliedOffset: limited.appliedOffset,
    };
  }

  const limited = applyHeadLimit(params.entries, params.request.headLimit, params.request.offset);
  return {
    path: params.path,
    pattern: params.pattern,
    mode: params.mode,
    durationMs: Math.max(0, Date.now() - params.startedAt),
    files: params.files,
    entries: limited.items,
    numMatches: params.numMatches,
    truncated: limited.truncated,
    appliedLimit: limited.appliedLimit,
    appliedOffset: limited.appliedOffset,
  };
}

export async function sortPathsByMtime(paths: string[]): Promise<string[]> {
  const withStats = await Promise.all(
    [...new Set(paths)].map(async (path) => {
      try {
        const info = await stat(path);
        return { path, mtimeMs: Number(info.mtimeMs ?? 0) };
      } catch {
        return { path, mtimeMs: 0 };
      }
    }),
  );

  withStats.sort((left, right) => {
    const timeComparison = right.mtimeMs - left.mtimeMs;
    return timeComparison === 0 ? left.path.localeCompare(right.path) : timeComparison;
  });
  return withStats.map((item) => item.path);
}

export function applyHeadLimit<T>(
  items: T[],
  headLimit: number | undefined,
  offset = 0,
): { items: T[]; appliedLimit?: number; appliedOffset?: number; truncated: boolean } {
  if (headLimit === 0) {
    return {
      items: items.slice(offset),
      appliedOffset: offset > 0 ? offset : undefined,
      truncated: false,
    };
  }

  const effectiveLimit = headLimit ?? DEFAULT_GREP_HEAD_LIMIT;
  const sliced = items.slice(offset, offset + effectiveLimit);
  const truncated = items.length - offset > effectiveLimit;

  return {
    items: sliced,
    appliedLimit: truncated ? effectiveLimit : undefined,
    appliedOffset: offset > 0 ? offset : undefined,
    truncated,
  };
}
