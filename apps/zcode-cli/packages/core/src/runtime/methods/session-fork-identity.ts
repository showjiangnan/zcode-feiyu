// Modified by ZCode Feiyu.
import { randomUUID } from "node:crypto";
import { isHighspeedProviderId } from "@zcode/shared";
import { type CreateSessionInput } from "@zcode/contracts";
import {
  SESSION_ENTRY_MODEL_SELECTION,
  createMessageId,
  createPartId,
  createToolCallId,
  createTurnId,
} from "../deps.js";
import type {
  MessageId,
  PartId,
  SessionEntryInfo,
  SessionGoal,
  TargetCompletionVerificationPayload,
  MessageWithParts,
  SessionId,
  SessionInfo,
  TurnId,
} from "../deps.js";
import { slugify } from "../helpers/index.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { StableConversationForkGoalBoundary } from "../types.js";
import { cloneModelSelection } from "../model-selection.js";
import type { ModelSelection } from "@zcode/contracts";
import { asRecord } from "./session-fork-history.js";
import { stableForkError } from "./session-fork-error.js";

export const MODEL_SELECTION_ENTRY_SUFFIX = ":runtime-model-selection";

export function modelSelectionFromMessage(message: MessageWithParts): ModelSelection | undefined {
  const selection = persistedModelSelectionOfMessage(message);
  // 加速卡 Selection 是 `selectionScope=execution` 的单轮执行事实（highspeed-card-spec §5），
  // 只有与同一轮 requestAuth 成对才有效。child 继承它会常驻在无凭据的加速 Provider 上：
  // 用户看到「分叉后原模型没带过来」，子会话首轮还会以 ModelRequestAuthMissing 失败。
  // 因此跳过该消息，继续向前找最近一次普通选型，最终回落 runtime 常驻 Selection。
  return selection && isHighspeedProviderId(selection.providerId) ? undefined : selection;
}

export function persistedModelSelectionOfMessage(
  message: MessageWithParts,
): ModelSelection | undefined {
  if (message.info.role === "user") {
    return message.info.modelSelection && cloneModelSelection(message.info.modelSelection);
  }
  if (!message.info.modelId || !message.info.providerId) return undefined;
  return {
    modelId: message.info.modelId,
    providerId: message.info.providerId,
    ...(message.info.reasoningLevel
      ? { options: { reasoningLevel: message.info.reasoningLevel } }
      : {}),
  };
}

export function resolveForkModelSelection(
  runtime: AgentRuntimeInternal,
  messages: readonly MessageWithParts[],
  explicit?: ModelSelection,
): ModelSelection | undefined {
  // 加速 Provider 不能成为 child 的常驻 Selection（理由见 modelSelectionFromMessage），
  // 调用方显式传入时同样跳过，回落历史普通选型 / runtime 常驻 Selection。
  if (explicit && !isHighspeedProviderId(explicit.providerId)) return cloneModelSelection(explicit);
  const historical = [...messages].reverse().map(modelSelectionFromMessage).find(Boolean);
  const runtimeSelection = runtime.getSessionModelSelection();
  const identity = historical ?? runtimeSelection;
  if (!identity) return undefined;
  const historicalOptions = historical?.options;
  const reasoningLevel =
    historicalOptions?.reasoningLevel ?? runtimeSelection?.options?.reasoningLevel;
  return {
    modelId: identity.modelId,
    providerId: identity.providerId,
    ...(reasoningLevel !== undefined
      ? {
          options: reasoningLevel !== undefined ? { reasoningLevel } : {},
        }
      : {}),
  };
}

export function buildModelSelectionEntry(
  childSessionId: SessionId,
  modelSelection: ModelSelection | undefined,
): SessionEntryInfo {
  const timestamp = Date.now();
  return {
    id: `${childSessionId}${MODEL_SELECTION_ENTRY_SUFFIX}`,
    sessionID: childSessionId,
    type: SESSION_ENTRY_MODEL_SELECTION,
    touchSession: false,
    time: { created: timestamp, updated: timestamp },
    data: modelSelection ? cloneModelSelection(modelSelection) : null,
  };
}

