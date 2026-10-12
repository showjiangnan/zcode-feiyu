// Modified by ZCode Feiyu.
import type { SessionEvent } from "@zcode/contracts";
import type { ConversationDelta } from "@zcode/shared/zcode-protocol-v4";
import { orchestrationStateSchema, teamBoardStateSchema } from "@zcode/shared/zcode-protocol-v4";
import type { ProductProjection } from "./product-projection.js";

export function onSessionModeChanged(
  this: ProductProjection,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as {
    mode?: string;
    planEnabled?: boolean;
    source?: string;
    toolCallId?: string;
    permissionGrant?: {
      interactionId: string;
      queueItemIds: string[];
    };
  };
  const mode = typeof payload.mode === "string" ? payload.mode : "";
  // 日志事件触碰过 mode 后，种子不再覆盖（同值 return 也算触碰——日志有权威值）。
  if (mode) this["configModeTouchedByEvent"] = true;
  if (!mode) return [];
  const planEnabled = payload.planEnabled ?? mode === "plan";
  const planTransition =
    payload.source === "tool" && payload.toolCallId
      ? { toolCallId: payload.toolCallId, planEnabled }
      : this["snapshot"].config.planTransition;
  if (
    this["snapshot"].config.mode === mode &&
    this["snapshot"].config.planEnabled === planEnabled &&
    planTransition === this["snapshot"].config.planTransition &&
    !payload.permissionGrant
  )
    return [];
  return [
    {
      op: "state.updated",
      patch: {
        ...(payload.permissionGrant
          ? this["queuePatch"]({
              ...this["snapshot"].queue,
              items: this["snapshot"].queue.items.map((item) =>
                payload.permissionGrant!.queueItemIds.includes(item.queueItemId)
                  ? { ...item, mode: "yolo" as const }
                  : item,
              ),
            })
          : {}),
        config: {
          ...this["snapshot"].config,
          mode,
          planEnabled,
          planTransition,
          ...(payload.permissionGrant
            ? { permissionGrant: { interactionId: payload.permissionGrant.interactionId } }
            : {}),
        },
      },
    },
  ];
}

export function onSessionOrchestrationChanged(
  this: ProductProjection,
  event: SessionEvent,
): ConversationDelta[] {
  const parsed = orchestrationStateSchema.safeParse(event.payload);
  if (!parsed.success) return [];
  this["configOrchestrationTouchedByEvent"] = true;
  const current = this["snapshot"].config.orchestration;
  if (parsed.data.revision <= current.revision) return [];
  return [
    {
      op: "state.updated",
      patch: {
        config: { ...this["snapshot"].config, orchestration: parsed.data },
      },
    },
  ];
}

export function onTeamBoardChanged(
  this: ProductProjection,
  event: SessionEvent,
): ConversationDelta[] {
  const parsed = teamBoardStateSchema.safeParse(event.payload);
  if (!parsed.success || parsed.data.revision <= this["snapshot"].teamBoard.revision) return [];
  return [{ op: "state.updated", patch: { teamBoard: parsed.data } }];
}

export function shouldMaterializeSubagentProjection(
  this: ProductProjection,
  reduced: readonly ConversationDelta[],
): boolean {
  // 性能问题根因：cold hydration 曾让 checkpoint 等无关事件也扫描全部历史 rows。
  // 这里只在尚未发布的 batch accumulator 内按 materializer 的真实输入准入；live 与
  // strict fallback 仍走原路径，batch 之后直接写权威 manifest 的 store seed 不受影响。
  if (!this["hydrationAccumulator"]) return true;
  for (const delta of reduced) {
    switch (delta.op) {
      case "row.appended":
      case "row.upserted":
        if (
          delta.row.kind === "subagent" ||
          this["findRow"](delta.row.rowId)?.kind === "subagent"
        ) {
          return true;
        }
        break;
      case "row.delta":
        if (this["findRow"](delta.rowId)?.kind === "subagent") return true;
        break;
      case "row.removed":
        // 后缀删除可能同时移除 subagent row；不为判定再预扫描一次 rows。
        return true;
      case "state.updated":
        if (
          delta.patch.pendingInteractions !== undefined ||
          delta.patch.backgroundWorks !== undefined
        ) {
          return true;
        }
        break;
      case "pluginUi.resourceUpdated":
      case "pluginUi.resourceListChanged":
      case "pluginUi.instanceClosed":
      case "pluginUi.appToolCall":
      // 非行 op：只动 workflowRuns 状态键，与 subagent 行投影的输入没有交集。
      case "workflowRun.updated":
      case "workflowRun.removed":
        break;
      default: {
        const exhaustiveDelta: never = delta;
        return exhaustiveDelta;
      }
    }
  }
  return false;
}
