// Modified by ZCode Feiyu contributors (2026).
import {
  getCurrentModelInvocationContext,
  type Model,
  type ModelRequest,
  type ModelRequestAdmission,
  type ModelRequestAdmissionTicket,
} from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import { assertProactiveExecution, isProactiveCommandId } from "../orchestration.js";

// 父模型可能已包装同一个 governor/观察端口。记录传递覆盖，避免子 runtime 重复取得并发票据。
const composedAdmissions = new WeakMap<ModelRequestAdmission, ReadonlySet<ModelRequestAdmission>>();

/** 只组合现有治理/观察端口与执行许可，不创建累计消费准入或任务时钟。 */
export function runtimeRequestAdmission(
  runtime: AgentRuntimeInternal,
  model: Model,
  request: ModelRequest,
): ModelRequestAdmission | undefined {
  const parents = [
    ...new Set(
      [
        request.modelRequestAdmission,
        getCurrentModelInvocationContext()?.modelRequestAdmission,
        runtime.modelRequestAdmission,
      ].filter((port): port is ModelRequestAdmission => Boolean(port)),
    ),
  ];
  const covered = new Set(parents.flatMap((port) => [...(composedAdmissions.get(port) ?? [])]));
  const upstream = parents.filter((port) => !covered.has(port));
  const commandId = runtime.activeTurn?.inputId;
  const proactive = isProactiveCommandId(commandId);
  if (!upstream.length && !proactive) return undefined;
  // 绑定模型的默认值仍参与单次输出配置；请求显式选项优先，不与消费统计挂钩。
  request.options = {
    ...request.options,
    maxOutputTokens:
      request.options?.maxOutputTokens ??
      model.options.maxOutputTokens ??
      model.optionSpecs.maxOutputTokens.max,
  };
  const check = async (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    request.abortSignal?.throwIfAborted();
    if (proactive) await assertProactiveExecution(runtime, commandId!);
    signal?.throwIfAborted();
    request.abortSignal?.throwIfAborted();
  };
  const admission: ModelRequestAdmission = {
    async acquire(input) {
      const tickets: ModelRequestAdmissionTicket[] = [];
      try {
        await check(input.signal);
        for (const parent of upstream) {
          tickets.push(parent.tryAcquire?.(input) ?? (await parent.acquire(input)));
          await check(input.signal);
        }
      } catch (error) {
        const cleanup = await Promise.allSettled(
          tickets.map((ticket) => Promise.resolve().then(() => ticket.release())),
        );
        const failures = cleanup.filter((result) => result.status === "rejected");
        if (failures.length)
          throw new AggregateError(
            [error, ...failures.map((result) => result.reason)],
            "Model admission cleanup failed",
          );
        throw error;
      }
      let released: Promise<void> | undefined;
      return {
        async publish(event) {
          const results = await Promise.allSettled(
            tickets.map((ticket) => Promise.resolve().then(() => ticket.publish(event))),
          );
          const failures = results.filter((result) => result.status === "rejected");
          if (failures.length)
            throw new AggregateError(
              failures.map((result) => result.reason),
              "Model admission event failed",
            );
          // 上游观察可能等待 I/O；发送前在最后一个边界复核撤权，避免排队期间的陈旧许可。
          if (event.type === "model_request_started") await check(input.signal);
        },
        release() {
          released ??= (async () => {
            const results = await Promise.allSettled(
              tickets.map((ticket) => Promise.resolve().then(() => ticket.release())),
            );
            const failures = results.filter((result) => result.status === "rejected");
            if (failures.length)
              throw new AggregateError(
                failures.map((result) => result.reason),
                "Model admission release failed",
              );
          })();
          return released;
        },
      };
    },
  };
  composedAdmissions.set(admission, new Set([...upstream, ...covered]));
  return admission;
}
