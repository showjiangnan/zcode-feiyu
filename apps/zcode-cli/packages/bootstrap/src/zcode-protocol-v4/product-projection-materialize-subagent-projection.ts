// Modified by ZCode Feiyu.
import type {
  ConversationDelta,
  SubagentProjectionState,
  SubagentRow,
  ConversationRow,
  RunningSubagentSummary,
} from "@zcode/shared/zcode-protocol-v4";
import type { ProductProjection } from "./product-projection.js";

export function materializeSubagentProjection(
  this: ProductProjection,
  reduced: readonly ConversationDelta[],
): ConversationDelta[] {
  const previous: SubagentProjectionState = this["snapshot"].subagents ?? {
    revision: 0,
    childSessionIds: [],
    running: [],
    endedTotal: 0,
  };
  const previousRunningById = new Map(previous.running.map((item) => [item.childSessionId, item]));
  const latestRowByChildId = new Map<string, SubagentRow>();
  const collectSubagentRow = (row: SubagentRow | null): void => {
    if (row?.childSessionId && !this["invalidSubagentChildSessionIds"].has(row.childSessionId)) {
      latestRowByChildId.set(row.childSessionId, row);
    }
  };
  // 性能问题根因：旧实现先复制完整 rows 数组，再扫描所有普通 conversation rows。
  // subagentRowIdByAgentId 已是 reducer 查找用的派生索引；这里按 rowId 去重，并通过
  // rowIndexById 恢复当前时间线顺序；row.removed 应用后会清理已失效的 alias。
  const currentRowIds = new Set(this["subagentRowIdByAgentId"].values());
  for (const delta of reduced) {
    if (delta.op === "row.upserted") {
      if (delta.row.kind === "subagent" || this["findRow"](delta.row.rowId)?.kind === "subagent") {
        currentRowIds.add(delta.row.rowId);
      }
    } else if (delta.op === "row.delta" && this["findRow"](delta.rowId)?.kind === "subagent") {
      currentRowIds.add(delta.rowId);
    }
  }
  const currentRows: Array<{
    rowIndex: number;
    row: ConversationRow;
  }> = [];
  for (const rowId of currentRowIds) {
    const rowIndex = this["rowIndexById"].get(rowId);
    const row = rowIndex === undefined ? undefined : this["snapshot"].rows.window[rowIndex];
    if (rowIndex !== undefined && row !== undefined) currentRows.push({ rowIndex, row });
  }
  currentRows.sort((left, right) => left.rowIndex - right.rowIndex);
  for (const { row } of currentRows) {
    collectSubagentRow(this["prospectiveSubagentRow"](row, reduced, 0));
  }
  for (let index = 0; index < reduced.length; index += 1) {
    const delta = reduced[index]!;
    if (delta.op !== "row.appended") continue;
    collectSubagentRow(this["prospectiveSubagentRow"](delta.row, reduced, index + 1));
  }
  let pendingInteractions = this["snapshot"].pendingInteractions;
  let backgroundWorks = this["snapshot"].backgroundWorks;
  for (const delta of reduced) {
    if (delta.op !== "state.updated") continue;
    if (delta.patch.pendingInteractions !== undefined) {
      pendingInteractions = delta.patch.pendingInteractions;
    }
    if (delta.patch.backgroundWorks !== undefined) {
      backgroundWorks = delta.patch.backgroundWorks;
    }
  }
  const waitingChildIds = new Set<string>();
  // workspace-hook-trust 新增的 hook review 交互 payload 没有 origin 字段，跳过守卫避免误读。
  for (const interaction of pendingInteractions) {
    if (!("origin" in interaction.payload)) continue;
    const origin = interaction.payload.origin;
    if (origin?.kind === "subagent") waitingChildIds.add(origin.childSessionId);
  }
  const blockedChildIds = new Set(
    backgroundWorks.flatMap((work) =>
      work.kind === "subagent" && work.status === "running" && work.blocked && work.childSessionId
        ? [work.childSessionId]
        : [],
    ),
  );
  const childSessionIds = [...latestRowByChildId.keys()];
  const running: RunningSubagentSummary[] = [];
  for (const [childSessionId, row] of latestRowByChildId) {
    if (row.status !== "running") continue;
    const previousItem = previousRunningById.get(childSessionId);
    const title = previousItem?.title || row.summaryText.trim() || row.subagentType;
    running.push({
      childSessionId,
      agentId: row.entityId,
      ...(row.parentToolCallId ? { toolCallId: row.parentToolCallId } : {}),
      subagentType: row.subagentType,
      title,
      status: waitingChildIds.has(childSessionId)
        ? "waiting"
        : blockedChildIds.has(childSessionId)
          ? "blocked"
          : "running",
      ...(row.startedAt !== undefined ? { startedAt: row.startedAt } : {}),
    });
  }
  running.sort(
    (left, right) =>
      (right.startedAt ?? 0) - (left.startedAt ?? 0) ||
      right.childSessionId.localeCompare(left.childSessionId),
  );
  const endedTotal = childSessionIds.length - running.length;
  const semanticState = { childSessionIds, running, endedTotal };
  if (
    JSON.stringify(semanticState) ===
    JSON.stringify({
      childSessionIds: previous.childSessionIds,
      running: previous.running,
      endedTotal: previous.endedTotal,
    })
  ) {
    return [];
  }
  return [
    {
      op: "state.updated",
      patch: {
        subagents: {
          revision: previous.revision + 1,
          ...semanticState,
        },
      },
    },
  ];
}

export function prospectiveSubagentRow(
  this: ProductProjection,
  row: ConversationRow,
  reduced: readonly ConversationDelta[],
  startIndex: number,
): SubagentRow | null {
  let prospective: ConversationRow | null = row;
  for (let index = startIndex; index < reduced.length && prospective; index += 1) {
    const delta = reduced[index]!;
    switch (delta.op) {
      case "row.appended":
      case "state.updated":
      case "pluginUi.resourceUpdated":
      case "pluginUi.resourceListChanged":
      case "pluginUi.instanceClosed":
      case "pluginUi.appToolCall":
      // 非行 op：改不了这一行的 prospective 形态。
      case "workflowRun.updated":
      case "workflowRun.removed":
        break;
      case "row.upserted":
        if (delta.row.rowId === prospective.rowId) prospective = delta.row;
        break;
      case "row.delta":
        if (
          delta.rowId === prospective.rowId &&
          delta.path === "summaryText" &&
          prospective.kind === "subagent"
        ) {
          prospective = {
            ...prospective,
            summaryText: prospective.summaryText + delta.append,
          };
        }
        break;
      case "row.removed":
        if (prospective.rowId >= delta.fromRowId) prospective = null;
        break;
      default: {
        const exhaustiveDelta: never = delta;
        return exhaustiveDelta;
      }
    }
  }
  return prospective?.kind === "subagent" ? prospective : null;
}
