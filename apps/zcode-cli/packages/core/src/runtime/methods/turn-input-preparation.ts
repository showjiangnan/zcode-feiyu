// Modified by ZCode Feiyu.
import { runtimeInputMetadata } from "../../agent/runtime-input-presentation.js";
import { withConversationQuotes } from "../helpers/conversation-quotes.js";
import {
  HookEventName,
  SessionEventType,
  createModelUsageSummaryFromEvents,
  TurnMachineImpl,
} from "../deps.js";
import type { HookRunResult, MessagePart } from "../deps.js";
import {
  throwIfTurnAborted,
  buildRuntimeUserEntriesFromTurn,
  buildUserContentFromTurn,
  logResolvedTurnAttachments,
  resolveTurnAttachments,
  runtimeMetadataForSyntheticUserMessageSource,
} from "../helpers/index.js";
import type { TurnResult } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";

import { maybeStartSessionTitleGeneration } from "./session-title.js";

import { recordTurnUsageFact } from "./usage-observability.js";

import type { ActiveTurnExecutionContext } from "./turn-execution-state.js";
import {
  injectDateChangeReminderIntoMessageHistory,
  injectReferencedSessionContextReminderIntoMessageHistory,
} from "./turn-input-reminders.js";
export async function prepareTurnInput(
  this: AgentRuntimeInternal,
  context: ActiveTurnExecutionContext,
): Promise<TurnResult | undefined> {
  const {
    input,
    attachments,
    options,
    turnId,
    displayInput,
    turnTraceContext,
    traceId,
    turnStartedAtMs,
    targetRunInputID,
    events,
    turnAbortSignal,
    startTurnPhase,
    completeTurnPhase,
    state,
    activeTurn,
    userMessageId,
  } = context;
  let phaseStartedAt: number;

  phaseStartedAt = startTurnPhase("user_prompt_hooks");
  const userPromptHookResult: HookRunResult = options?.skipUserPromptSubmitHooks
    ? { additionalContexts: [] }
    : await this.runUserPromptSubmitHooks(input, attachments, turnTraceContext, turnAbortSignal);
  completeTurnPhase("user_prompt_hooks", phaseStartedAt);
  if (userPromptHookResult.preventContinuation) {
    const response = userPromptHookResult.stopReason ?? "Prompt blocked by UserPromptSubmit hook.";
    if (activeTurn) activeTurn.steerable = false;
    state.turnMachine = new TurnMachineImpl(state.turnMachine.complete(response, "success"));
    const turnUsage = createModelUsageSummaryFromEvents(events);
    const completeEvent = this.createEvent(
      SessionEventType.TurnComplete,
      {
        response,
        tokenCount: 0,
        usage: turnUsage,
        toolCallCount: 0,
        duration: Date.now() - state.turnMachine.state.startedAt.getTime(),
        resultType: "success",
        cacheStats: this.messageHistory.getCacheStats(),
        inputId: options?.inputId,
      },
      turnTraceContext,
    );
    await this.appendEvent(completeEvent, turnTraceContext);
    events.push(completeEvent);
    await recordTurnUsageFact(this, {
      completedAt: Date.now(),
      events,
      startedAt: turnStartedAtMs,
      status: "completed",
      traceContext: turnTraceContext,
      turnId,
    });
    this.turnNumber++;
    const projection = await this.rebuildProjection();
    await this.accountTargetTurnCompletion({
      inputID: targetRunInputID,
      startedAtMs: turnStartedAtMs,
      startedTarget: state.startedTarget,
      traceContext: turnTraceContext,
      usage: turnUsage,
    });
    return {
      response,
      turnId,
      traceId,
      usage: turnUsage,
      events,
      projection,
    };
  }
  this.injectHookAdditionalContextIntoMessageHistory(
    HookEventName.UserPromptSubmit,
    userPromptHookResult.additionalContexts,
  );
  injectReferencedSessionContextReminderIntoMessageHistory.call(this, input, options);
  // 话题原文由标准文本附件按需读取，可信来源归档不能再次生成隐藏上下文。
  injectDateChangeReminderIntoMessageHistory.call(this);
  const resolvedAttachments = await resolveTurnAttachments(attachments, {
    abortSignal: turnAbortSignal,
    artifactStore: this.artifactStore,
    fileSystemPort: this.fileSystemPort,
    imageProcessorPort: this.imageProcessorPort,
    sessionId: this.sessionId,
    traceContext: turnTraceContext,
    turnId,
    workingDirectory: this.workingDirectory,
  });
  logResolvedTurnAttachments(this.logger, turnTraceContext, resolvedAttachments);
  const sharedContextRefs = options?.sharedContextRefs ?? options?.intent?.sharedContextRefs;
  if (sharedContextRefs && sharedContextRefs.length > 0) {
    const [reference] = sharedContextRefs;
    if (!reference || reference.kind !== "shared_context_import") {
      throw new Error("invalid shared context reference");
    }
    if (!this.sessionStore) throw new Error("shared context import storage is unavailable");
    const alreadyHydrated = this.messageHistory
      .borrowReadOnlyRuntimeEntries()
      .some((entry) => entry.kind !== "attachment" && entry.metadata?.source === "shared_context");
    if (!alreadyHydrated) {
      const importedMessages = await this.sessionStore.messages({
        sessionID: this.sessionId,
      });
      const contextMessage = importedMessages.find(
        (message) =>
          message.info.role === "user" &&
          message.info.source === "shared_context" &&
          message.info.metadata &&
          typeof message.info.metadata === "object" &&
          (message.info.metadata as Record<string, unknown>).contextId === reference.context_id,
      );
      const contextText = contextMessage?.parts
        .filter((part): part is Extract<MessagePart, { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim();
      if (!contextText) throw new Error("shared context content is unavailable");
      this.messageHistory.addUser(
        contextText,
        runtimeMetadataForSyntheticUserMessageSource("shared_context"),
      );
    }
  }
  await this.persistPendingModelChangeTimeline(turnTraceContext);
  if (options?.skipInputRecord !== true && options?.inputVisibility === "model-only") {
    const inputSource = options.inputSource ?? "goal-continuation";
    const userContent = buildUserContentFromTurn(input, resolvedAttachments);
    this.messageHistory.addUser(
      userContent,
      runtimeInputMetadata(options.inputPresentation) ??
        runtimeMetadataForSyntheticUserMessageSource(inputSource),
    );
    // /goal 自动续跑是 runtime 注入给模型的内部 user-role 输入，
    // 不是用户在聊天里新发的一条消息。持久化时保留 raw 输入供恢复/排查使用，
    // 但用 model-only 语义阻止 UI-facing snapshot 把它渲染成用户气泡。
    await this.persistSyntheticUserNoticeForSession({
      messageID: userMessageId,
      metadata: {
        ...(options.targetId ? { targetId: options.targetId } : {}),
        ...(options.inputPresentation ? { inputPresentation: options.inputPresentation } : {}),
        visibility: "model-only",
      },
      sessionId: this.sessionId,
      source: inputSource,
      text: input,
      traceContext: turnTraceContext,
      visibility: "model-only",
    });
  } else if (options?.skipInputRecord !== true) {
    this.messageHistory.addEntries(
      buildRuntimeUserEntriesFromTurn(
        withConversationQuotes(
          input,
          options?.intent?.conversationQuotes,
          options?.intent?.botGroupSource,
        ),
        resolvedAttachments,
        {
          browserAmbientContext: options?.browserAmbientContext,
        },
      ).map((entry) => {
        const metadata = runtimeInputMetadata(options?.inputPresentation);
        return entry.kind !== "attachment" && metadata ? { ...entry, metadata } : entry;
      }),
    );
    // /init 和自定义 slash command 会把模型输入展开成较长的内部
    // prompt。模型可见的历史必须使用展开后的 input，但 UI 展示、会话标题和
    // 恢复快照只能展示用户真实提交的原始 query。
    await this.persistUserPrompt(
      userMessageId,
      displayInput,
      resolvedAttachments,
      turnTraceContext,
      {
        intent: options?.intent,
        inputPresentation: options?.inputPresentation,
        sessionInputId: options?.sessionInputId ?? options?.intent?.queueItemId,
        sourceCommandId: options?.inputId,
        ...(options?.epilogueStart === undefined ? {} : { epilogueStart: options.epilogueStart }),
      },
    );
  }
  // 配置读取曾早于输入展示/持久化，失败会让已发送消息从界面消失。
  // 在原有输入记录后固定本轮定义，错误/取消复用本层收尾，且不启动标题或模型请求。
  await this.prepareAgentDefinitions({
    signal: turnAbortSignal,
    traceContext: turnTraceContext,
  });
  throwIfTurnAborted(turnAbortSignal);
  if (options?.skipInputRecord !== true && options?.inputVisibility !== "model-only") {
    // 修复原因：标题生成以前等主 turn 成功后才启动，用户 stop/cancel 首轮请求时
    // generated title 永远没有机会发起。首条 query 持久化后即可异步生成，避免被主链路取消拖死。
    const titleGenerationStarted = maybeStartSessionTitleGeneration.call(
      this,
      displayInput,
      userMessageId,
      turnTraceContext,
      {
        deferIfProviderRuntimeHeadersRefresh: true,
      },
    );
    state.shouldRetryTitleGenerationAfterTurn = !titleGenerationStarted;
  }
  // Plugin reminder 必须在对应 user 消息写入历史和 session store 后再追加：
  // provider 形态因此稳定为 user → system，cold hydration 也按同一因果顺序恢复。
  // 根因：input 可能已经被自定义命令展开，解析它会让命令模板里的 plugin://
  // 凭空获得“用户引用”语义；这里只解析真实持久化的 canonical displayInput。
  // runtime 内部的 model-only continuation 不代表新的用户意图，不重复解析。
  if (options?.inputVisibility !== "model-only") {
    await this.injectPluginReferenceReminderFromTurn(
      displayInput,
      turnTraceContext,
      options?.toolDisallowlist,
    );
  }

  return undefined;
}
