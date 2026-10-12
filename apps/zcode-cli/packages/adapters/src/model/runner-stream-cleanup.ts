// Modified by ZCode Feiyu.
import type { Logger } from "@zcode/contracts";
import { ModelFailureReason as ModelFailureReasonValue } from "@zcode/contracts";
import type { TextStreamPart, ToolSet } from "ai";

import type { AiSdkStreamTextResult } from "./runner-runtime.js";
import { publishModelStatus } from "./runner-status.js";

import { statusPublishOptions } from "./runner-stream-status.js";

import type { StreamAttemptContext } from "./runner-stream-state.js";
export async function cleanupStreamAttempt(context: StreamAttemptContext): Promise<void> {
  const { input, attempt, startedAt, attemptAbortController, admission, state } = context;

  if (
    !state.streamReachedNaturalEnd &&
    (state.attemptFailed || input.request.preserveProviderStreamBoundaries === true)
  ) {
    // 普通 stream 的 429 retry 失败若不进入本清理分支，
    // AI SDK fullStream tee 会持有旧 provider 请求，连续重试会让后续物理请求卡在发送前。
    // 失败 attempt 必须无条件中止并释放；普通 consumer 主动提前结束仍保持原语义。
    if (!attemptAbortController.signal.aborted) {
      attemptAbortController.controller.abort(
        new Error("Model stream attempt ended before natural EOF."),
      );
    }
    if (!state.attemptFailed && !state.terminalStatusPublished && !state.emittedError) {
      // consumer 侧的校验异常只会触发 AsyncIteratorClose，不会回到上面的 catch；
      // 将已启动的物理请求收口为 cancelled，避免 fallback 前遗留悬空 started 状态。
      const completedAt = Date.now();
      await publishModelStatus(
        {
          ...state.statusContext,
          attempt,
          durationMs: completedAt - startedAt,
          message: "Model stream consumer closed before natural EOF.",
          reason: ModelFailureReasonValue.Cancelled,
          requestHeaderCount: state.requestHeaderCount,
          requestHeaders: state.requestHeaders,
          retryable: false,
          errorCode: "model_request_cancelled",
          errorPhase: "stream",
          exceptionType: "AbortError",
          streamOutputCommitted: state.streamOutputCommitted,
          timestamp: new Date(completedAt).toISOString(),
          type: "model_request_failed",
        },
        statusPublishOptions(input, admission),
      );
    }
    if (state.attemptFailed && state.awaitIteratorClose) {
      await closeStreamIteratorBestEffort(state.streamIterator, {
        attempt,
        logger: input.logger,
        result: state.result,
      });
    } else {
      void closeStreamIteratorBestEffort(state.streamIterator, {
        attempt,
        logger: input.logger,
      });
    }
  } else if (attemptAbortController.signal.aborted) {
    // 普通 main 保留既有生命周期：只有 caller/idle 已经 abort 时才 best-effort 关闭 iterator。
    void closeStreamIteratorBestEffort(state.streamIterator, {
      attempt,
      logger: input.logger,
    });
  }
  attemptAbortController.cleanup();
  // 兜底归还（成功 / 抛出 / 消费者提前 return 都到这里）；正常失败路径已在 sleep 前归还，幂等。
  await admission.release();
}
export const STREAM_ATTEMPT_CLEANUP_TIMEOUT_MS = 1_000;

export async function closeStreamIteratorBestEffort(
  streamIterator: AsyncIterator<TextStreamPart<ToolSet>> | undefined,
  options: { attempt: number; logger?: Logger; result?: AiSdkStreamTextResult },
): Promise<void> {
  const cleanupOperations: Array<{ name: string; promise: Promise<unknown> }> = [];
  if (streamIterator?.return) {
    cleanupOperations.push({
      name: "iterator.return",
      promise: Promise.resolve().then(() => streamIterator.return?.()),
    });
  }
  if (options.result?.consumeStream) {
    cleanupOperations.push({
      name: "result.consumeStream",
      // AI SDK fullStream getter 会 tee 并把另一支保存在 baseStream；
      // 只等待外层 iterator.return() 仍可能让底层 reader/连接槽继续被保留。
      promise: Promise.resolve().then(() => options.result?.consumeStream()),
    });
  }
  if (cleanupOperations.length === 0) return;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    Promise.allSettled(cleanupOperations.map((operation) => operation.promise)).then((results) => ({
      results,
      type: "settled" as const,
    })),
    new Promise<{ type: "timed_out" }>((resolve) => {
      timeout = setTimeout(() => resolve({ type: "timed_out" }), STREAM_ATTEMPT_CLEANUP_TIMEOUT_MS);
    }),
  ]);
  if (timeout !== undefined) clearTimeout(timeout);

  if (outcome.type === "timed_out") {
    options.logger?.warn("Model stream attempt cleanup timed out", {
      attempt: options.attempt,
      cleanupOperations: cleanupOperations.map((operation) => operation.name),
      event: "model.stream_attempt_cleanup.timeout",
      status: "waiting",
      timeoutMs: STREAM_ATTEMPT_CLEANUP_TIMEOUT_MS,
    });
    return;
  }

  const failures = outcome.results.flatMap((result, index) =>
    result.status === "rejected"
      ? [
          {
            errorMessage:
              result.reason instanceof Error ? result.reason.message : String(result.reason),
            operation: cleanupOperations[index]?.name,
          },
        ]
      : [],
  );
  if (failures.length > 0) {
    // 异步清理失败或超时只能降级告警，不能覆盖原始 provider/retry 错误。
    options.logger?.warn("Model stream attempt cleanup failed", {
      attempt: options.attempt,
      event: "model.stream_attempt_cleanup.failed",
      failures,
      status: "failed",
    });
  }
}
