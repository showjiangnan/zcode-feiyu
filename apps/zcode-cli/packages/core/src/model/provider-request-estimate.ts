// Modified by ZCode Feiyu contributors (2026).
import type { ModelRequest } from "@zcode/contracts";
import { estimateTokens } from "../context/utils.js";

/**
 * provider 实际能看到的请求内容。
 *
 * 工具契约里的 `outputSchema`、`permission`、`resultBudget` 等只在本地使用，adapter 不会发送；
 * 计入它们会让预留虚高（两个任务工具的 outputSchema 就可超过 40 万字符）。
 * 请求容量判断与未知用量观察共用这一口径，不能把本地契约误算为外发内容。
 */
export function providerVisibleRequestPayload(
  request: Pick<ModelRequest, "messages" | "tools" | "responseJsonSchema">,
) {
  return {
    messages: request.messages,
    tools: request.tools?.map(({ name, description, inputSchema, providerNative, strict }) => ({
      name,
      description,
      inputSchema,
      providerNative,
      strict,
    })),
    responseJsonSchema: request.responseJsonSchema,
  };
}

/** provider 可见请求内容的输入 token 估算；使用与上下文预算相同的估算函数，不以字节数代替 token。 */
export function estimateProviderRequestInputTokens(
  request: Pick<ModelRequest, "messages" | "tools" | "responseJsonSchema">,
): number {
  return estimateTokens(JSON.stringify(providerVisibleRequestPayload(request)));
}
