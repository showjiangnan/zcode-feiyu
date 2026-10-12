// Modified by ZCode Feiyu.
// 按重建/准入职责拆分；事件顺序、状态所有权及原公开导出保持不变。

export type { CanonicalConversationVisibility } from "./event-normalizer-canonical-conversation-visibility.js";
export type { CanonicalConversationOrigin } from "./event-normalizer-canonical-conversation-visibility.js";
export type { CanonicalConversationPlacement } from "./event-normalizer-canonical-conversation-visibility.js";
export type { ConversationNormalizationDiagnostic } from "./event-normalizer-canonical-conversation-visibility.js";
export type { CanonicalUserIntentFact } from "./event-normalizer-canonical-conversation-visibility.js";
export type { CanonicalTurnAttachment } from "./event-normalizer-canonical-conversation-visibility.js";
export type { CanonicalModelStream } from "./event-normalizer-canonical-conversation-visibility.js";
export type { CanonicalAssistantSegmentFact } from "./event-normalizer-canonical-conversation-visibility.js";
export type { CanonicalPassthroughFact } from "./event-normalizer-canonical-conversation-visibility.js";
export type { CanonicalConversationFact } from "./event-normalizer-canonical-conversation-visibility.js";
export type { NormalizeConversationEventContext } from "./event-normalizer-canonical-conversation-visibility.js";
export type { CanonicalOpenSegmentIdentity } from "./event-normalizer-canonical-conversation-visibility.js";
export { normalizeConversationEvent } from "./event-normalizer-normalize-conversation-event.js";
