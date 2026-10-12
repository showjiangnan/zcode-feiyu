// Modified by ZCode Feiyu.
import type { AgentRuntimeInternal } from "../internal.js";
import type {
  CompactPhase,
  CompactReason,
  CompactTrigger,
  Model,
  ModelToolContract,
  SessionEvent,
  TraceContext,
} from "../deps.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import type { CompactTimelineContext } from "../types.js";
import type { selectInitialCompactEntriesForActiveConversation } from "./compact-active-selection.js";
import type { getRuntimeEntriesToSummarize } from "../helpers/index.js";
export type CompactActiveOptions = NonNullable<
  Parameters<AgentRuntimeInternal["compactActiveConversation"]>[3]
>;
export type CompactActiveResult = Awaited<
  ReturnType<AgentRuntimeInternal["compactActiveConversation"]>
>;
export interface CompactSelectionState {
  currentSelection: ReturnType<typeof selectInitialCompactEntriesForActiveConversation>;
  preservedEntries: readonly RuntimeMessageEntry[];
  entriesForSummary: readonly RuntimeMessageEntry[];
  entriesToSummarize: ReturnType<typeof getRuntimeEntriesToSummarize>;
}
export interface CompactAttemptContext {
  activeEntries: readonly RuntimeMessageEntry[];
  attempt: number;
  compactModel: Model;
  compactPrompt: string;
  compactTimeline: CompactTimelineContext;
  compactTools: ModelToolContract[];
  events: SessionEvent[];
  modelTraceContext: TraceContext;
  options: CompactActiveOptions;
  preCompactTokenCount: number;
  selectionState: CompactSelectionState;
  trigger: CompactTrigger;
  useMidConversationSystem: boolean;
}
export interface CompactCommitContext extends Omit<
  CompactAttemptContext,
  "compactPrompt" | "compactTools"
> {
  compactReason: CompactReason;
  customInstructions: string | undefined;
  lastSummarizedMessageId: AgentRuntimeInternal["latestConversationMessageId"];
  maxAttempts: number;
  phase: CompactPhase;
  turnTraceContext: TraceContext;
}
