// Modified by ZCode Feiyu.
import type { Logger, ModelStatusSink, ModelStreamEvent } from "@zcode/contracts";
import { type ModelRetryBudget } from "@zcode/contracts";
import type { TextStreamPart, ToolSet } from "ai";
import { AccountRequestRetry } from "./account-request-retry.js";

import type { EnvRecord } from "./model-execution.js";

import { type AttemptAdmission } from "./request-admission.js";

import type { ResolvedAiSdkModelRetryOptions } from "./retry-policy.js";

import { createStreamDiagnostics } from "./runner-diagnostics.js";

import { createStreamTextOptions } from "./runner-options.js";

import type {
  AiSdkModelRuntime,
  AiSdkModelTextRequest,
  AiSdkStreamTextResult,
  ResolvedAiSdkModel,
} from "./runner-runtime.js";
import { createAttemptStatusContext } from "./runner-status.js";

import { createLinkedAbortController } from "./stream-idle-timeout.js";

import { StreamingToolCallAssembler } from "./streaming-tool-call-assembler.js";

export type RunStreamTextInput = {
  debugDir?: string;
  env: EnvRecord;
  logger?: Logger;
  request: AiSdkModelTextRequest;
  resolveModel: () => ResolvedAiSdkModel;
  resolved: ResolvedAiSdkModel;
  retry: ResolvedAiSdkModelRetryOptions;
  runtime: AiSdkModelRuntime;
  statusSink?: ModelStatusSink;
  streamIdleTimeoutMs: number;
  modelIoFullRetentionEnabled: boolean;
};
export interface StreamRunState {
  requestMessages: AiSdkModelTextRequest["messages"];
  signatureRepairAttempted: boolean;
  emptyCompletionRetryCount: number;
  physicalAttempt: number;
}
export interface StreamAttemptState {
  emittedEvent: boolean;
  emittedRetryBoundaryEvent: boolean;
  emittedError: boolean;
  retryScheduledFromStreamChunk: boolean;
  offPeakQueueHoldFromStreamChunk: boolean;
  statusContext: ReturnType<typeof createAttemptStatusContext>;
  streamIterator?: AsyncIterator<TextStreamPart<ToolSet>>;
  streamReachedNaturalEnd: boolean;
  attemptFailed: boolean;
  awaitIteratorClose: boolean;
  terminalStatusPublished: boolean;
  options?: ReturnType<typeof createStreamTextOptions>;
  result?: AiSdkStreamTextResult;
  requestHeaders: Record<string, string>;
  requestHeaderCount: number;
  resolved: ResolvedAiSdkModel;
  timeToFirstProviderEventMs?: number;
  timeToFirstContentMs?: number;
  timeToFirstTextMs?: number;
  streamMaxIdleMs: number;
  streamStallCount: number;
  streamOutputCommitted: boolean;
}
export interface StreamAttemptContext {
  input: RunStreamTextInput;
  attempt: number;
  retryBudgetAttempt: number;
  startedAt: number;
  streamIdleTimeoutMs: number;
  pendingRetrySafeEvents: ModelStreamEvent[];
  diagnostics: ReturnType<typeof createStreamDiagnostics>;
  attemptAbortController: ReturnType<typeof createLinkedAbortController>;
  attemptRequest: AiSdkModelTextRequest;
  toolCallAssembler: StreamingToolCallAssembler;
  recordModelIO: boolean;
  isDev: boolean;
  authRetry: AccountRequestRetry;
  statusMaxAttempts: (extraAttempts: number) => number;
  retryBudget: ModelRetryBudget | undefined;
  repairThinkingSignatureRejection: (error: unknown) => boolean;
  publishVisibleMilestones: (observation: { contentMs?: number; textMs?: number }) => Promise<void>;
  admission: AttemptAdmission;
  runState: StreamRunState;
  state: StreamAttemptState;
}
export type StreamAttemptOutcome = "completed" | "retry" | "hold_retry_budget";
