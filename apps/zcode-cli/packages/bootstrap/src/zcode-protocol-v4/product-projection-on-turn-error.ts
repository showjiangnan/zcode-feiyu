// Modified by ZCode Feiyu.
import type {
  SessionEvent,
  TurnErrorPayload,
  ModelNetworkStatusPayload,
  StreamRecoveryStartedPayload,
  StreamRecoveryRetryStartedPayload,
} from "@zcode/contracts";
import type { ConversationDelta } from "@zcode/shared/zcode-protocol-v4";
import {
  LEGACY_TURN_ERROR_RECOVERABLE_FALLBACK,
  modelRetryReasonCode,
} from "./product-projection-hook-invocation-row-content.js";
import { isHighspeedProviderId } from "@zcode/shared";
import {
  positiveInteger,
  nonNegativeInteger,
  streamRecoveryReasonCode,
} from "./product-projection-stream-recovery-reason-code.js";
import type { ProductProjection } from "./product-projection.js";

export function onTurnError(this: ProductProjection, event: SessionEvent): ConversationDelta[] {
  const payload = event.payload as TurnErrorPayload;
  this["outputContinuationTextRowId"] = null;
  if (this["turnHeaderForEvent"](event)?.executionKind === "controlOnly") {
    const deltas = [
      ...this["upsertTurnHeader"](event, "failed"),
      ...this["leaveDraftAfterControlOnlyTurn"]("error"),
    ];
    this["currentTurnId"] = null;
    // turn 收口后 model-only 标记随之失效，避免影响下一次归属判断。
    this["currentTurnStartedModelOnly"] = false;
    return deltas;
  }
  // TurnError 结束的是当前 turn，
  // 不是已经 accepted 的 future input。旧 reducer 没有 terminal queue patch，core 为了
  // 防止 error 后悬挂只能先发 TurnSteerDiscarded，造成用户消息丢失；现在把现有 queue
  // 原样转成 error-paused，等待显式 setAutoDrain(true) 恢复 FIFO。
  const heldQueue =
    this["snapshot"].queue.items.length > 0
      ? {
          ...this["snapshot"].queue,
          autoDrain: false,
          pauseReason: "error" as const,
        }
      : undefined;
  return [
    ...this["closeStreamingRows"]("interrupted"),
    ...this["closeOpenToolRows"](event, "error"),
    ...this["upsertTurnHeader"](
      event,
      "failed",
      undefined,
      undefined,
      this["highspeedTimingForTurn"](this["turnIdOf"](event)),
    ),
    {
      op: "state.updated",
      patch: this["controlPatch"](
        {
          phase: "error",
          sessionEnded: false,
          canStop: false,
          stopState: "idle",
          stopTargetKind: "unknown",
          activeWorks: [],
          // 事件侧尚未携带 fault.* 分类，先透传错误类型，待补齐分类后再细化映射。
          lastError: {
            code: payload.error.code ?? payload.error.type ?? "fault.runtime.unknown",
            message: payload.error.message,
            recoverable: payload.error.retryable ?? LEGACY_TURN_ERROR_RECOVERABLE_FALLBACK,
            at: this["ms"](event),
            // 旧投影把所有 TurnError 都写成 runtime，丢失 adapter 已识别的 provider/network 事实。
            source: payload.error.attribution?.source ?? "runtime",
            traceId: String(event.traceId),
            ...(payload.error.detail ? { detail: payload.error.detail } : {}),
            ...(payload.error.underlyingErrorMessage
              ? { underlyingErrorMessage: payload.error.underlyingErrorMessage }
              : {}),
            ...(payload.error.underlyingErrorDetail
              ? { underlyingErrorDetail: payload.error.underlyingErrorDetail }
              : {}),
            ...(payload.error.attribution ? { attribution: payload.error.attribution } : {}),
          },
          // 同 onTurnComplete：终态是重试生命周期的兜底清理边界。
          apiRetry: null,
        },
        undefined,
        heldQueue,
      ),
    },
  ];
}

