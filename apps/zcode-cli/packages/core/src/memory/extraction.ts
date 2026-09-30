// Modified by ZCode Feiyu contributors (2026).
import type { MessageId, MessageWithParts, ToolPart } from "@zcode/contracts";
import { resolveContainedMemoryFilePath } from "./memory-file-path.js";
import { formatMemoryManifest } from "./recall/manifest.js";
import type { MemoryManifestEntry } from "./recall/types.js";

const MINIMUM_USER_WORDS = 3;
const MINIMUM_UNSPACED_SCRIPT_CHARS = 6;
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

type MemoryExtractionExecutionStatus = "success" | "no-op" | "error" | "aborted";

export interface MemoryExtractionSnapshot {
  boundaryMessageId: MessageId;
  durableMessages: readonly MessageWithParts[];
  memoryRoot: string;
  workingDirectory: string;
  workspaceRoot: string;
}

type MemoryExtractionDecision =
  | { decision: "run"; messageCount: number }
  | {
      decision: "skip";
      messageCount: number;
      reason: "direct-memory-write" | "no-user-prose";
    };

interface MemoryExtractionExecutionInput {
  abortSignal: AbortSignal;
  messageCount: number;
  snapshot: MemoryExtractionSnapshot;
}

export interface MemoryExtractionScheduler<
  TSnapshot extends MemoryExtractionSnapshot = MemoryExtractionSnapshot,
> {
  /**
   * 取消**当前这一轮**运行（复审 GAP-03 的抽屉停止入口）。
   *
   * 与 `shutdown()` 的边界差别：shutdown 关闭整个调度器（不再接受新快照），这里只中止在跑的那一轮，
   * 它的结算路径与 shutdown 相同——执行端看到 aborted、游标不推进、后续提取照常进行。
   * 没有在跑的运行返回 false，调用方据此如实回「没有取消任何东西」，不假装成功。
   */
  cancelCurrent(reason?: unknown): boolean;
  drain(): Promise<void>;
  getCursor(): MessageId | undefined;
  hasPendingWork(): boolean;
  schedule(snapshot: TSnapshot | Promise<TSnapshot>): void;
  shutdown(): void;
}

export function buildMemoryExtractionPrompt(input: {
  manifest: readonly MemoryManifestEntry[];
  messageCount: number;
}): string {
  const existingMemories =
    input.manifest.length > 0
      ? `\n\n## Existing memory files\n\n${formatMemoryManifest(input.manifest)}\n\nCheck this list before writing \u2014 update an existing file rather than creating a duplicate.`
      : "";

  return [
    `You are now acting as the memory extraction subagent. Analyze the most recent ~${input.messageCount} messages above and use them to update your persistent memory systems.`,
    "",
    "Available tools: Read and Edit/Write for Markdown paths inside the memory directory, plus Grep/Glob only when their path explicitly points inside that directory. All other tools, including Bash, MCP, Agent and network tools, will be denied. To forget an entry, edit the existing Markdown file instead of deleting it with a shell command.",
    "",
    "Finish the extraction when the durable facts have been checked and saved. Edit requires a prior Read of the same file, so first read the files you may update, then issue Write/Edit calls. Memory writes are serialized by the runtime; re-read a file after a revision conflict before retrying.",
    "",
    `You MUST only use content from the last ~${input.messageCount} messages to update your persistent memories. Do not waste any turns attempting to investigate or verify that content further \u2014 no grepping source files, no reading code to confirm a pattern exists, no git commands.${existingMemories}`,
    "",
    "If nothing is worth saving, output only 'Nothing to save.' Do not explain why.",
    "",
    "If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.",
    "",
    "Apply the memory types, what-not-to-save criteria, and frontmatter format from the Memory section of your system prompt \u2014 it is already in your context above.",
  ].join("\n");
}

function evaluateMemoryExtraction(
  snapshot: MemoryExtractionSnapshot,
  cursor: MessageId | undefined,
): MemoryExtractionDecision {
  const messageCount = countMessagesAfterCursor(snapshot.durableMessages, cursor);

  if (containsDirectMemoryWrite(snapshot, cursor)) {
    return { decision: "skip", messageCount, reason: "direct-memory-write" };
  }

  if (!containsEligibleUserProse(snapshot.durableMessages, cursor)) {
    return { decision: "skip", messageCount, reason: "no-user-prose" };
  }

  return { decision: "run", messageCount };
}

export function createMemoryExtractionScheduler<
  TSnapshot extends MemoryExtractionSnapshot = MemoryExtractionSnapshot,