/** stable/compact-edit fork 一次性预分配的完整 child-local 身份。 */
export interface ForkIdentityMap {
  parentSessionId: SessionId;
  childSessionId: SessionId;
  messageIds: Map<MessageId, MessageId>;
  partIds: Map<PartId, PartId>;
  turnIds: Map<string, string>;
  productTurnIds: Map<string, string>;
  targetIds: Map<string, string>;
  verifierEntryIds: Map<string, string>;
  verificationIds: Map<string, string>;
  toolCallIds: Map<string, string>;
  notice: {
    hiddenMessageId: MessageId;
    hiddenPartId: PartId;
    messageId: MessageId;
    partId: PartId;
    turnId: TurnId;
    productTurnId: string;
  };
}

export function buildForkedSessionInput(
  runtime: AgentRuntimeInternal,
  parentSession: SessionInfo,
  forkedSessionId: SessionId,
  kind: "fork" | "selection_side_chat" = "fork",
): CreateSessionInput {
  const now = Date.now();
  return {
    id: forkedSessionId,
    projectID: parentSession.projectID,
    workspaceID: parentSession.workspaceID,
    parentID: runtime.sessionId,
    traceID: runtime.rootTraceContext.traceId,
    taskType: kind,
    slug: `${slugify(parentSession.slug)}-${kind}-${now.toString(36)}`.slice(0, 120),
    directory: parentSession.directory,
    path: parentSession.path,
    title:
      kind === "selection_side_chat" ? "Selection side chat" : `Fork of ${parentSession.title}`,
    titleSource: "generated",
    version: parentSession.version,
    permission: parentSession.permission,
    time: {
      created: now,
      updated: now,
    },
  };
}

export function collectForkGoalSnapshots(
  messages: readonly MessageWithParts[],
  boundary: StableConversationForkGoalBoundary,
): SessionGoal[] {
  const byId = new Map<string, SessionGoal>();
  for (const message of messages) {
    const goalBoundary = message.info.anchor?.goalBoundary;
    if (goalBoundary?.kind === "snapshot") {
      byId.set(goalBoundary.target.targetID, goalBoundary.target);
    }
  }
  if (boundary.kind === "snapshot") byId.set(boundary.target.targetID, boundary.target);
  return [...byId.values()];
}

export function collectVerifierEntryIds(
  messages: readonly MessageWithParts[],
  boundary: StableConversationForkGoalBoundary,
): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    const goalBoundary = message.info.anchor?.goalBoundary;
    if (goalBoundary?.kind === "snapshot") {
      for (const id of goalBoundary.verificationEntryIds) ids.add(id);
    }
  }
  if (boundary.kind === "snapshot") {
    for (const id of boundary.verificationEntryIds) ids.add(id);
  }
  return ids;
}

