// Modified by ZCode Feiyu contributors (2026).
import {
  isTaskRoot,
  selectActiveConversationBranch,
  type ProjectMemoryReviewClaim,
  type MessageWithParts,
} from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
const REVIEW_MAX_HISTORY_BYTES = 6_000;
const REVIEW_MAX_SESSION_BYTES = 1_500;
const REVIEW_MAX_HISTORY_MESSAGES = 16;
const REVIEW_MAX_MESSAGE_CHARS = 1_000;
export async function collectVisibleHistory(
  store: NonNullable<AgentRuntimeInternal["sessionStore"]>,
  claim: Extract<ProjectMemoryReviewClaim, { status: "claimed" }>,
  signal: AbortSignal,
  historyScope: "workspace" | "current_session" | "none",
): Promise<{ text: string; sessionCount: number }> {
  let remaining = REVIEW_MAX_HISTORY_BYTES;
  const excerpts: string[] = [];
  const encoder = new TextEncoder();
  for (const sessionId of historyScope === "none" ? [] : claim.sessionIds) {
    signal.throwIfAborted();
    const separatorBytes = excerpts.length > 0 ? 1 : 0;
    if (remaining <= separatorBytes) break;
    const session = await store.getSession(sessionId);
    // parentID 不能排除独立 fork；真正 child 先拒绝再读正文，workspace 保留原 side-chat 范围。
    if (
      !session ||
      !(
        isTaskRoot(session.taskType, session.parentID) ||
        (historyScope === "workspace" && session.taskType === "selection_side_chat")
      )
    )
      continue;
    const messages = await store.messages({ sessionID: sessionId });
    // append-only 消息含已撤回分支；只筛选角色会泄露隐藏旧分支，必须复用会话的活动分支投影。
    const active = selectActiveConversationBranch(messages, {
      branchCutAfterMessageId: session.revert?.branchCutAfterMessageID,
      rewindCreatedMessageId: session.revert?.createdMessageID,
      rewindKeptMessageIds: session.revert?.keptMessageIDs,
      rewindTargetMessageId: session.revert?.targetMessageID,
    });
    const lines = active.slice(-REVIEW_MAX_HISTORY_MESSAGES).flatMap(visibleMessageLines);
    if (lines.length === 0) continue;
    const budget = Math.min(remaining - separatorBytes, REVIEW_MAX_SESSION_BYTES);
    const characters = Array.from(lines.join("\n"));
    let low = 0,
      high = characters.length;
    // 按完整 JSON 和 Unicode 码点收紧摘录；直接切字节会破坏来源边界，甚至把只有 ID 的残片计为会话。
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const block = JSON.stringify({
        sessionId,
        lines: characters.slice(0, middle).join("").split("\n"),
      });
      if (encoder.encode(block).length <= budget) low = middle;
      else high = middle - 1;
    }
    if (low <= lines[0]!.indexOf(": ") + 2) break;
    const bounded = JSON.stringify({
      sessionId,
      lines: characters.slice(0, low).join("").split("\n"),
    });
    excerpts.push(bounded);
    remaining -= encoder.encode(bounded).length + separatorBytes;
  }
  return { text: excerpts.join("\n"), sessionCount: excerpts.length };
}

function visibleMessageLines(message: MessageWithParts): string[] {
  if (message.info.role !== "user" && message.info.role !== "assistant") return [];
  if (
    message.info.role === "user" &&
    (message.info.visibility === "model-only" || message.info.synthetic === true)
  )
    return [];
  return message.parts.flatMap((part) =>
    part.type === "text" &&
    part.ignored !== true &&
    part.synthetic !== true &&
    part.text.trim().length > 0
      ? [
          `${message.info.role}: ${Array.from(part.text.trim()).slice(0, REVIEW_MAX_MESSAGE_CHARS).join("")}`,
        ]
      : [],
  );
}
