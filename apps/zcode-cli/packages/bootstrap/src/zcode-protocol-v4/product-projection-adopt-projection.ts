// Modified by ZCode Feiyu.
import type {
  ConversationDelta,
  ConversationRow,
  AssistantTextRow,
} from "@zcode/shared/zcode-protocol-v4";
import { applyConversationDeltas } from "@zcode/shared/zcode-protocol-v4";
import { deltaBumpsRevision } from "./projection-state.js";
import type { ProductProjection } from "./product-projection.js";

export function adoptProjection(this: ProductProjection, candidate: ProductProjection): void {
  this["snapshot"] = candidate["snapshot"];
  this["rowIndexById"] = candidate["rowIndexById"];
  this["hydrationAccumulator"] = null;
  this["nextRowId"] = candidate["nextRowId"];
  this["streamingTextRowId"] = candidate["streamingTextRowId"];
  this["streamingReasoningRowId"] = candidate["streamingReasoningRowId"];
  this["outputContinuationTextRowId"] = candidate["outputContinuationTextRowId"];
  this["toolRowIdByCallId"] = candidate["toolRowIdByCallId"];
  this["latestListAppsSnapshot"] = candidate["latestListAppsSnapshot"];
  this["openForegroundToolCallIds"] = candidate["openForegroundToolCallIds"];
  this["fileToolInputPreviewByCallId"] = candidate["fileToolInputPreviewByCallId"];
  this["subagentRowIdByAgentId"] = candidate["subagentRowIdByAgentId"];
  this["hookRowIdByInvocationId"] = candidate["hookRowIdByInvocationId"];
  this["pendingSessionHookInvocations"] = candidate["pendingSessionHookInvocations"];
  this["rewoundHookInvocationIds"] = candidate["rewoundHookInvocationIds"];
  this["invalidSubagentChildSessionIds"] = candidate["invalidSubagentChildSessionIds"];
  this["messageIdByRowId"] = candidate["messageIdByRowId"];
  this["outputContinuationRowIdByMessageId"] = candidate["outputContinuationRowIdByMessageId"];
  this["entityIdByRowId"] = candidate["entityIdByRowId"];
  this["editTargetByEntityId"] = candidate["editTargetByEntityId"];
  this["currentEditableEntityId"] = candidate["currentEditableEntityId"];
  this["stableCompactCoverageBoundaryRowId"] = candidate["stableCompactCoverageBoundaryRowId"];
  this["turnHeaderRowIdByTurnId"] = candidate["turnHeaderRowIdByTurnId"];
  this["compactMarkerRowIdByOperationId"] = candidate["compactMarkerRowIdByOperationId"];
  this["goalVerifyMarkerRowIdByLifecycleKey"] = candidate["goalVerifyMarkerRowIdByLifecycleKey"];
  this["productTurnIdByRuntimeTurnId"] = candidate["productTurnIdByRuntimeTurnId"];
  this["runtimeTurnIdByProductTurnId"] = candidate["runtimeTurnIdByProductTurnId"];
  this["productTurnSplitOrdinalByRuntimeTurnId"] =
    candidate["productTurnSplitOrdinalByRuntimeTurnId"];
  this["currentProductTurnStartedAtMs"] = candidate["currentProductTurnStartedAtMs"];
  this["highspeedModelDurationByTurnId"] = candidate["highspeedModelDurationByTurnId"];
  this["highspeedToolIntervalsByTurnId"] = candidate["highspeedToolIntervalsByTurnId"];
  this["deliveryByPendingInputId"] = candidate["deliveryByPendingInputId"];
  this["currentTurnId"] = candidate["currentTurnId"];
  this["currentTurnStartedModelOnly"] = candidate["currentTurnStartedModelOnly"];
  this["contextWindowState"] = candidate["contextWindowState"];
  this["lastTurnModel"] = candidate["lastTurnModel"];
  this["configModelTouchedByEvent"] = candidate["configModelTouchedByEvent"];
  this["configThoughtLevelsTouchedByEvent"] = candidate["configThoughtLevelsTouchedByEvent"];
  this["configModeTouchedByEvent"] = candidate["configModeTouchedByEvent"];
  this["configOrchestrationTouchedByEvent"] = candidate["configOrchestrationTouchedByEvent"];
  this["droppedContentStreamEventCount"] = candidate["droppedContentStreamEventCount"];
  this["normalizationDiagnostics"] = candidate["normalizationDiagnostics"];
}

