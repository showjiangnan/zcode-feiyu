// Modified by ZCode Feiyu contributors (2026).
// ============================================================
// Read File State Helpers
// ============================================================

import { platform as currentPlatform } from "node:process";
import { normalizeToolPathForComparison } from "./path-normalization.js";
import type { ReadFileStateEntry, ReadFileStateMap } from "./types.js";

type ReadFileStatePlatform = NodeJS.Platform;

function createReadFileStatePathKey(
  filePath: string,
  platform: ReadFileStatePlatform = currentPlatform,
): string {
  return normalizeToolPathForComparison(filePath, platform);
}

export function createReadFileStateKey(
  filePath: string,
  offset: number | undefined,
  limit: number | undefined,
  platform: ReadFileStatePlatform = currentPlatform,
): string {
  return [
    createReadFileStatePathKey(filePath, platform),
    String(offset ?? 1),
    limit === undefined ? "" : String(limit),
  ].join("\0");
}

export function findEditableReadFileState(
  readFileState: ReadFileStateMap | undefined,
  filePath: string,
  platform: ReadFileStatePlatform = currentPlatform,
): ReadFileStateEntry | undefined {
  return findLatestReadFileState(readFileState, filePath, platform);
}

export function findLatestReadFileState(
  readFileState: ReadFileStateMap | undefined,
  filePath: string,
  platform: ReadFileStatePlatform = currentPlatform,
): ReadFileStateEntry | undefined {
  if (!readFileState) return undefined;

  // 优先返回 full Read 会让 Bash/formatter 改完文件后即使模型按提示重新
  // range Read，Edit/Write 仍拿旧 full Read 做 mtime 校验并持续误报 stale。这里按
  // 单文件最新 read-state 语义选择基准；真正的 partial view 由消费者单独拒绝。
  return findLatestReadFileStateByPath(readFileState, filePath, platform, () => true);
}

/**
 * 读取状态里完整记录的内容是否与当前内容不同。
 *
 * 修复原因：Write/Edit 的陈旧检测在 mtime 与 size 都未变化时直接判定未改动；外部编辑写入同尺寸内容并恢复 mtime，
 * 随后隐式重读得到的新修订又会通过底层 CAS，旧上下文生成的替换因此覆盖已可见的外部改动（复审 DEF-13）。
 * 依据：CONT-FR-05 要求对写前可见的改动按修订与内容拒绝旧写。仅在记录内容确认完整时比较；
 * 换行统一后再比，读取路径对 CRLF 的规范化方式不同不能造成误报。
 */
export function completeReadContentDiffers(
  lastRead: ReadFileStateEntry,
  currentContent: string,
): boolean {
  if (lastRead.complete !== true || lastRead.isPartialView) return false;
  return normalizeLineEndings(lastRead.content) !== normalizeLineEndings(currentContent);
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

export function normalizeReadFileStateMtimeMs(mtimeMs: number | undefined): number | undefined {
  if (mtimeMs === undefined) return undefined;
  return Math.floor(mtimeMs);
}

function findLatestReadFileStateByPath(
  readFileState: ReadFileStateMap,
  filePath: string,
  platform: ReadFileStatePlatform,
  accepts: (entry: ReadFileStateEntry) => boolean,
): ReadFileStateEntry | undefined {
  const pathKey = createReadFileStatePathKey(filePath, platform);
  let latest: ReadFileStateEntry | undefined;
  let latestReadAt = Number.NEGATIVE_INFINITY;
  for (const entry of readFileState.values()) {
    if (createReadFileStatePathKey(entry.path, platform) !== pathKey) continue;
    if (!accepts(entry)) continue;
    const readAt = entry.readAt.getTime();
    if (readAt < latestReadAt) continue;
    latest = entry;
    latestReadAt = readAt;
  }
  return latest;
}
