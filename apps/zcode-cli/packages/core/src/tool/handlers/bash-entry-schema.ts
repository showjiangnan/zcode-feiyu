// Modified by ZCode Feiyu.
import { BashInputSchema, BashInputJsonSchema } from "@zcode/contracts";

import type { ToolEntry } from "../types.js";

import { resolveBashTimeoutMs, type BashTimeoutPolicy } from "../bash-timeout-policy.js";

// 按职责拆分；保留原始规则、执行顺序与状态所有者。

export function createBashTimeoutBudgetResolver(
  timeoutPolicy: BashTimeoutPolicy,
): NonNullable<ToolEntry["resolveTimeoutBudgetMs"]> {
  return (input) => {
    const parsed = BashInputSchema.safeParse(input);
    // 旧 watchdog 直接读取 raw timeout，导致 0 被压成 1ms，且字符串数字绕过
    // Bash policy。这里和 handler 共用 timeout || default / max 解析后再加 cleanup grace。
    return resolveBashTimeoutMs(parsed.success ? parsed.data.timeout : undefined, timeoutPolicy);
  };
}

export function createBashInputJsonSchema(
  timeoutPolicy: BashTimeoutPolicy,
): Record<string, unknown> {
  const schema = BashInputJsonSchema as Record<string, unknown>;
  const properties = schema.properties as Record<string, unknown> | undefined;
  const timeoutProperty = properties?.timeout as Record<string, unknown> | undefined;
  if (!properties || !timeoutProperty) return schema;

  return {
    ...schema,
    properties: {
      ...properties,
      timeout: {
        ...timeoutProperty,
        description: `Optional timeout in milliseconds (max ${timeoutPolicy.maxTimeoutMs})`,
      },
    },
  };
}
