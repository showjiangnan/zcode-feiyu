// Modified by ZCode Feiyu.
import { ModelErrorCode, ModelProtocolError, ModelRetryReason } from "@zcode/contracts";
import type { ClassifiedModelFailure } from "./failure-classifier.js";
import { classifyModelFailure, inspectProviderFailure } from "./failure-classifier.js";
import { getResponseHeaders, unwrapRetryError } from "./failure-inspection.js";
import { offPeakTicketExpiredMessage, resolveOffPeakFailureDecision } from "./offpeak-retry.js";
import { repairReasoningHistoryAfterSignatureRejection } from "./reasoning-history-normalization.js";
import { retryBudgetAllows } from "./retry-budget.js";
import { recordGenerateTextDebug } from "./runner-debug.js";
import { publishRetryScheduledStatus, statusPublishOptions } from "./runner-generate-helpers.js";
import type { GenerateTextFailureContext } from "./runner-generate-types.js";
import { sanitizeModelNetworkHeaders } from "./runner-network-headers.js";
import {
  calculateRetryDelay,
  logRetryDelayDecision,
  sleep,
  toAdapterError,
} from "./runner-retry.js";
import { RuntimeHeadersRefreshError } from "./runner-runtime-headers.js";
import { publishModelStatus } from "./runner-status.js";
import { modelFailureStatusFields } from "./runner-telemetry.js";
import { retryAllowedByFailurePolicy } from "./workflow-model-failure-policy.js";
export async function handleGenerateTextFailure(
  error: unknown,
  context: GenerateTextFailureContext,
): Promise<void> {
  // 合并后鉴权解析进入 attempt try；与 stream 一致保留网络前凭据缺失的类型化错误。
  if (error instanceof ModelProtocolError && error.code === ModelErrorCode.ModelRequestAuthMissing)
    throw error;
  const completedAt = Date.now();
  const classified = classifyModelFailure(error, context.input.request.abortSignal);
  if (error instanceof RuntimeHeadersRefreshError) {
    classified.message = error.message;
    classified.retryable = false;
  }
  // off-peak 特判（仅 idle plan provider，见 offpeak-retry.ts）：排队 429 豁免预算、
  // 3102（兼容旧 3001）以稳定标记落败触发 desktop 侧续跑。
  const offPeak = resolveOffPeakFailureDecision({
    offPeak: context.resolved.accountAccess?.mode === "off-peak",
    failure: classified,
    error: unwrapRetryError(error),
  });
  const failure: ClassifiedModelFailure =
    offPeak?.kind === "ticketExpired"
      ? {
          ...classified,
          retryable: false,
          message: offPeakTicketExpiredMessage(classified.message),
        }
      : offPeak?.kind === "queued"
        ? { ...classified, retryable: true, retryReason: ModelRetryReason.OffpeakQueued }
        : classified;
  const responseHeaders = sanitizeModelNetworkHeaders(getResponseHeaders(unwrapRetryError(error)));
  const repairedMessages =
    !context.signatureRepairAttempted && context.resolved.providerKind === "anthropic"
      ? repairReasoningHistoryAfterSignatureRejection(context.requestMessages, error)
      : undefined;
  const retryWithRepairedHistory = repairedMessages !== undefined;
  if (repairedMessages) {
    // 签名只对生成它的 thinking block 有效。明确收到签名校验 400 时，
    // 只替换本次请求副本，并给一次不占普通 retry 预算的物理请求机会；不能通过
    // 回退 attempt 复用 requestId，也不能改写 canonical history。
    context.signatureRepairAttempted = true;
    context.requestMessages = repairedMessages;
    context.statusContext = {
      ...context.statusContext,
      maxAttempts: context.statusMaxAttempts(1 + context.authRetry.extraAttempts),
    };
  }
  const canRetryWithFailurePolicy =
    offPeak?.kind === "queued"
      ? true
      : retryBudgetAllows(
          context.retryBudget,
          context.retryBudgetAttempt,
          context.input.retry.maxAttempts,
        ) &&
        // workflow 流量（无上限预算）读策略表而不是分类器的 retryable；有界预算逐字不变。
        retryAllowedByFailurePolicy(
          failure,
          context.retryBudget,
          inspectProviderFailure(error).providerErrorCode,
        );
  const retryWithAuth = context.authRetry.claim(error, context.options === undefined);
  if (retryWithAuth)
    context.statusContext = {
      ...context.statusContext,
      maxAttempts: context.statusMaxAttempts(
        Number(context.signatureRepairAttempted) + context.authRetry.extraAttempts,
      ),
    };
  const canRetry = retryWithAuth || retryWithRepairedHistory || canRetryWithFailurePolicy;

  if (context.options) {
    recordGenerateTextDebug({
      modelIoFullRetentionEnabled: context.input.modelIoFullRetentionEnabled,
      attempt: context.attempt,
      debugDir: context.input.debugDir,
      error,
      isDev: context.isDev,
      normalizedToolCalls: undefined,
      options: context.options,
      recordModelIO: context.recordModelIO,
      request: context.attemptRequest,
      requestId: context.statusContext.requestId,
      resolved: context.resolved,
      startedAt: context.startedAt,
    });
  }
  await publishModelStatus(
    {
      ...context.statusContext,
      attempt: context.attempt,
      durationMs: completedAt - context.startedAt,
      message: failure.message,
      reason: failure.reason,
      requestHeaderCount: context.requestHeaderCount,
      requestHeaders: context.requestHeaders,
      responseHeaderCount: Object.keys(responseHeaders).length,
      responseHeaders,
      retryable: canRetry,
      statusCode: failure.statusCode,
      ...modelFailureStatusFields(
        error,
        failure,
        context.requestInvocationCompleted ? "response" : "prepare",
      ),
      timestamp: new Date(completedAt).toISOString(),
      type: "model_request_failed",
    },
    {
      ...statusPublishOptions(context.input, context.admission),
      failureError: unwrapRetryError(error),
    },
  );

  if (!canRetry) {
    logRetryDelayDecision({
      attempt: context.attempt,
      canRetry,
      failure,
      logger: context.input.logger,
      responseHeaders,
      statusContext: context.statusContext,
    });
    throw toAdapterError(error, failure, context.statusContext, context.attempt, {
      errorPhase: context.requestInvocationCompleted ? "response" : "prepare",
    });
  }

  if (retryWithAuth) {
    await publishRetryScheduledStatus(
      context.input,
      context.statusContext,
      context.attempt,
      0,
      { ...failure, retryReason: ModelRetryReason.AuthRefresh },
      context.requestHeaders,
      responseHeaders,
    );
    return;
  }

  if (retryWithRepairedHistory) {
    context.input.logger?.warn("Retrying model request after thinking signature rejection", {
      attempt: context.attempt,
      event: "model.reasoning_signature_repair.retry",
      maxAttempts: context.statusContext.maxAttempts,
      nextAttempt: context.attempt + 1,
      requestId: context.statusContext.requestId,
      status: "waiting",
    });
    await publishRetryScheduledStatus(
      context.input,
      context.statusContext,
      context.attempt,
      0,
      {
        ...failure,
        retryReason: ModelRetryReason.ReasoningSignatureRepair,
      },
      context.requestHeaders,
      responseHeaders,
      context.admission,
    );
    return;
  }

  const delayMs =
    offPeak?.kind === "queued"
      ? offPeak.delayMs
      : calculateRetryDelay(context.input.retry, context.retryBudgetAttempt, failure.retryAfterMs);
  logRetryDelayDecision({
    attempt: context.attempt,
    canRetry,
    delayMs,
    failure,
    logger: context.input.logger,
    responseHeaders,
    statusContext: context.statusContext,
  });

  await publishRetryScheduledStatus(
    context.input,
    context.statusContext,
    context.attempt,
    delayMs,
    failure,
    context.requestHeaders,
    responseHeaders,
    context.admission,
  );

  // 退避期间不持票：槽位让给别人，重试再准入。
  await context.admission.release();
  try {
    await sleep(delayMs, context.input.request.abortSignal);
  } catch (sleepError) {
    const sleepFailure = classifyModelFailure(sleepError, context.input.request.abortSignal);
    const sleepResponseHeaders = sanitizeModelNetworkHeaders(
      getResponseHeaders(unwrapRetryError(sleepError)),
    );
    await publishModelStatus(
      {
        ...context.statusContext,
        attempt: context.attempt,
        message: sleepFailure.message,
        reason: sleepFailure.reason,
        requestHeaderCount: context.requestHeaderCount,
        requestHeaders: context.requestHeaders,
        responseHeaderCount: Object.keys(sleepResponseHeaders).length,
        responseHeaders: sleepResponseHeaders,
        retryable: false,
        statusCode: sleepFailure.statusCode,
        ...modelFailureStatusFields(sleepError, sleepFailure, "connect"),
        timestamp: new Date().toISOString(),
        type: "model_request_failed",
      },
      {
        // 退避期间票据已归还：这次取消不属于任何一次尝试，不转投票据。
        ...statusPublishOptions(context.input),
        failureError: unwrapRetryError(sleepError),
      },
    );
    throw toAdapterError(sleepError, sleepFailure, context.statusContext, context.attempt, {
      errorPhase: "connect",
    });
  }
  if (offPeak?.kind === "queued") {
    // 排队等待不消耗重试预算：回退计数让 for 自增后原地重试，无限探测。
    context.attempt -= 1;
  }
}
