// Modified by ZCode Feiyu.
import type { ModelTextResult } from "@zcode/contracts";
import { ModelErrorCode, ModelTransportKind as ModelTransportKindValue } from "@zcode/contracts";
import { AccountRequestRetry } from "./account-request-retry.js";
import { resolveAnthropicRequestMetadataUserId } from "./anthropic-request-metadata.js";
import { canRetryEmptyCompletion, scheduleEmptyCompletionRetry } from "./empty-completion-retry.js";
import { AiSdkModelAdapterError } from "./errors.js";
import { classifyModelFailure } from "./failure-classifier.js";
import { unwrapRetryError } from "./failure-inspection.js";
import { detectProviderBusinessFinishError } from "./provider-finish-business-error.js";
import { admitAttempt, type AttemptAdmission } from "./request-admission.js";
import { retryAttemptLoopContinues, retryBudgetMaxAttempts } from "./retry-budget.js";
import {
  isDevelopmentModelIOEnv,
  recordGenerateTextDebug,
  shouldRecordModelIO,
} from "./runner-debug.js";
import {
  getGenerateTextResultMetadata,
  isZeroOutputModelCompletion,
  logGenerateTextDiagnostics,
} from "./runner-diagnostics.js";
import { handleGenerateTextFailure } from "./runner-generate-failure.js";
import {
  serializeStructuredOutput,
  statusPublishOptions,
  waitForGenerateTextOrAbort,
} from "./runner-generate-helpers.js";
import type { GenerateTextInput } from "./runner-generate-types.js";
import { sanitizeModelNetworkHeaders } from "./runner-network-headers.js";
import {
  normalizeReasoning,
  normalizeSources,
  normalizeToolCalls,
  normalizeToolResults,
  normalizeUsage,
} from "./runner-normalization.js";
import { createGenerateTextOptions } from "./runner-options.js";
import { toAdapterError } from "./runner-retry.js";
import { resolveModelForAttempt } from "./runner-runtime-headers.js";
import {
  admissionWaitPublishers,
  createAttemptStatusContext,
  createStatusContext,
  publishModelStatus,
} from "./runner-status.js";
import { modelFailureStatusFields, providerRequestIdFromHeaders } from "./runner-telemetry.js";
export async function runGenerateText(input: GenerateTextInput): Promise<ModelTextResult> {
  // 重试预算档位：workflow actor 的请求带 unbounded，
  // 只放宽瞬态失败的放弃条件；状态事件里的 maxAttempts 以 0 表示无上限。
  const retryBudget = input.request.modelRetryBudget;
  const statusMaxAttempts = (extraAttempts: number): number =>
    retryBudgetMaxAttempts(retryBudget, input.retry.maxAttempts + extraAttempts);
  const baseStatusContext = createStatusContext({
    maxAttempts: statusMaxAttempts(0),
    request: input.request,
    resolved: input.resolved,
    transport: ModelTransportKindValue.Http,
  });
  const recordModelIO =
    input.request.metadata?.skipTranscript !== true && shouldRecordModelIO(input.env);
  const isDev = isDevelopmentModelIOEnv(input.env);
  let requestMessages = input.request.messages;
  let signatureRepairAttempted = false;
  const authRetry = new AccountRequestRetry(input.request, input.resolved, input.logger);
  let emptyCompletionRetryCount = 0;
  let physicalAttempt = 0;

  for (
    let attempt = 1;
    retryAttemptLoopContinues(
      retryBudget,
      attempt,
      input.retry.maxAttempts + Number(signatureRepairAttempted) + authRetry.extraAttempts,
    );
    attempt += 1
  ) {
    const retryBudgetAttempt = attempt - Number(signatureRepairAttempted) - authRetry.extraAttempts;
    const attemptRequest = { ...input.request, messages: requestMessages };
    const startedAt = Date.now();
    let resolved = input.resolved;
    let statusContext = createAttemptStatusContext(
      {
        ...baseStatusContext,
        maxAttempts: statusMaxAttempts(Number(signatureRepairAttempted) + authRetry.extraAttempts),
      },
      ++physicalAttempt,
    );
    let options: ReturnType<typeof createGenerateTextOptions> | undefined;
    let requestInvocationCompleted = false;
    let requestHeaders: Record<string, string> = {};
    let requestHeaderCount = 0;

    // 进程级准入：每次尝试发出前等槽位，
    // 票据在本次尝试结束时归还（成功 / 失败 / 抛出都经 finally；退避 sleep 之前先归还）。等待中被
    // 取消 → 与 sleep 被取消同一条路：记 connect 阶段的 cancelled 失败，抛出。
    let admission: AttemptAdmission;
    try {
      admission = await admitAttempt({
        admission: input.request.modelRequestAdmission,
        requestId: statusContext.requestId,
        attempt: physicalAttempt,
        model: { providerId: String(resolved.providerId), modelId: String(resolved.modelId) },
        signal: input.request.abortSignal,
        ...admissionWaitPublishers(statusContext, attempt, statusPublishOptions(input)),
      });
    } catch (admitError) {
      const admitFailure = classifyModelFailure(admitError, input.request.abortSignal);
      await publishModelStatus(
        {
          ...statusContext,
          attempt,
          message: admitFailure.message,
          reason: admitFailure.reason,
          requestHeaderCount,
          requestHeaders,
          retryable: false,
          statusCode: admitFailure.statusCode,
          ...modelFailureStatusFields(admitError, admitFailure, "connect"),
          timestamp: new Date().toISOString(),
          type: "model_request_failed",
        },
        {
          ...statusPublishOptions(input),
          failureError: unwrapRetryError(admitError),
        },
      );
      throw toAdapterError(admitError, admitFailure, statusContext, attempt, {
        errorPhase: "connect",
      });
    }

    try {
      resolved = await resolveModelForAttempt({
        attempt,
        reason: authRetry.takeReason(),
        request: authRetry.prepareRequest(attemptRequest),
        resolveModel: input.resolveModel,
      });
      const anthropicMetadataUserId = await resolveAnthropicRequestMetadataUserId({
        env: input.env,
        providerKind: resolved.providerKind,
        sessionId: statusContext.sessionId,
      });
      options = createGenerateTextOptions({
        anthropicMetadataUserId,
        env: input.env,
        includeModelIO: recordModelIO,
        request: attemptRequest,
        resolved,
        statusContext,
      });
      requestHeaders = sanitizeModelNetworkHeaders(options.headers);
      requestHeaderCount = Object.keys(requestHeaders).length;
      await publishModelStatus(
        {
          ...statusContext,
          attempt,
          requestHeaderCount,
          requestHeaders,
          timestamp: new Date(startedAt).toISOString(),
          type: "model_request_started",
        },
        statusPublishOptions(input, admission),
      );

      // 部分非流式 provider/fetch 兼容层收到 AbortSignal 后不会及时 settle
      // generateText promise，导致 runtime 已 Stop，goal verifier 仍要等上游自然返回才收口。
      // adapter 是本地取消契约边界：signal 一旦 abort 就立即拒绝，迟到 provider 结果只丢弃。
      const pendingResult = input.runtime.generateText(options);
      // options 构造成功不等于 runtime 已接受请求；同步 setup 异常会在调用点直接抛出。
      // 只有 generateText 调用返回 pending promise 后才进入 response 归因边界，避免把本地 setup 记成 provider。
      requestInvocationCompleted = true;
      const result = await waitForGenerateTextOrAbort(pendingResult, input.request.abortSignal);
      const responseHeaders = sanitizeModelNetworkHeaders(
        getGenerateTextResultMetadata(result)?.response?.headers,
      );
      const providerBusinessFinishError = detectProviderBusinessFinishError({
        providerId: String(resolved.providerId),
        providerKind: resolved.providerKind,
        source: {
          finishReason: result.finishReason,
          providerMetadata: result.providerMetadata,
          rawFinishReason: (result.providerMetadata as Record<string, unknown> | undefined)
            ?.rawFinishReason,
          response: (result as unknown as { response?: unknown }).response,
        },
      });
      if (providerBusinessFinishError) {
        throw providerBusinessFinishError;
      }
      // 每个物理 attempt 会重新解析 Model。读取初始 resolved 会拿到未发送请求的空 capture。
      const usage = {
        ...normalizeUsage(result.totalUsage ?? result.usage),
        ...(resolved.rawRequestBodyCapture?.modelSpeed
          ? { modelSpeed: { ...resolved.rawRequestBodyCapture.modelSpeed } }
          : {}),
      };
      const toolCalls = normalizeToolCalls(result, input.logger);
      const toolResults = normalizeToolResults(result, toolCalls);
      const sources = normalizeSources(result);
      const text = input.request.responseJsonSchema
        ? serializeStructuredOutput(result)
        : result.text;
      const reasoning = normalizeReasoning(result.reasoning);
      const reasoningLength = (reasoning ?? []).reduce(
        (total, block) => total + block.text.length,
        0,
      );
      if (
        input.request.preserveProviderStreamBoundaries !== true &&
        isZeroOutputModelCompletion({
          finishReason: result.finishReason,
          reasoningLength,
          textLength: text.length,
          toolCallCount: toolCalls?.length ?? 0,
          usage,
        }) &&
        canRetryEmptyCompletion({
          abortSignal: input.request.abortSignal,
          attempt,
          maxAttempts: input.retry.maxAttempts,
          retryCount: emptyCompletionRetryCount,
        })
      ) {
        const completedAt = Date.now();
        // 空 completion 是 provider promise 正常 resolve，不会进入异常重试 catch；
        // 必须在 adapter 返回前识别并重试一次，否则 core 只能收到最终空响应错误。
        logGenerateTextDiagnostics({
          attempt,
          completedAt,
          logger: input.logger,
          result,
          startedAt,
          statusContext,
          toolCallCount: toolCalls?.length ?? 0,
          usage,
        });
        // 空响应同样是已计费物理请求，必须先结算真实 usage 再释放票据并重试。
        await publishModelStatus(
          {
            ...statusContext,
            attempt,
            durationMs: completedAt - startedAt,
            finishReason: result.finishReason,
            usage,
            timestamp: new Date(completedAt).toISOString(),
            type: "model_request_completed",
          },
          statusPublishOptions(input, admission),
        );
        await admission.release();
        emptyCompletionRetryCount += 1;
        await scheduleEmptyCompletionRetry({
          abortSignal: input.request.abortSignal,
          attempt,
          completedAt,
          errorPhase: "response",
          logger: input.logger,
          requestHeaders,
          requestStatusSink: input.request.statusSink,
          responseHeaders,
          retry: input.retry,
          retryBudgetAttempt,
          startedAt,
          statusContext,
          statusSink: input.statusSink,
        });
        continue;
      }
      const completedAt = Date.now();

      recordGenerateTextDebug({
        modelIoFullRetentionEnabled: input.modelIoFullRetentionEnabled,
        attempt,
        debugDir: input.debugDir,
        isDev,
        normalizedToolCalls: toolCalls,
        options,
        recordModelIO,
        request: attemptRequest,
        requestId: statusContext.requestId,
        resolved,
        result,
        startedAt,
      });
      logGenerateTextDiagnostics({
        attempt,
        completedAt,
        logger: input.logger,
        result,
        statusContext,
        startedAt,
        toolCallCount: toolCalls?.length ?? 0,
        usage,
      });
      await publishModelStatus(
        {
          ...statusContext,
          attempt,
          durationMs: completedAt - startedAt,
          finishReason: result.finishReason,
          requestHeaderCount,
          requestHeaders,
          responseHeaderCount: Object.keys(responseHeaders).length,
          responseHeaders,
          providerRequestId: providerRequestIdFromHeaders(responseHeaders),
          timestamp: new Date(completedAt).toISOString(),
          type: "model_request_completed",
          usage,
        },
        statusPublishOptions(input, admission),
      );

      return {
        text,
        finishReason: result.finishReason,
        usage,
        reasoning,
        toolCalls,
        toolResults,
        sources,
        providerMetadata: result.providerMetadata as Record<string, unknown> | undefined,
      };
    } catch (error) {
      await handleGenerateTextFailure(error, {
        get input() {
          return input;
        },
        get authRetry() {
          return authRetry;
        },
        get retryBudget() {
          return retryBudget;
        },
        get signatureRepairAttempted() {
          return signatureRepairAttempted;
        },
        set signatureRepairAttempted(value) {
          signatureRepairAttempted = value;
        },
        get requestMessages() {
          return requestMessages;
        },
        set requestMessages(value) {
          requestMessages = value;
        },
        get statusMaxAttempts() {
          return statusMaxAttempts;
        },
        get isDev() {
          return isDev;
        },
        get recordModelIO() {
          return recordModelIO;
        },
        get attempt() {
          return attempt;
        },
        set attempt(value) {
          attempt = value;
        },
        get retryBudgetAttempt() {
          return retryBudgetAttempt;
        },
        get attemptRequest() {
          return attemptRequest;
        },
        get startedAt() {
          return startedAt;
        },
        get resolved() {
          return resolved;
        },
        get statusContext() {
          return statusContext;
        },
        set statusContext(value) {
          statusContext = value;
        },
        get options() {
          return options;
        },
        get requestInvocationCompleted() {
          return requestInvocationCompleted;
        },
        get requestHeaders() {
          return requestHeaders;
        },
        get requestHeaderCount() {
          return requestHeaderCount;
        },
        get admission() {
          return admission;
        },
      });
    } finally {
      await admission.release();
    }
  }

  throw new AiSdkModelAdapterError(
    ModelErrorCode.ModelRequestFailed,
    "Model request failed before an attempt could complete",
    { context: { requestId: baseStatusContext.requestId } },
  );
}
