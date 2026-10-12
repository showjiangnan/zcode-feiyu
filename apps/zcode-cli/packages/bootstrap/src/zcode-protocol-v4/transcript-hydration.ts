// Modified by ZCode Feiyu.
// 按重建/准入职责拆分；事件顺序、状态所有权及原公开导出保持不变。

export type { HydratedGoalVerificationEntry } from "./transcript-hydration-subagent-tool-names.js";
export { goalVerificationEntriesFromSessionEntries } from "./transcript-hydration-push-goal-verification-fact.js";
export { synthesizeEventsFromMessages } from "./transcript-hydration-synthesize-events-from-messages.js";
export { eventsCoverTranscript } from "./transcript-hydration-transcript-footprint.js";
