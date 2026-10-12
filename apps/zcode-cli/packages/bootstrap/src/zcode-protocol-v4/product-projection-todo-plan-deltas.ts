// Modified by ZCode Feiyu.
import type {
  SessionEvent,
  ToolCallErrorPayload,
  PermissionRequestedPayload,
} from "@zcode/contracts";
import { extractPlanStepsFromToolInput } from "@zcode/shared";
import type { ConversationDelta } from "@zcode/shared/zcode-protocol-v4";
import { CoreErrorType } from "@zcode/contracts";
import type { ProductProjection } from "./product-projection.js";

export function todoPlanDeltas(
  this: ProductProjection,
  event: SessionEvent,
  steps: ReturnType<typeof extractPlanStepsFromToolInput>,
): ConversationDelta[] {
  if (!steps) return [];
  const items = steps.map((step, index) => ({
    id: step.id || `todo-${index + 1}`,
    content: step.title,
    status:
      step.status === "in_progress"
        ? ("inProgress" as const)
        : step.status === "completed"
          ? ("completed" as const)
          : ("pending" as const),
  }));
  const updatedAt = this["ms"](event);
  const goal = this["snapshot"].goal;
  if (!goal) {
    return [{ op: "state.updated", patch: { plan: { items, updatedAt } } }];
  }
  const iteration =
    goal.status === "verifying" || goal.status === "verified" || goal.status === "failed"
      ? Math.max(1, goal.iteration)
      : Math.max(1, goal.iteration + 1);
  const iterations = [
    ...goal.iterations.filter((entry) => entry.iteration !== iteration),
    { iteration, items, updatedAt },
  ].sort((left, right) => left.iteration - right.iteration);
  return [
    {
      op: "state.updated",
      patch: {
        goal: { ...goal, iterations },
        plan: { items, updatedAt },
      },
    },
  ];
}

export function onToolCallError(this: ProductProjection, event: SessionEvent): ConversationDelta[] {
  if (this["isMirroredSubagentToolEvent"](event) || !this["isRunning"]()) return [];
  const payload = event.payload as ToolCallErrorPayload;
  this["recordHighspeedToolEnded"](
    this["turnIdOf"](event),
    String(payload.toolCallId),
    this["ms"](event),
  );
  const row = this["findToolRow"](String(payload.toolCallId));
  if (!row) return [];
  const cancelled =
    payload.error.type === CoreErrorType.ToolCancelled || payload.error.code === "TOOL_CANCELLED";
  return [
    {
      op: "row.upserted",
      row: {
        ...row,
        // Stop 会先产生 tool_cancelled，再产生 cancelled turn；若先把工具
        // 终态写成 error，后续只收口 running row 的 turn reducer 无法纠正为 stopped。
        status: cancelled ? "cancelled" : "error",
        progress: undefined,
        ...(cancelled
          ? { error: undefined }
          : { error: { code: payload.error.type, message: payload.error.message } }),
        endedAt: this["ms"](event),
      },
    },
  ];
}

export function onPermissionRequested(
  this: ProductProjection,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as PermissionRequestedPayload;
  const toolCallId = String(payload.toolCallId);
  const interactionId = payload.requestId ?? `perm-${toolCallId}`;
  const interaction = this["createPendingInteractionFromPermissionEvent"](
    event,
    payload,
    toolCallId,
    interactionId,
  );
  const deltas: ConversationDelta[] = [];
  const row = this["findToolRow"](toolCallId);
  if (row) {
    deltas.push({
      op: "row.upserted",
      row: {
        ...row,
        status: "pendingApproval",
        approvalInteractionId: interactionId,
      },
    });
  }
  deltas.push({
    op: "state.updated",
    patch: {
      pendingInteractions: [...this["snapshot"].pendingInteractions, interaction],
    },
  });
  return deltas;
}
