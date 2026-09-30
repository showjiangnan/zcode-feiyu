// Modified by ZCode Feiyu contributors (2026).
import { basename, relative } from "node:path";
import type { FileSystemPort } from "@zcode/contracts";
import { assertMemoryToolPathSafe } from "../tool-path-guard.js";

const MAX_CANDIDATES = 100;
const MAX_DEPTH = 4;
const MAX_SELECTED = 3;
const MAX_TOPIC_CHARS = 3_500;
const MAX_TOTAL_CHARS = 12_000;
/** 回合内后续模型请求的默认注入口径：比回合起点更克制，避免每次工具往返都灌入大段记忆。 */
export const MID_TURN_RECALL_MAX_SELECTED = 1;
export const MID_TURN_RECALL_MAX_TOPIC_CHARS = 1_200;
export const MID_TURN_RECALL_MAX_TOTAL_CHARS = 1_800;
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

interface TopicCandidate {
  path: string;
  label: string;
  score: number;
}

export interface RecalledMemoryTopics {
  /** 可直接并入 prompt 的正文；未命中主题时为空串。 */
  content: string;
  /** 本次实际注入的主题相对路径；调用方据此在后续模型请求里去重（GAP-01）。 */
  topics: string[];
  /** 本次遍历到的候选路径；同一回合内复用可省掉每个模型步骤的重复目录遍历。 */
  discoveredPaths: readonly string[];
}

export interface RecallProjectMemoryOptions {
  fileSystem: FileSystemPort;
  query: string;
  rootDir: string;
  signal?: AbortSignal;
  /** 单次注入的主题条数上限。 */
  maxSelected?: number;
  /** 单条主题正文的字符上限。 */
  maxTopicChars?: number;
  /** 单次注入的相关主题正文合计字符上限。 */
  maxTotalChars?: number;
  /** 已知候选路径；同一回合的后续步骤复用，避免重走目录。 */
  discoveredPaths?: readonly string[];
  /** 已注入过的主题相对路径，不再重复返回。 */
  exclude?: ReadonlySet<string>;
}

export async function recallProjectMemoryTopics(input: {
  fileSystem: FileSystemPort;
  query: string;
  rootDir: string;
  signal?: AbortSignal;
}): Promise<string> {
  return (await recallProjectMemoryTopicSet(input)).content;
}

/**
 * 检索相关记忆主题并返回结构化结果。
 *
 * 修复原因（复审 GAP-01）：召回此前只在回合起点执行一次，回合内后续模型请求看不到
 * 新出现的相关主题。回合内的每次请求需要重新检索、并跳过已注入的主题。
 * 依据：CONT-FR-04 要求相关记忆随工作推进保持可用；去重与上限保证提示前缀稳定、成本可控。
 */
