// Modified by ZCode Feiyu.
import { isAbsolute, join, normalize } from "node:path";
import {
  createFileSystemError,
  type FileSystemSearchTextEntry,
  type FileSystemSearchTextRequest,
} from "@zcode/contracts";
import { type ParsedTextSearch, createTextResultFilter } from "./search-paths.js";
import { createOnlyMatchingEntries } from "./search-matching.js";

export function parseRipgrepJsonOutput(
  stdout: string,
  outputRoot: string,
  request: FileSystemSearchTextRequest,
): ParsedTextSearch {
  const entries: FileSystemSearchTextEntry[] = [];
  const files = new Set<string>();
  const shouldKeep = createTextResultFilter(outputRoot, request);
  let numMatches = 0;

  for (const line of splitOutputLines(stdout)) {
    const event = parseRipgrepJsonEvent(line, request.path);
    if (event.type !== "match" && event.type !== "context") continue;

    const rawPath = event.data?.path?.text;
    if (!rawPath) continue;

    const path = resolveRipgrepOutputPath(outputRoot, rawPath);
    if (!shouldKeep(path)) continue;

    const matched = event.type === "match";
    if (matched) {
      files.add(path);
      numMatches += 1;
    }

    if (request.onlyMatching && matched) {
      const submatches = event.data?.submatches ?? [];
      if (submatches.length > 0) {
        const lineNumber =
          typeof event.data?.line_number === "number" ? event.data.line_number : undefined;
        for (const submatch of submatches) {
          entries.push(
            ...createOnlyMatchingEntries({
              path,
              text: submatch.match?.text ?? "",
              lineNumber,
            }),
          );
        }
        continue;
      }
    }

    entries.push({
      path,
      lineNumber: typeof event.data?.line_number === "number" ? event.data.line_number : undefined,
      text: stripTrailingLineEnding(event.data?.lines?.text ?? ""),
      matched,
    });
  }

  return { entries, files: [...files], numMatches };
}

export function parseRipgrepCountOutput(
  stdout: string,
  outputRoot: string,
  request: FileSystemSearchTextRequest,
): ParsedTextSearch {
  const entries: FileSystemSearchTextEntry[] = [];
  const files = new Set<string>();
  const shouldKeep = createTextResultFilter(outputRoot, request);
  let numMatches = 0;

  for (const line of splitOutputLines(stdout)) {
    const separatorIndex = line.lastIndexOf(":");
    if (separatorIndex <= 0) continue;

    const rawPath = line.slice(0, separatorIndex);
    const count = Number.parseInt(line.slice(separatorIndex + 1), 10);
    if (!Number.isFinite(count) || count <= 0) continue;

    const path = resolveRipgrepOutputPath(outputRoot, rawPath);
    if (!shouldKeep(path)) continue;

    files.add(path);
    numMatches += count;
    entries.push({ path, count });
  }

  return { entries, files: [...files], numMatches };
}

export function splitOutputLines(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
    .filter((line, index, lines) => line.length > 0 || index < lines.length - 1);
}

export interface RipgrepJsonEvent {
  type?: string;
  data?: {
    path?: { text?: string };
    lines?: { text?: string };
    submatches?: Array<{ match?: { text?: string } }>;
    line_number?: number;
  };
}

export function parseRipgrepJsonEvent(line: string, path: string): RipgrepJsonEvent {
  try {
    return JSON.parse(line) as RipgrepJsonEvent;
  } catch (error) {
    throw createFileSystemError({
      code: "io_error",
      path,
      message: "Failed to parse ripgrep JSON output",
      cause: error,
    });
  }
}

export function resolveRipgrepOutputPath(root: string, rawPath: string): string {
  if (isAbsolute(rawPath)) return normalize(rawPath);
  const withoutLeadingDot = rawPath.startsWith("./") ? rawPath.slice(2) : rawPath;
  return normalize(join(root, withoutLeadingDot));
}

export function stripTrailingLineEnding(value: string): string {
  return value.replace(/\r?\n$/, "");
}

export function toRipgrepFileSystemError(stderr: string, path: string, pattern: string): Error {
  const message = stderr.trim() || `ripgrep failed while searching ${path}`;
  const normalized = message.toLowerCase();

  if (
    normalized.includes("regex parse error") ||
    normalized.includes("error parsing regex") ||
    normalized.includes("unclosed")
  ) {
    return createFileSystemError({
      code: "invalid_pattern",
      path,
      message: `Invalid grep regular expression: ${pattern}`,
    });
  }

  if (normalized.includes("permission denied") || normalized.includes("os error 13")) {
    return createFileSystemError({
      code: "permission_denied",
      path,
      message,
    });
  }

  if (normalized.includes("no such file") || normalized.includes("os error 2")) {
    return createFileSystemError({
      code: "not_found",
      path,
      message,
    });
  }

  return createFileSystemError({
    code: "io_error",
    path,
    message,
  });
}
