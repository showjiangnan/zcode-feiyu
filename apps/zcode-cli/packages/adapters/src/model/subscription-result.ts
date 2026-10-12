// Modified by ZCode Feiyu.
import type { ModelStreamEvent, ModelTextResult, ModelReasoningContentBlock } from "@zcode/contracts";

/** 内部非展示请求仍使用订阅要求的 SSE，完整收集真实 reasoning 和工具事实。 */
export async function collectSubscriptionResult(events: AsyncIterable<ModelStreamEvent>): Promise<ModelTextResult> {
  const result: ModelTextResult = { text:"", finishReason:"unknown", usage:{}, reasoning:[], toolCalls:[] };
  const reasoning = new Map<string, ModelReasoningContentBlock>();
  let finished = false;
  for await (const event of events) {
    if (event.type === "error") throw event.error;
    if (event.type === "text_delta") result.text += event.text;
    if (event.type === "tool_call") result.toolCalls!.push(event.toolCall);
    if (event.type === "reasoning_start" || event.type === "reasoning_delta" || event.type === "reasoning_end") {
      const id = event.id ?? "reasoning";
      const block: ModelReasoningContentBlock = reasoning.get(id) ?? {type:"reasoning",text:""};
      if (event.type === "reasoning_delta") block.text += event.text;
      if (event.providerMetadata) block.providerOptions = event.providerMetadata;
      reasoning.set(id, block);
    }
    if (event.type === "finish") {
      finished = true; result.finishReason = event.finishReason; result.usage = event.usage;
      result.providerMetadata = event.providerMetadata;
    }
  }
  if (!finished) throw new Error("subscription_stream_interrupted");
  result.reasoning = [...reasoning.values()];
  return result;
}
