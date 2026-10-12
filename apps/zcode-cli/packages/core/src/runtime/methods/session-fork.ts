// Modified by ZCode Feiyu.
// 按职责拆分实现，公开入口保持不变；所有状态仍归同一个 runtime 所有。
export { type ForkIdentityMap, createForkIdentityMap } from "./session-fork-identity.js";
export { buildAtomicForkNotice } from "./session-fork-notice.js";
export {
  createSelectionSideConversation,
  selectionSideChatHistoryMessages,
  createForkedSession,
  forkConversationFromMessage,
  forkStableConversationAtMessage,
  forkConversationBeforeMessage,
} from "./session-fork-creation.js";
export {
  conversationHistoryBeforeInput,
  stableForkHistoryMessages,
  forkSourceMessagesForSession,
  activeForkTranscriptMessages,
  resolveForkHistoryEndIndex,
  buildForkHistoryMessages,
} from "./session-fork-history.js";
export {
  copyGoalStateForFork,
  deriveForkedGoalStatusFromCopiedVerifications,
} from "./session-fork-goals.js";