export function createForkIdentityMap(options: {
  childSessionId: SessionId;
  entries: readonly SessionEntryInfo[];
  goalSnapshots: readonly SessionGoal[];
  messages: readonly MessageWithParts[];
  parentSessionId: SessionId;
}): ForkIdentityMap {
  const messageIds = new Map<MessageId, MessageId>();
  const partIds = new Map<PartId, PartId>();
  const turnIds = new Map<string, string>();
  const productTurnIds = new Map<string, string>();
  const targetIds = new Map<string, string>();
  const verifierEntryIds = new Map<string, string>();
  const verificationIds = new Map<string, string>();
  const toolCallIds = new Map<string, string>();
  const noticeHiddenMessageId = createMessageId();
  const notice = {
    hiddenMessageId: noticeHiddenMessageId,
    hiddenPartId: createPartId(),
    messageId: createMessageId(),
    partId: createPartId(),
    turnId: createTurnId(),
    productTurnId: String(noticeHiddenMessageId),
  };
  const addTurn = (id: unknown) => {
    if (typeof id === "string" && id && !turnIds.has(id)) {
      turnIds.set(id, String(createTurnId()));
    }
  };
  const addProductTurn = (id: unknown) => {
    if (typeof id !== "string" || !id || productTurnIds.has(id)) return;
    const messageId = messageIds.get(id as MessageId);
    productTurnIds.set(id, String(messageId ?? createTurnId()));
  };

  for (const message of options.messages) {
    messageIds.set(message.info.id, createMessageId());
    for (const part of message.parts) {
      partIds.set(part.id, createPartId());
      if (part.type === "tool") {
        toolCallIds.set(part.callID, String(createToolCallId()));
        if (part.state.status === "completed") {
          for (const attachment of part.state.attachments ?? []) {
            partIds.set(attachment.id, createPartId());
          }
        }
      }
    }
  }
  for (const message of options.messages) {
    addTurn(message.info.anchor?.turnId);
    addProductTurn(message.info.anchor?.productTurnId);
    for (const part of message.parts) {
      if (part.type === "timeline") {
        addTurn(part.anchorTurnId);
        if (part.timelineType === "goal_verification") {
          if (!targetIds.has(part.targetId)) {
            targetIds.set(part.targetId, `fork_target_${randomUUID()}`);
          }
          if (!verificationIds.has(part.verificationId)) {
            verificationIds.set(part.verificationId, `fork_verify_${randomUUID()}`);
          }
        }
      }
      if (part.type === "compaction") addTurn(part.compactBoundary?.turnId);
    }
  }
  for (const goal of options.goalSnapshots) {
    if (!targetIds.has(goal.targetID)) {
      targetIds.set(goal.targetID, `fork_target_${randomUUID()}`);
    }
  }
  for (const entry of options.entries) {
    verifierEntryIds.set(entry.id, `fork_goal_verify_${randomUUID()}`);
    const payload = asRecord(asRecord(entry.data).payload);
    if (
      typeof payload.verificationId === "string" &&
      !verificationIds.has(payload.verificationId)
    ) {
      verificationIds.set(payload.verificationId, `fork_verify_${randomUUID()}`);
    }
    addTurn(payload.anchorTurnId);
  }
  return {
    parentSessionId: options.parentSessionId,
    childSessionId: options.childSessionId,
    messageIds,
    partIds,
    turnIds,
    productTurnIds,
    targetIds,
    verifierEntryIds,
    verificationIds,
    toolCallIds,
    notice,
  };
}

export function mapForkIdentity(
  map: ReadonlyMap<string, string>,
  id: string,
  field: string,
): string {
  const mapped = map.get(id);
  if (!mapped) throw stableForkError(`Stable fork cannot remap ${field}`, { id });
  return mapped;
}

export function remapGoalForFork(goal: SessionGoal, identities: ForkIdentityMap): SessionGoal {
  return {
    ...goal,
    sessionID: identities.childSessionId,
    targetID: mapForkIdentity(identities.targetIds, goal.targetID, "goal target"),
    activeInputId: null,
    activeRunStartedAtMs: null,
    activeRunLastSeenAtMs: null,
  };
}

export function cloneVerifierEntryForAtomicFork(
  entry: SessionEntryInfo,
  identities: ForkIdentityMap,
): { entry: SessionEntryInfo; payload: TargetCompletionVerificationPayload } {
  const data = asRecord(entry.data);
  const payload = asRecord(data.payload);
  if (typeof payload.targetId !== "string" || typeof payload.verificationId !== "string") {
    throw stableForkError("Stable fork verifier entry has invalid identity", { entryId: entry.id });
  }
  const clonedPayload: Record<string, unknown> = {
    ...payload,
    targetId: mapForkIdentity(identities.targetIds, payload.targetId, "verifier target"),
    verificationId: mapForkIdentity(
      identities.verificationIds,
      payload.verificationId,
      "verification id",
    ),
  };
  if (typeof payload.anchorAssistantMessageId === "string") {
    clonedPayload.anchorAssistantMessageId = mapForkIdentity(
      identities.messageIds,
      payload.anchorAssistantMessageId,
      "verifier assistant anchor",
    );
  }
  if (typeof payload.anchorTurnId === "string") {
    clonedPayload.anchorTurnId = mapForkIdentity(
      identities.turnIds,
      payload.anchorTurnId,
      "verifier turn anchor",
    );
  }
  const nextEntryId = mapForkIdentity(identities.verifierEntryIds, entry.id, "verifier entry");
  const nextPayload = clonedPayload as unknown as TargetCompletionVerificationPayload;
  return {
    entry: {
      ...entry,
      id: nextEntryId,
      sessionID: identities.childSessionId,
      data: {
        ...data,
        eventId: randomUUID(),
        payload: nextPayload,
        forkOrigin: {
          entryId: entry.id,
          eventId: data.eventId,
          verificationId: payload.verificationId,
        },
      },
    },
    payload: nextPayload,
  };
}
