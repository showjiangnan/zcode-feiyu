// Modified by ZCode Feiyu.
// 按重建/准入职责拆分；事件顺序、状态所有权及原公开导出保持不变。

export type { ConversationMaterializationSource } from "./cold-event-merge-conversation-materialization-source.js";
export { loadPersistedConversationMaterialization } from "./cold-event-merge-conversation-materialization-source.js";
export type { ColdEventMergeDiagnostic } from "./cold-event-merge-conversation-materialization-source.js";
export type { ColdEventMergeResult } from "./cold-event-merge-conversation-materialization-source.js";
export { mergeColdConversationEvents } from "./cold-event-merge-merge-cold-conversation-events.js";
