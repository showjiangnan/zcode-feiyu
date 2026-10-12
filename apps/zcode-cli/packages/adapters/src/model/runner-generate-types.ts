// Modified by ZCode Feiyu.
import type { Logger, ModelStatusSink } from "@zcode/contracts";
import { AccountRequestRetry } from "./account-request-retry.js";
import type { EnvRecord } from "./model-execution.js";
import { type AttemptAdmission } from "./request-admission.js";
import type { ResolvedAiSdkModelRetryOptions } from "./retry-policy.js";
import { createGenerateTextOptions } from "./runner-options.js";
import type {
  AiSdkModelRuntime,
  AiSdkModelTextRequest,
  ResolvedAiSdkModel,
} from "./runner-runtime.js";
import { createAttemptStatusContext } from "./runner-status.js";
export interface GenerateTextInput {
  debugDir?: string;
  env: EnvRecord;
  logger?: Logger;
  request: AiSdkModelTextRequest;
  resolveModel: () => ResolvedAiSdkModel;
  resolved: ResolvedAiSdkModel;
  retry: ResolvedAiSdkModelRetryOptions;
  runtime: AiSdkModelRuntime;
  statusSink?: ModelStatusSink;
  modelIoFullRetentionEnabled: boolean;
}
// 这是原闭包的 accessor 端口；仅列出的四个状态可回写，不复制历史、requestId 或准入票据。
export interface GenerateTextFailureContext {
  readonly input: GenerateTextInput;
  readonly authRetry: AccountRequestRetry;
  readonly retryBudget: AiSdkModelTextRequest["modelRetryBudget"];
  signatureRepairAttempted: boolean;
  requestMessages: AiSdkModelTextRequest["messages"];
  readonly statusMaxAttempts: (extraAttempts: number) => number;
  readonly isDev: boolean;
  readonly recordModelIO: boolean;
  attempt: number;
  readonly retryBudgetAttempt: number;
  readonly attemptRequest: AiSdkModelTextRequest;
  readonly startedAt: number;
  readonly resolved: ResolvedAiSdkModel;
  statusContext: ReturnType<typeof createAttemptStatusContext>;
  readonly options: ReturnType<typeof createGenerateTextOptions> | undefined;
  readonly requestInvocationCompleted: boolean;
  readonly requestHeaders: Record<string, string>;
  readonly requestHeaderCount: number;
  readonly admission: AttemptAdmission;
}