export function onModelNetworkStatus(
  this: ProductProjection,
  event: SessionEvent,
): ConversationDelta[] {
  if (!this["acceptsActiveModelEvent"](event)) return [];
  const payload = event.payload as ModelNetworkStatusPayload;
  if (
    (payload.querySource === undefined || payload.querySource === "main_turn") &&
    (payload.type === "model_request_completed" || payload.type === "model_request_failed") &&
    // 加速卡按 family 拆成了多个隐藏 Provider（zai/bigmodel），不能再和单个常量比较，
    // 否则 BigModel 账号的加速轮会被判成普通轮、节省时间恒为 0。
    isHighspeedProviderId(payload.providerId) &&
    payload.durationMs !== undefined
  ) {
    // Bug 根因：混合 Turn 卡过期后会切到普通 provider，旧逻辑把普通模型的重试/超时
    // 也累计进 Highspeed modelDurationMs，导致节省时间按高速倍率放大数小时。
    const turnId = this["turnIdOf"](event);
    this["highspeedModelDurationByTurnId"].set(
      turnId,
      (this["highspeedModelDurationByTurnId"].get(turnId) ?? 0) + Math.max(0, payload.durationMs),
    );
  }
  switch (payload.type) {
    case "model_retry_scheduled": {
      const attempt = positiveInteger(payload.attempt, 1);
      const maxAttempts = Math.max(positiveInteger(payload.maxAttempts, attempt + 1), attempt + 1);
      return this["setApiRetry"]({
        attempt,
        maxAttempts,
        nextRetryAt: this["ms"](event) + nonNegativeInteger(payload.delayMs, 0),
        reasonCode: modelRetryReasonCode(payload.reason),
      });
    }
    case "model_request_started":
      if (payload.streamRecovery) {
        return this["setApiRetry"](
          this["streamRecoveryApiRetry"](
            payload.streamRecovery.retryNumber,
            payload.streamRecovery.maxRetries,
            this["ms"](event),
            this["snapshot"].control.apiRetry?.reasonCode ?? "fault.network.sseDisconnected",
          ),
        );
      }
      // adapter attempt=2+ 只说明重试请求已发出，不代表连接恢复；
      // 保持当前状态，等首个有效 text/reasoning/tool 进展再清理，避免标签闪退。
      return positiveInteger(payload.attempt, 1) <= 1 ? this["setApiRetry"](null) : [];
    case "model_request_completed":
      return this["setApiRetry"](null);
    case "model_request_failed":
      return payload.retryable ? [] : this["setApiRetry"](null);
    case "model_stream_stalled":
    case "model_first_provider_event":
    case "model_first_content":
    case "model_first_text":
    // 准入等待的两端是 runtime 观测，不是 UI 状态：
    // 不映射成重试/等待标签。
    case "model_request_queued":
    case "model_request_admitted":
    case "model_request_observation":
      return [];
  }
}

export function onStreamRecoveryStarted(
  this: ProductProjection,
  event: SessionEvent,
): ConversationDelta[] {
  if (!this["acceptsActiveModelEvent"](event)) return [];
  const payload = event.payload as StreamRecoveryStartedPayload;
  return this["setApiRetry"](
    this["streamRecoveryApiRetry"](
      payload.retryNumber,
      payload.maxRetries,
      this["ms"](event),
      streamRecoveryReasonCode(payload.failureKind),
    ),
  );
}

export function onStreamRecoveryTailDiscarded(
  this: ProductProjection,
  event: SessionEvent,
): ConversationDelta[] {
  if (!this["acceptsActiveModelEvent"](event)) return [];
  // Bug 原因：Core 已用 tail_discarded 切断失败 assistant attempt，但旧 V4 投影忽略该事件，
  // 下一次 reasoning/text 到达时会把旧行误收口为 complete。这里必须先标 interrupted，
  // 让恢复流用新 assistant identity 打开新行，避免 UI 看起来像一次连续完整输出。
  // Bug 原因：断流时已由 tool_input_start 打开、但还没等到 tool_call 定稿的工具行也属于
  // 被作废的 tail——core 只为已提交的工具合成终态，这些行没人收口；恢复请求会用新的
  // toolCallId 再开一行，UI 于是并排出现两张「正在编写工作流」。已提交（running /
  // pendingApproval）的行不在此列，它们的终态由 executor 自己发布。
  return [
    ...this["closeStreamingRows"]("interrupted"),
    ...this["closeOpenToolRows"](event, "cancelled", (row) => row.status === "inputStreaming"),
  ];
}

export function onStreamRecoveryRetryStarted(
  this: ProductProjection,
  event: SessionEvent,
): ConversationDelta[] {
  if (!this["acceptsActiveModelEvent"](event)) return [];
  const payload = event.payload as StreamRecoveryRetryStartedPayload;
  return this["setApiRetry"](
    this["streamRecoveryApiRetry"](
      payload.retryNumber,
      payload.maxRetries,
      this["ms"](event),
      this["snapshot"].control.apiRetry?.reasonCode ?? "fault.network.sseDisconnected",
    ),
  );
}
