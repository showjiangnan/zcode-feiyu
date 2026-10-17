// Modified by ZCode Feiyu.
import {
  createChildTraceContext,
  runWithModelInvocationContext,
  type SessionEvent,
} from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import { createRuntimeModel } from "../methods/runtime-model.js";
import { createRefreshRuntimeHeadersBeforeModelAttempt } from "../methods/model-runtime-headers.js";
import { recordModelUsageFact } from "../methods/usage-observability.js";
import { resolveEnabledProjectMemoryRoot } from "../helpers/project-memory.js";
import { loadProjectMemoryIndexContent } from "../methods/context.js";
import { recallProjectMemoryTopicSet } from "../../memory/recall/relevant.js";
import {
  buildSuggestedPromptMessages,
  parseSuggestedPromptOutput,
  SUGGESTED_PROMPT_VERSION,
} from "./context.js";

const TIMEOUT_MS = 120_000;
const MAX_INPUT_CHARS = 32_000;
const MAX_OUTPUT_TOKENS = 5000;
const QUERY_SOURCE = "suggested_prompt";

export async function generateSuggestedPrompt(
  runtime: AgentRuntimeInternal,
  turnId: string,
  signal: AbortSignal,
): Promise<string | null> {
  const selection = runtime.config.suggestedPrompt?.modelSelection;
  if (!selection) throw new Error("suggested_prompt.model_missing");
  const base = createRuntimeModel(runtime, { selection, retryBudget: "single-attempt" });
  if (!base.properties.outputFormat.supportsText)
    throw new Error("suggested_prompt.text_model_required");
  const outputBudget = Math.min(
    MAX_OUTPUT_TOKENS,
    base.optionSpecs.maxOutputTokens.max,
    Math.floor(base.properties.contextWindow / 3),
  );
  // 用户显式选择的档位必须保留；auxiliaryModelOptions 会强制最低档，不能用于此处。
  const model = base.bind({ speed: "standard", maxOutputTokens: outputBudget });
  const abortSignal = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]);
  const traceContext = createChildTraceContext(runtime.rootTraceContext, {
    attributes: {
      querySource: QUERY_SOURCE,
      sourceTurnId: turnId,
      promptVersion: SUGGESTED_PROMPT_VERSION,
    },
  });
  const entries = runtime.messageHistory.toRuntimeEntries();
  const maxChars = Math.min(
    MAX_INPUT_CHARS,
    Math.floor((model.properties.contextWindow - outputBudget - 1200) * 0.6),
  );
  if (maxChars < 256) throw new Error("suggested_prompt.context_budget_too_small");
  const queryMessages = buildSuggestedPromptMessages(entries, undefined, maxChars);
  const root = resolveEnabledProjectMemoryRoot(runtime.config, runtime.workspaceRoot);
  let memory: string | undefined;
  if (root && runtime.fileSystemPort) {
    // 只读已提交记忆；不调用带 mkdir/recovery 副作用的 loadProjectMemoryRoot。
    const [index, topics] = await Promise.all([
      loadProjectMemoryIndexContent(runtime, root, { recordReadState: false }),
      recallProjectMemoryTopicSet({
        fileSystem: runtime.fileSystemPort,
        rootDir: root,
        query: String(queryMessages[1]!.content).slice(-6000),
        signal: abortSignal,
        maxSelected: 2,
        maxTopicChars: 1800,
        maxTotalChars: 3600,
      }),
    ]);
    // 索引可能远长于预测记忆预算；为相关主题保留空间，避免整段截断只留下索引。
    const memoryBudget = Math.floor(maxChars / 5);
    const indexText = index?.slice(0, topics.content ? Math.floor(memoryBudget / 2) : memoryBudget);
    const topicText = topics.content.slice(
      0,
      Math.max(0, memoryBudget - (indexText?.length ?? 0) - 2),
    );
    memory = [indexText, topicText].filter(Boolean).join("\n\n");
  }
  abortSignal.throwIfAborted();
  const events: SessionEvent[] = [];
  const startedAt = Date.now();
  const telemetry = runtime.agentTelemetry.detached({
    executionKind: "background",
    operation: "suggested_prompt_generation",
    targetKind: "session",
    trigger: "turn",
    traceContext,
  });
  return telemetry.run(async () => {
    let usageRecorded = false;
    try {
      const result = await runWithModelInvocationContext(
        {
          traceContext,
          modelCall: {
            operation: "suggested_prompt_generation",
            reasoning: { requestedLevel: model.options.reasoningLevel },
          },
          statusSink: runtime.createModelStatusSink(traceContext, events, { persist: false }),
          refreshRuntimeHeadersBeforeAttempt: createRefreshRuntimeHeadersBeforeModelAttempt(
            runtime,
            { abortSignal, model, traceContext },
          ),
        },
        () =>
          model.generateText({
            abortSignal,
            messages: buildSuggestedPromptMessages(entries, memory, maxChars),
            tools: [],
          }),
      );
      await recordModelUsageFact(runtime, {
        events,
        model,
        networkEventStartIndex: 0,
        querySource: QUERY_SOURCE,
        result,
        startedAt,
        status: "completed",
        traceContext,
      });
      usageRecorded = true;
      abortSignal.throwIfAborted();
      if (result.toolCalls?.length || result.finishReason === "length")
        throw new Error("suggested_prompt.invalid_output");
      const suggestion = parseSuggestedPromptOutput(result.text);
      telemetry.setResultType(suggestion ? "metadata" : "other");
      telemetry.finishCompleted();
      return suggestion;
    } catch (error) {
      if (!usageRecorded)
        await recordModelUsageFact(runtime, {
          error,
          events,
          model,
          networkEventStartIndex: 0,
          querySource: QUERY_SOURCE,
          startedAt,
          status: abortSignal.aborted ? "cancelled" : "error",
          traceContext,
        });
      telemetry.finishFailed("execute", abortSignal.aborted ? "cancelled" : "unknown", error);
      throw error;
    }
  });
}
