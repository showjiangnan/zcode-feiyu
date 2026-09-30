// Modified by ZCode Feiyu contributors (2026).
import type { Model, ModelRequest, ModelRequestAdmission, ModelUsage } from "@zcode/contracts";
import { getModelUsageTotalTokens, hasModelTokenUsage } from "@zcode/contracts";
import { estimateProviderRequestInputTokens } from "../model/provider-request-estimate.js";

/** 只有模型未声明输出上限时才使用的回落值。 */
export const MEMORY_DEFAULT_OUTPUT_TOKENS = 5_000;
const REQUEST_ENVELOPE_TOKENS = 256;

/** 只按单次模型能力设置输出；估算仅用于服务未报告用量时的观察，不参与准入。 */
export function estimateMemoryRequest(
  request: ModelRequest,
  model?: Pick<Model, "options" | "optionSpecs">,
): number {
  const capability = model?.optionSpecs.maxOutputTokens.max;
  const requested =
    request.options?.maxOutputTokens ??
    model?.options?.maxOutputTokens ??
    capability ??
    MEMORY_DEFAULT_OUTPUT_TOKENS;
  const output = Math.floor(Math.min(requested, capability ?? requested));
  request.options = { ...request.options, maxOutputTokens: output };
  return estimateProviderRequestInputTokens(request) + REQUEST_ENVELOPE_TOKENS + output;
}

/** 每个物理尝试独立结算；逻辑调用只对未实现 admission 的模型保留兼容结算。 */
export function createMemoryRequestAccounting(input: {
  request: ModelRequest;
  model: Model;
  onUsage: (tokens: number, estimated: boolean) => void | Promise<void>;
  onRequest?: () => void | Promise<void>;
}) {
  const estimatedTokens = estimateMemoryRequest(input.request, input.model);
  let observedAdmission = false;
  const consume = async (usage?: ModelUsage) => {
    // 只有服务端工具计数、没有 token 的用量不能证明消费为零，按估算记录用量。
    const estimated = !hasModelTokenUsage(usage);
    await input.onUsage(estimated ? estimatedTokens : getModelUsageTotalTokens(usage), estimated);
  };
  const admission: ModelRequestAdmission = {
    async acquire({ signal }) {
      observedAdmission = true;
      signal?.throwIfAborted();
      input.request.abortSignal?.throwIfAborted();
      let started = false;
      let released = false;
      let settlement: Promise<void> | undefined;
      const settle = (usage?: ModelUsage) =>
        (settlement ??= Promise.resolve().then(() => consume(usage)));
      return {
        async publish(event) {
          if (released) return;
          if (event.type === "model_request_started" && !started) {
            started = true;
            await input.onRequest?.();
          }
          if (event.type === "model_request_failed" && event.errorPhase === "prepare")
            started = false;
          if (event.type === "model_request_completed") await settle(event.usage);
        },
        async release() {
          if (released) return settlement;
          released = true;
          // 已发送但无终结用量（含取消/网络失败）记录估算；内层准入失败、未发送的票据不消费。
          if (started) await settle();
        },
      };
    },
  };
  return {
    admission,
    async finish(usage?: ModelUsage) {
      if (observedAdmission) return;
      observedAdmission = true;
      await input.onRequest?.();
      await consume(usage);
    },
  };
}
