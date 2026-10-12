// Modified by ZCode Feiyu.
import type {
  MessageId,
  Model,
  ModelSelection,
  QueryId,
  SessionEvent,
  SessionGoal,
  TraceContext,
  TurnId,
  TurnState,
  TurnMachineImpl,
} from "../deps.js";
import type { ActiveTurnSteeringState, AgentRuntimeConfig, ExecuteTurnOptions } from "../types.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import type { parseRewindCommand, parseCompactCommand } from "../helpers/index.js";
import type { recallProjectMemoryTopicSet } from "../../memory/recall/relevant.js";
export interface TurnExecutionState {
  turnMachine: TurnMachineImpl;
  activeTurn?: ActiveTurnSteeringState;
  startedTarget: SessionGoal | null;
  targetRunHeartbeat?: ReturnType<typeof setInterval>;
  userMessageId?: MessageId;
  loopState?: RegularTurnLoopState;
  shouldRetryTitleGenerationAfterTurn: boolean;
  turnPhase: string;
  turnFailureHandled: boolean;
}
export interface TurnExecutionContext {
  input: string;
  attachments: TurnState["attachments"] | undefined;
  options: ExecuteTurnOptions | undefined;
  admittedModelSelection: ModelSelection | undefined;
  admittedOutputStyle: AgentRuntimeConfig["outputStyle"];
  compactInstructions: ReturnType<typeof parseCompactCommand>;
  rewindCommand: ReturnType<typeof parseRewindCommand>;
  turnId: TurnId;
  queryId: QueryId;
  displayInput: string;
  turnTraceContext: TraceContext;
  traceId: TraceContext["traceId"];
  turnStartedAtMs: number;
  targetRunInputID: string;
  events: SessionEvent[];
  turnAbortSignal: AbortSignal;
  startTurnPhase: (phase: string) => number;
  completeTurnPhase: (phase: string, startedAt: number) => void;
  state: TurnExecutionState;
}
export interface ActiveTurnExecutionContext extends TurnExecutionContext {
  activeTurn: ActiveTurnSteeringState;
  userMessageId: MessageId;
}
export interface RegularTurnExecutionContext extends ActiveTurnExecutionContext {
  admittedModel: Model | undefined;
  submissionModel: Model | undefined;
  turnMemoryRecall: Awaited<ReturnType<typeof recallProjectMemoryTopicSet>> | undefined;
}