export async function recallProjectMemoryTopicSet(
  input: RecallProjectMemoryOptions,
): Promise<RecalledMemoryTopics> {
  const maxSelected = input.maxSelected ?? MAX_SELECTED;
  const maxTopicChars = input.maxTopicChars ?? MAX_TOPIC_CHARS;
  const maxTotalChars = input.maxTotalChars ?? MAX_TOTAL_CHARS;
  const discoveredPaths: readonly string[] =
    input.discoveredPaths ??
    (await collectTopicPaths(input.fileSystem, input.rootDir, input.signal));
  const terms = [
    ...new Set(
      [...wordSegmenter.segment(input.query.toLocaleLowerCase())]
        .filter((segment) => segment.isWordLike && segment.segment.length >= 2)
        .map((segment) => segment.segment),
    ),
  ].slice(0, 24);
  if (terms.length === 0 || maxSelected <= 0 || maxTotalChars <= 0)
    return { content: "", topics: [], discoveredPaths };

  const results = await Promise.allSettled(
    discoveredPaths.map(async (path): Promise<TopicCandidate> => {
      await assertMemoryToolPathSafe({
        rootDir: input.rootDir,
        toolCall: { name: "Read", input: { file_path: path } },
        workingDirectory: input.rootDir,
        workspaceRoot: input.rootDir,
      });
      const label = relative(input.rootDir, path).replaceAll("\\", "/");
      const preview = (
        await input.fileSystem.readTextFileRange(
          { path, offsetLine: 0, limitLines: 24 },
          { signal: input.signal },
        )
      ).content.slice(0, 2_000);
      const pathText = label.toLocaleLowerCase();
      const previewText = preview.toLocaleLowerCase();
      const score = terms.reduce(
        (total, term) =>
          total + (pathText.includes(term) ? 4 : 0) + (previewText.includes(term) ? 1 : 0),
        0,
      );
      return { path, label, score };
    }),
  );
  const excluded = input.exclude;
  const selected = results
    .filter(
      (result): result is PromiseFulfilledResult<TopicCandidate> => result.status === "fulfilled",
    )
    .map((result) => result.value)
    .filter((candidate) => candidate.score > 0 && !excluded?.has(candidate.label))
    .sort((left, right) => right.score - left.score || left.label.localeCompare(right.label))
    .slice(0, maxSelected);

  const sections: string[] = [];
  const topics: string[] = [];
  let usedChars = 0;
  for (const candidate of selected) {
    input.signal?.throwIfAborted();
    try {
      await assertMemoryToolPathSafe({
        rootDir: input.rootDir,
        toolCall: { name: "Read", input: { file_path: candidate.path } },
        workingDirectory: input.rootDir,
        workspaceRoot: input.rootDir,
      });
      const [read, stat] = await Promise.all([
        input.fileSystem.readTextFileRange(
          { path: candidate.path, offsetLine: 0, limitLines: 160 },
          { signal: input.signal },
        ),
        input.fileSystem.stat({ path: candidate.path }, { signal: input.signal }),
      ]);
      if (stat.kind !== "file") continue;
      const content = read.content.slice(0, maxTopicChars).trim();
      if (!content) continue;
      const revision = read.revision?.id ?? "unknown";
      const header = `## ${candidate.label} (source: ${candidate.path}; revision: ${revision}; updated: ${new Date(stat.mtimeMs ?? 0).toISOString()})`;
      const remaining = maxTotalChars - usedChars - header.length - 3;
      if (remaining <= 0) break;
      const section = `${header}\n${content.slice(0, remaining)}`;
      sections.push(section);
      topics.push(candidate.label);
      usedChars += section.length + 2;
    } catch {
      // 单条记忆损坏或在读取期间删除，不应阻断当前用户轮次。
    }
  }
  return {
    content:
      sections.length > 0
        ? `# Relevant project memory topics\n\n${sections.join("\n\n")}`.slice(0, maxTotalChars)
        : "",
    topics,
    discoveredPaths,
  };
}

async function collectTopicPaths(
  fileSystem: FileSystemPort,
  rootDir: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const paths: string[] = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || paths.length >= MAX_CANDIDATES) return;
    await assertMemoryToolPathSafe({
      rootDir,
      toolCall: { name: "Glob", input: { path: directory } },
      workingDirectory: rootDir,
      workspaceRoot: rootDir,
    });
    const listed = await fileSystem.listDirectory({ path: directory }, { signal });
    for (const entry of listed.entries) {
      if (paths.length >= MAX_CANDIDATES) break;
      const label = relative(rootDir, entry.path);
      if (!label || label === ".." || label.startsWith("../") || label.startsWith("..\\")) continue;
      if (entry.kind === "directory") {
        await visit(entry.path, depth + 1);
      } else if (
        entry.kind === "file" &&
        entry.path.endsWith(".md") &&
        basename(entry.path) !== "MEMORY.md"
      ) {
        paths.push(entry.path);
      }
    }
  };
  try {
    await visit(rootDir, 0);
  } catch {
    return paths;
  }
  return paths;
}