export function materializeCommandRowActions(
  this: ProductProjection,
  reduced: ConversationDelta[],
): ConversationDelta[] {
  const prospective = applyConversationDeltas(this["snapshot"], reduced);
  const rows = prospective.rows.window;
  const rowById = new Map(rows.map((row) => [row.rowId, row]));
  const latestAssistantRowIdByTurn = new Map<string, number>();
  for (const row of rows) {
    if (row.kind !== "assistantText") continue;
    const current = latestAssistantRowIdByTurn.get(row.turnId);
    if (current === undefined || row.rowId > current) {
      latestAssistantRowIdByTurn.set(row.turnId, row.rowId);
    }
  }
  const compactActive = prospective.control.activeWorks.some((work) => work.kind === "compact");
  const completionBlockingActive = prospective.control.activeWorks.length > 0;
  let latestEditable: ConversationRow | undefined;
  let latestAssistant: AssistantTextRow | undefined;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (
      !latestEditable &&
      !compactActive &&
      row.kind === "userInput" &&
      row.origin === "realUser"
    ) {
      latestEditable = row;
    }
    if (!latestAssistant && row.kind === "assistantText") {
      latestAssistant = row;
    }
    if (latestEditable && latestAssistant) break;
  }
  // 旧逻辑只按“最新完整 assistant”挑 retry，background result 的
  // synthetic turn 因此会错误获得入口；若只在 find 条件里过滤 synthetic，又会跳过
  // 最新 background assistant，让更早真实用户轮的 retry 复活。这里必须先锁定全时间线
  // 最新 assistant，再校验同轮 realUser canonical cause，保证普通 retry 不跨轮回退。
  const latestRetryable = (() => {
    if (
      completionBlockingActive ||
      !latestAssistant ||
      latestAssistant.state !== "complete" ||
      !this["messageIdByRowId"].has(latestAssistant.rowId)
    ) {
      return undefined;
    }
    const headerId = this["turnHeaderRowIdByTurnId"].get(latestAssistant.turnId);
    const header = headerId === undefined ? undefined : rowById.get(headerId);
    if (header?.kind !== "turnHeader" || header.state === "running") return undefined;
    const canonicalUserRow = rows.find(
      (row) =>
        row.turnId === latestAssistant.turnId &&
        row.kind === "userInput" &&
        row.origin === "realUser",
    );
    const canonicalUserEntityId = canonicalUserRow
      ? this["entityIdByRowId"].get(canonicalUserRow.rowId)
      : undefined;
    if (!canonicalUserEntityId || !this["editTargetByEntityId"].has(canonicalUserEntityId)) {
      return undefined;
    }
    return latestAssistant;
  })();
  const latestEditableEntityId =
    latestEditable === undefined
      ? null
      : (this["entityIdByRowId"].get(latestEditable.rowId) ?? null);
  // edit action 与命令 resolver 必须共用 canonical target authority。过去 drain 分支只
  // 登记 messageId，UI 因而显示 Edit，但提交必被 resolver 以 actionUnavailable 拒绝。
  const latestEditableRowId =
    latestEditable &&
    latestEditableEntityId &&
    this["messageIdByRowId"].has(latestEditable.rowId) &&
    this["editTargetByEntityId"].has(latestEditableEntityId)
      ? latestEditable.rowId
      : null;
  // entity target 历史表会保留旧记录；仅撤销 row action 不足以阻止
  // entityId 直查绕过 latest-only 语义。当前可编辑 authority 与 actions 在同一次
  // materialization 中更新，resolver 不再遍历 rows，也不把 rowId 当 canonical key。
  this["currentEditableEntityId"] = latestEditableRowId === null ? null : latestEditableEntityId;
  const latestRetryableRowId = latestRetryable?.rowId ?? null;
  const deltas: ConversationDelta[] = [];
  for (const row of rows) {
    if (row.kind !== "turnHeader" && row.kind !== "userInput" && row.kind !== "assistantText")
      continue;
    const nextActions = { ...row.actions };
    if (row.kind === "turnHeader") {
      const canRewindFiles =
        !completionBlockingActive &&
        prospective.pendingInteractions.length === 0 &&
        row.state !== "running" &&
        row.fileChanges?.state === "active";
      if (canRewindFiles) nextActions.canRewindFiles = true;
      else delete nextActions.canRewindFiles;
    } else if (row.kind === "userInput") {
      if (row.rowId === latestEditableRowId) {
        nextActions.canEdit = true;
        nextActions.editDisposition = "rewind";
      } else {
        delete nextActions.canEdit;
        delete nextActions.editDisposition;
      }
    } else {
      if (row.rowId === latestRetryableRowId) nextActions.canRetry = true;
      else delete nextActions.canRetry;
      const headerId = this["turnHeaderRowIdByTurnId"].get(row.turnId);
      const header = headerId === undefined ? undefined : rowById.get(headerId);
      const canFork =
        !compactActive &&
        row.state === "complete" &&
        header?.kind === "turnHeader" &&
        header.state === "completedSuccess" &&
        latestAssistantRowIdByTurn.get(row.turnId) === row.rowId &&
        this["messageIdByRowId"].has(row.rowId);
      if (canFork) nextActions.canFork = true;
      else delete nextActions.canFork;
    }
    const actions = Object.keys(nextActions).length > 0 ? nextActions : undefined;
    if (JSON.stringify(actions) === JSON.stringify(row.actions)) continue;
    const nextRow: ConversationRow = { ...row, actions };
    if (!actions) delete nextRow.actions;
    deltas.push({ op: "row.upserted", row: nextRow });
  }
  return deltas;
}

export function attachRevision(
  this: ProductProjection,
  deltas: ConversationDelta[],
): ConversationDelta[] {
  if (!deltas.some(deltaBumpsRevision)) return deltas;
  const revision = this["snapshot"].revision + 1;
  const last = deltas[deltas.length - 1];
  if (last?.op === "state.updated") {
    return [...deltas.slice(0, -1), { op: "state.updated", patch: { ...last.patch, revision } }];
  }
  return [...deltas, { op: "state.updated", patch: { revision } }];
}
