// Modified by ZCode Feiyu.
import type {
  SessionEvent,
  WorkspaceHookReviewRequestedPayload,
  WorkspaceHookReviewSettledPayload,
  WorkspaceHookReviewSupersededPayload,
  WorkspaceHookAdmissionUpdatedPayload,
  UserInputAutoResolutionUpdatedPayload,
} from "@zcode/contracts";
import type {
  ConversationDelta,
  PendingInteraction,
  ToolCallRow,
} from "@zcode/shared/zcode-protocol-v4";
import { workspaceHookReviewRequestPayloadSchema } from "@zcode/shared/zcode-protocol-v4";
import { verdictWorkspaceHookReviewRequest } from "@zcode/shared/workspace-hook-review-monotonicity";
import type { ProductProjection } from "./product-projection.js";

export function onWorkspaceHookReviewRequested(
  this: ProductProjection,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as WorkspaceHookReviewRequestedPayload;
  const request = workspaceHookReviewRequestPayloadSchema.parse(payload.request);
  const current = this["snapshot"].pendingInteractions.find(
    (item) => item.payload.kind === "workspaceHookReview",
  );
  if (current?.payload.kind === "workspaceHookReview") {
    const verdict = verdictWorkspaceHookReviewRequest(current.payload, request);
    // 跨 flow 只能在 onSessionResumed 已清空旧 review 后接管（epoch 应用策略在
    // onSessionResumed）；其余 stale/replay/conflict 均不得覆盖或延长当前 authority。
    if (verdict !== "same_flow_advance") {
      return [];
    }
  }
  const interaction: PendingInteraction = {
    interactionId: request.interactionId,
    kind: "workspaceHookReview",
    anchorRowId: null,
    createdAt: request.createdAt,
    payload: request,
  };
  // 同 flow 的更高 generation 是唯一合法替换；Runtime 重启的跨 flow 接管必须先经过
  // SessionResumed 清旧 authority。这里仍原子替换，避免历史异常状态残留多个 review。
  const pendingInteractions = this["snapshot"].pendingInteractions.filter(
    (item) => item.payload.kind !== "workspaceHookReview",
  );
  pendingInteractions.push(interaction);
  return [{ op: "state.updated", patch: { pendingInteractions } }];
}

export function onWorkspaceHookReviewSettled(
  this: ProductProjection,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as WorkspaceHookReviewSettledPayload;
  return this["removeWorkspaceHookReview"](payload.interactionId);
}

export function onWorkspaceHookReviewSuperseded(
  this: ProductProjection,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as WorkspaceHookReviewSupersededPayload;
  return this["removeWorkspaceHookReview"](payload.interactionId);
}

export function removeWorkspaceHookReview(
  this: ProductProjection,
  interactionId: string,
): ConversationDelta[] {
  const pendingInteractions = this["snapshot"].pendingInteractions.filter(
    (item) =>
      !(item.payload.kind === "workspaceHookReview" && item.interactionId === interactionId),
  );
  return pendingInteractions.length === this["snapshot"].pendingInteractions.length
    ? []
    : [{ op: "state.updated", patch: { pendingInteractions } }];
}

export function onWorkspaceHookAdmissionUpdated(
  this: ProductProjection,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as WorkspaceHookAdmissionUpdatedPayload;
  const workspaceHookAdmission =
    payload.pendingCount === 0
      ? null
      : {
          pendingCount: payload.pendingCount,
          bundleDigest: payload.bundleDigest,
          ...(payload.workspaceIdentity ? { workspaceIdentity: payload.workspaceIdentity } : {}),
        };
  return [{ op: "state.updated", patch: { workspaceHookAdmission } }];
}

export function onUserInputAutoResolutionUpdated(
  this: ProductProjection,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as UserInputAutoResolutionUpdatedPayload;
  let changed = false;
  const pendingInteractions = this["snapshot"].pendingInteractions.map((interaction) => {
    if (
      interaction.interactionId !== payload.interactionId ||
      interaction.payload.kind !== "userInput"
    ) {
      return interaction;
    }
    changed = true;
    return {
      ...interaction,
      autoResolution: payload.autoResolution,
    };
  });
  return changed ? [{ op: "state.updated", patch: { pendingInteractions } }] : [];
}

export function settlePermission(
  this: ProductProjection,
  toolCallId: string,
  status: ToolCallRow["status"],
): ConversationDelta[] {
  const deltas: ConversationDelta[] = [];
  const row = this["findToolRow"](toolCallId);
  if (row) {
    const next: ToolCallRow = { ...row, status };
    delete next.approvalInteractionId;
    deltas.push({ op: "row.upserted", row: next });
  }
  const remaining = this["snapshot"].pendingInteractions.filter(
    (item) =>
      !(
        (item.payload.kind === "permission" || item.payload.kind === "userInput") &&
        item.payload.toolCallId === toolCallId
      ),
  );
  if (remaining.length !== this["snapshot"].pendingInteractions.length) {
    deltas.push({
      op: "state.updated",
      patch: { pendingInteractions: remaining },
    });
  }
  return deltas;
}
