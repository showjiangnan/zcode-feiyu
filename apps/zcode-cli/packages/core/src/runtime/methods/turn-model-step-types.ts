// Modified by ZCode Feiyu.
import type { MessageId, ModelToolContract } from "../deps.js";
import { type RuntimeMessageEntry } from "../../agent/message-history.js";

import type { DrainedPendingInputDiagnostics, RunModelTextRequestOptions } from "../types.js";

import { captureAssistantPersistenceAnchor } from "./turn-stop.js";
import { createStreamingToolCoordinator } from "./streaming-tool-coordinator.js";

import { querySourceForTask } from "./turn-model-step-usage.js";

import type { Model, ModelSelection, TraceContext } from "../deps.js";
export type ModelStepOptions = {
  drainedSteerForNextRequest?: DrainedPendingInputDiagnostics;
  latestRealUserMessageIndex?: number;
  messages: RunModelTextRequestOptions["messages"];
  sourceEntries: readonly (RuntimeMessageEntry | undefined)[];
  recordedMessages: RunModelTextRequestOptions["messages"];
  requestEntries: readonly RuntimeMessageEntry[];
  tools: ModelToolContract[];
};
export interface ModelStepContext {
  model: Model;
  modelStepIndex: number;
  modelStartedAt: number;
  assistantCreatedAt: number;
  assistantMessageId: MessageId;
  assistantPersistenceAnchor: ReturnType<typeof captureAssistantPersistenceAnchor>;
  querySource: ReturnType<typeof querySourceForTask>;
  executionModelSelection: Pick<ModelSelection, "providerId" | "modelId">;
  executionContextWindow: Model["properties"]["contextWindow"];
  modelTraceContext: TraceContext;
  networkEventStartIndex: number;
  streamingToolCoordinator: ReturnType<typeof createStreamingToolCoordinator>;
}
export type ModelStepResult = "continue" | "output_continuation" | "break";