>(
  execute: (
    input: Omit<MemoryExtractionExecutionInput, "snapshot"> & { snapshot: TSnapshot },
  ) => Promise<MemoryExtractionExecutionStatus>,
  persistence?: {
    loadCursor: () => Promise<MessageId | undefined>;
    advanceCursor: (
      expectedCursor: MessageId | undefined,
      nextCursor: MessageId,
    ) => Promise<boolean>;
  },
): MemoryExtractionScheduler<TSnapshot> {
  let cursor: MessageId | undefined;
  let cursorLoad: Promise<void> | undefined;
  let latestPending: Promise<SnapshotAcquisition<TSnapshot>> | undefined;
  let running: Promise<void> | undefined;
  let shuttingDown = false;
  // 当前这一轮运行的中止目标（见 cancelCurrent）；同一时刻至多一轮在跑。
  let currentRunAbort: AbortController | undefined;
  const shutdownController = new AbortController();

  const ensureCursorLoaded = async (): Promise<void> => {
    if (!persistence) return;
    // 原因：原实现把 loadCursor 的 Promise 永久缓存在 cursorLoad，加载失败后该 rejected
    // Promise 会被后续每次提取复用，游标再也读不出来，提取从此永久失败。失败必须清空缓存，
    // 让下一次提取重新加载（该次失败仍向上抛出，不推进游标）。
    cursorLoad ??= persistence.loadCursor().then(
      (stored) => {
        cursor = stored;
      },
      (error: unknown) => {
        cursorLoad = undefined;
        throw error;
      },
    );
    await cursorLoad;
  };
  const advanceCursor = async (nextCursor: MessageId): Promise<void> => {
    if (persistence && !(await persistence.advanceCursor(cursor, nextCursor))) {
      shuttingDown = true;
      latestPending = undefined;
      shutdownController.abort();
      return;
    }
    cursor = nextCursor;
  };

  const processSnapshot = async (snapshot: TSnapshot): Promise<void> => {
    await ensureCursorLoaded();
    const decision = evaluateMemoryExtraction(snapshot, cursor);
    const snapshotEnd = snapshot.boundaryMessageId;

    if (decision.decision === "skip") {
      if (snapshotEnd) await advanceCursor(snapshotEnd);
      return;
    }

    let status: MemoryExtractionExecutionStatus;
    // 运行作用域的中止目标：抽屉的停止入口只取消这一轮，不关闭调度器（见 cancelCurrent）。
    // 与 shutdownController 组合而非替换——会话关闭的中止语义完全不变。
    const runController = new AbortController();
    currentRunAbort = runController;
    try {
      status = await execute({
        abortSignal: AbortSignal.any([shutdownController.signal, runController.signal]),
        messageCount: decision.messageCount,
        snapshot,
      });
    } catch {
      return;
    } finally {
      if (currentRunAbort === runController) currentRunAbort = undefined;
    }

    if (!shuttingDown && (status === "success" || status === "no-op") && snapshotEnd) {
      await advanceCursor(snapshotEnd);
    }
  };

  const run = async (first: Promise<SnapshotAcquisition<TSnapshot>>): Promise<void> => {
    try {
      let current: Promise<SnapshotAcquisition<TSnapshot>> | undefined = first;
      while (current && !shuttingDown) {
        const acquisition = await waitForSnapshotAcquisitionOrShutdown(
          current,
          shutdownController.signal,
        );
        if (acquisition.status === "shutdown" || shuttingDown) break;
        if (acquisition.status === "acquired") {
          try {
            await processSnapshot(acquisition.snapshot);
          } catch {
            // 本次 error 不推进 cursor；latest pending 仍按既有 coalescing 语义继续。
          }
        }
        current = shuttingDown ? undefined : latestPending;
        latestPending = undefined;
      }
    } finally {
      if (shuttingDown) latestPending = undefined;
      running = undefined;
    }
  };

  return {
    async drain() {
      while (running) {
        await running;
      }
    },
    cancelCurrent(reason) {
      const controller = currentRunAbort;
      if (!controller || controller.signal.aborted) return false;
      controller.abort(reason);
      return true;
    },
    getCursor() {
      return cursor;
    },
    hasPendingWork() {
      return running !== undefined || latestPending !== undefined;
    },
    schedule(snapshot) {
      if (shuttingDown) return;
      const acquisition = acquireSnapshot(snapshot);
      if (running) {
        latestPending = acquisition;
        return;
      }

      running = run(acquisition);
    },
    shutdown() {
      if (shuttingDown) return;
      // ZCode 关闭单个 session 后进程仍继续运行；旧 scheduler 只让调用方
      // 放弃等待，running/pending Extraction 仍可能继续请求模型和写 Memory。
      shuttingDown = true;
      latestPending = undefined;
      shutdownController.abort();
    },
  };
}

