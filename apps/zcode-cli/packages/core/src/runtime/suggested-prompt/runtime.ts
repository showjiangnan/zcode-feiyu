// Modified by ZCode Feiyu.
import {
  SUGGESTED_PROMPT_ENTRY_TYPE,
  type SuggestedPromptSettings,
  type SuggestedPromptState,
} from "@zcode/shared";
import { SessionEventType } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import { SuggestedPromptController } from "./controller.js";
import { generateSuggestedPrompt } from "./generate.js";

const owners = new WeakMap<AgentRuntimeInternal, SuggestedPromptController>();

function available(runtime: AgentRuntimeInternal): boolean {
  const preferences = runtime.config.suggestedPrompt;
  const selection = preferences?.modelSelection;
  if (
    !preferences?.enabled ||
    !selection?.options?.reasoningLevel ||
    ![undefined, "interactive", "fork", "selection_side_chat"].includes(runtime.config.taskType)
  )
    return false;
  const model = runtime.modelCatalogPort
    ?.listModels()
    .find(
      (entry) => entry.providerId === selection.providerId && entry.modelId === selection.modelId,
    );
  return Boolean(
    model &&
    !model.disabledReason &&
    model.reasoningLevels.includes(selection.options.reasoningLevel),
  );
}

function owner(runtime: AgentRuntimeInternal): SuggestedPromptController {
  let current = owners.get(runtime);
  if (current) return current;
  current = new SuggestedPromptController(runtime.config.suggestedPromptEnabled === true, {
    available: () => available(runtime),
    idle: () =>
      !runtime.shuttingDown &&
      !runtime.hasActiveOrQueuedTurnWork() &&
      !runtime.hasRunningBackgroundTasks(),
    persist: (enabled) => persistSuggestedPromptConsent(runtime, enabled),
    publish: async (state) => {
      await runtime.appendEvent(
        runtime.createEvent(
          SessionEventType.SuggestedPromptChanged,
          state,
          runtime.rootTraceContext,
        ),
        runtime.rootTraceContext,
      );
    },
    generate: (turnId, signal) =>
      runtime.trackResidencyBlockingWork(generateSuggestedPrompt(runtime, turnId, signal)),
    onError: () =>
      runtime.logger?.warn("Suggested prompt generation unavailable", {
        event: "suggested_prompt.failed",
      }),
  });
  owners.set(runtime, current);
  return current;
}

export function getSuggestedPromptState(this: AgentRuntimeInternal): SuggestedPromptState {
  return owner(this).getState();
}

export async function setSuggestedPromptEnabled(
  this: AgentRuntimeInternal,
  enabled: boolean,
): Promise<void> {
  await owner(this).setEnabled(enabled);
}

export async function updateSuggestedPromptPreferences(
  runtime: AgentRuntimeInternal,
  preferences?: SuggestedPromptSettings,
): Promise<void> {
  const next = preferences ?? { enabled: false };
  if (JSON.stringify(runtime.config.suggestedPrompt ?? { enabled: false }) === JSON.stringify(next))
    return;
  runtime.config.suggestedPrompt = next;
  const current = owners.get(runtime);
  current?.invalidate();
  await current?.settle();
}

export function invalidateSuggestedPrompt(runtime: AgentRuntimeInternal): void {
  owners.get(runtime)?.invalidate();
}

export async function settleSuggestedPrompt(runtime: AgentRuntimeInternal): Promise<void> {
  await owners.get(runtime)?.settle();
}

export function completeSuggestedPromptTurn(runtime: AgentRuntimeInternal, turnId: string): void {
  owner(runtime).completed(turnId);
}

export function startPendingSuggestedPrompt(runtime: AgentRuntimeInternal): void {
  owners.get(runtime)?.tryStart();
}

export async function persistSuggestedPromptConsent(
  runtime: AgentRuntimeInternal,
  enabled = owner(runtime).getState().enabled,
): Promise<void> {
  if (!runtime.sessionPersisted) return;
  if (!runtime.sessionStore?.saveSessionEntry) {
    if (enabled) throw new Error("suggested_prompt.persistence_unavailable");
    return;
  }
  const now = Date.now();
  await runtime.sessionStore.saveSessionEntry({
    id: `${runtime.sessionId}:suggested-prompt-consent`,
    sessionID: runtime.sessionId,
    type: SUGGESTED_PROMPT_ENTRY_TYPE,
    touchSession: false,
    time: { created: now, updated: now },
    data: { enabled },
  });
}
