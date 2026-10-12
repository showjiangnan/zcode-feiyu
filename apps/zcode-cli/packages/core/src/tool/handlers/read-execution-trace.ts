// Modified by ZCode Feiyu.
import type { ToolExecutionContext } from "../types.js";
import { type TraceContext } from "@zcode/contracts";

// 按职责拆分；保留原始规则、执行顺序与状态所有者。

export function createReadTrace(context: ToolExecutionContext): TraceContext {
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: context.parentSpanId,
    sessionId: context.sessionId,
    turnId: context.turnId,
  } as unknown as TraceContext;
}