type SnapshotAcquisition<TSnapshot> =
  | { status: "acquired"; snapshot: TSnapshot }
  | { status: "error" };

type SnapshotAcquisitionWait<TSnapshot> = SnapshotAcquisition<TSnapshot> | { status: "shutdown" };

function acquireSnapshot<TSnapshot>(
  snapshot: TSnapshot | Promise<TSnapshot>,
): Promise<SnapshotAcquisition<TSnapshot>> {
  return Promise.resolve(snapshot).then(
    (value) => ({ status: "acquired", snapshot: value }),
    () => ({ status: "error" }),
  );
}

function waitForSnapshotAcquisitionOrShutdown<TSnapshot>(
  acquisition: Promise<SnapshotAcquisition<TSnapshot>>,
  signal: AbortSignal,
): Promise<SnapshotAcquisitionWait<TSnapshot>> {
  if (signal.aborted) return Promise.resolve({ status: "shutdown" });

  return new Promise((resolve) => {
    const onAbort = (): void => {
      cleanup();
      resolve({ status: "shutdown" });
    };
    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
    };

    signal.addEventListener("abort", onAbort, { once: true });
    void acquisition.then((result) => {
      cleanup();
      resolve(result);
    });
  });
}

function countMessagesAfterCursor(
  messages: readonly MessageWithParts[],
  cursor: MessageId | undefined,
): number {
  if (!cursor) return messages.length;
  const cursorIndex = messages.findIndex((message) => message.info.id === cursor);
  return cursorIndex < 0 ? messages.length : messages.length - cursorIndex - 1;
}

function containsDirectMemoryWrite(
  snapshot: MemoryExtractionSnapshot,
  cursor: MessageId | undefined,
): boolean {
  const messages = messagesAfterFoundCursor(snapshot.durableMessages, cursor);
  if (!messages) return false;

  for (const message of messages) {
    if (message.info.role !== "assistant") continue;
    for (const part of message.parts) {
      if (!isMemoryMutationToolPart(part)) continue;
      const filePath = part.state.input.file_path;
      if (typeof filePath !== "string" || filePath.length === 0) continue;
      if (
        resolveContainedMemoryFilePath({
          filePath,
          rootDir: snapshot.memoryRoot,
          workingDirectory: snapshot.workingDirectory,
          workspaceRoot: snapshot.workspaceRoot,
        })
      ) {
        return true;
      }
    }
  }

  return false;
}

function containsEligibleUserProse(
  messages: readonly MessageWithParts[],
  cursor: MessageId | undefined,
): boolean {
  const messagesAfterCursor = messagesAfterFoundCursor(messages, cursor) ?? messages;
  for (const message of messagesAfterCursor) {
    if (!isNonMetaUserMessage(message)) continue;
    for (const part of message.parts) {
      if (
        part.type === "text" &&
        part.ignored !== true &&
        part.synthetic !== true &&
        hasMeaningfulUserProse(part.text)
      ) {
        return true;
      }
    }
  }
  return false;
}

function messagesAfterFoundCursor(
  messages: readonly MessageWithParts[],
  cursor: MessageId | undefined,
): readonly MessageWithParts[] | undefined {
  if (!cursor) return messages;
  const cursorIndex = messages.findIndex((message) => message.info.id === cursor);
  return cursorIndex < 0 ? undefined : messages.slice(cursorIndex + 1);
}

function isNonMetaUserMessage(message: MessageWithParts): boolean {
  return (
    message.info.role === "user" &&
    message.info.synthetic !== true &&
    message.info.visibility !== "model-only"
  );
}

function isMemoryMutationToolPart(part: MessageWithParts["parts"][number]): part is ToolPart {
  // 修复原因：失败的 Write/Edit 也被当作“主线程已保存记忆”，提取被跳过且游标被推进，这段内容永远不会再被提取（复审 DEF-24）。
  // 依据：CONT-FR-03 要求失败不丢内容；只有已成功完成的写入才说明记忆已经保存。
  return (
    part.type === "tool" &&
    (part.tool === "Write" || part.tool === "Edit") &&
    part.state.status === "completed"
  );
}

function hasMeaningfulUserProse(text: string): boolean {
  let wordCount = 0;
  for (const segment of wordSegmenter.segment(text)) {
    if (segment.isWordLike && ++wordCount >= MINIMUM_USER_WORDS) return true;
  }
  // 原先仅按空白拆词，连续中文会被当成一个词而丢弃；字形数兜住无空格文字。
  const unspacedChars = text.match(
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu,
  );
  return (unspacedChars?.length ?? 0) >= MINIMUM_UNSPACED_SCRIPT_CHARS;
}
