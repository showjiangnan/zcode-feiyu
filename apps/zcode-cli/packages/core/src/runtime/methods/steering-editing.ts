// Modified by ZCode Feiyu.
import { SessionEventType, createSessionEvent } from "../deps.js";
import type { TraceContext } from "../deps.js";

import { measureUtf8Bytes, previewInput } from "../helpers/index.js";

import type { AgentRuntimeInternal } from "../internal.js";

import { persistSessionInputUpdates } from "./steering-delivery.js";

/**
 * （v4 queue 单项编辑）：按 id 替换某排队输入的文本，重发 TurnSteerQueued（同 id）。
 * v4 reducer 的 onTurnSteerQueued 对同 id 原地更新（保位）。未命中 / 无 active turn → false。
 */
export async function editPendingInputById(
  this: AgentRuntimeInternal,
  options: {
    pendingInputId: string;
    newText: string;
    traceContext: TraceContext;
  },
): Promise<boolean> {
  const activeTurn = this.activeTurn;
  const pendingInput = activeTurn?.pendingInputs.find((item) => item.id === options.pendingInputId);
  if (!activeTurn || !pendingInput) {
    // held 回落：held 项只在事件日志/投影，经投影定位后
    // 重发同 id TurnSteerQueued（v4 reducer 原地更新，保位）。
    const projection = await this.rebuildProjection();
    const held = projection.pendingSteerInputs.find(
      (item) => item.pendingInputId === options.pendingInputId,
    );
    if (!held) return false;
    await persistSessionInputUpdates(this, [{ id: held.pendingInputId, text: options.newText }]);
    const event = createSessionEvent(
      SessionEventType.TurnSteerQueued,
      this.sessionId,
      {
        pendingInputId: held.pendingInputId,
        input: options.newText,
        inputPreview: previewInput(options.newText),
        inputSize: measureUtf8Bytes(options.newText),
        ...(held.commandKind ? { commandKind: held.commandKind } : {}),
        ...(held.intent ? { intent: { ...held.intent, text: options.newText } } : {}),
        ...(held.toolDisallowlist ? { toolDisallowlist: held.toolDisallowlist } : {}),
        queueLength: projection.pendingSteerInputs.length,
        targetTurnId: held.targetTurnId,
      },
      {
        traceId: options.traceContext.traceId,
        turnId: held.targetTurnId,
      },
    );
    await this.appendEvent(event, options.traceContext);
    return true;
  }
  await persistSessionInputUpdates(this, [{ id: pendingInput.id, text: options.newText }]);
  pendingInput.input = options.newText;
  // 编辑正文后必须同步 canonical text，否则结构化引用恢复时会显示旧正文。
  if (pendingInput.intent) pendingInput.intent = { ...pendingInput.intent, text: options.newText };
  const event = createSessionEvent(
    SessionEventType.TurnSteerQueued,
    this.sessionId,
    {
      pendingInputId: pendingInput.id,
      queryId: pendingInput.queryId,
      input: options.newText,
      inputPreview: previewInput(options.newText),
      inputSize: measureUtf8Bytes(options.newText),
      ...(pendingInput.commandKind ? { commandKind: pendingInput.commandKind } : {}),
      ...(pendingInput.delivery ? { delivery: pendingInput.delivery } : {}),
      ...(pendingInput.inputPresentation
        ? { inputPresentation: pendingInput.inputPresentation }
        : {}),
      ...(pendingInput.intent ? { intent: pendingInput.intent } : {}),
      ...(pendingInput.toolDisallowlist ? { toolDisallowlist: pendingInput.toolDisallowlist } : {}),
      queueLength: activeTurn.pendingInputs.length,
      targetTurnId: activeTurn.turnId,
    },
    {
      traceId: activeTurn.traceContext.traceId,
      turnId: activeTurn.turnId,
    },
  );
  await this.appendEvent(event, options.traceContext);
  return true;
}

/**
 * （v4 queue 重排）：把 pendingInputId 移到 beforePendingInputId 之前（null = 移到队尾），
 * 发 TurnSteerReordered(新序)。v4 reducer 按新序重排 queue rows。未命中 → false。
 */
export async function reorderPendingInput(
  this: AgentRuntimeInternal,
  options: {
    pendingInputId: string;
    beforePendingInputId: string | null;
    traceContext: TraceContext;
  },
): Promise<boolean> {
  const activeTurn = this.activeTurn;
  const fromIndexActive =
    activeTurn?.pendingInputs.findIndex((item) => item.id === options.pendingInputId) ?? -1;
  if (!activeTurn || fromIndexActive < 0) {
    // held 回落：在投影序上重排后发 TurnSteerReordered（v4 reducer 按新序重排）。
    const projection = await this.rebuildProjection();
    const heldIds = projection.pendingSteerInputs.map((item) => item.pendingInputId);
    const fromIndex = heldIds.indexOf(options.pendingInputId);
    if (fromIndex < 0) return false;
    heldIds.splice(fromIndex, 1);
    if (options.beforePendingInputId === null) {
      heldIds.push(options.pendingInputId);
    } else {
      const beforeIndex = heldIds.indexOf(options.beforePendingInputId);
      if (beforeIndex < 0) {
        heldIds.push(options.pendingInputId);
      } else {
        heldIds.splice(beforeIndex, 0, options.pendingInputId);
      }
    }
    await persistSessionInputUpdates(
      this,
      heldIds.map((id, queuePosition) => ({ id, queuePosition })),
    );
    const targetTurnId =
      projection.pendingSteerInputs.find((item) => item.pendingInputId === options.pendingInputId)
        ?.targetTurnId ?? projection.pendingSteerInputs[0]!.targetTurnId;
    const event = createSessionEvent(
      SessionEventType.TurnSteerReordered,
      this.sessionId,
      {
        orderedPendingInputIds: heldIds,
        targetTurnId,
      },
      {
        traceId: options.traceContext.traceId,
        turnId: targetTurnId,
      },
    );
    await this.appendEvent(event, options.traceContext);
    return true;
  }
  const items = [...activeTurn.pendingInputs];
  const fromIndex = items.findIndex((item) => item.id === options.pendingInputId);
  if (fromIndex < 0) return false;
  const [moved] = items.splice(fromIndex, 1);
  if (!moved) return false;
  if (options.beforePendingInputId === null) {
    items.push(moved);
  } else {
    const beforeIndex = items.findIndex((item) => item.id === options.beforePendingInputId);
    if (beforeIndex < 0) {
      // 目标锚点已消失 → 退回队尾，不丢项。
      items.push(moved);
    } else {
      items.splice(beforeIndex, 0, moved);
    }
  }
  // 只重排数组而不更新 intent.queuePosition，会让 live queue 顺序正确，
  // 但 drain 后 transcript 又写回 admission 时的旧位置，造成冷热投影事实分叉。
  const reorderedItems = items.map((item, index) =>
    item.intent ? { ...item, intent: { ...item.intent, queuePosition: index } } : item,
  );
  await persistSessionInputUpdates(
    this,
    reorderedItems.map((item, queuePosition) => ({ id: item.id, queuePosition })),
  );
  activeTurn.pendingInputs.splice(0, activeTurn.pendingInputs.length, ...reorderedItems);
  const event = createSessionEvent(
    SessionEventType.TurnSteerReordered,
    this.sessionId,
    {
      orderedPendingInputIds: reorderedItems.map((item) => item.id),
      targetTurnId: activeTurn.turnId,
    },
    {
      traceId: activeTurn.traceContext.traceId,
      turnId: activeTurn.turnId,
    },
  );
  await this.appendEvent(event, options.traceContext);
  return true;
}

/**
 * （v4 setAutoDrain）：翻转 queue autoDrain 授权位（会话级配置，与 active turn 无关）。
 * 仅追加 QueueAutoDrainChanged 事件供 v4 投影消费；held 派生（completed+queue>0+autoDrain=false
 * → choice 路由）与后续 heldQueueDisposition 命令闭合发送语义。
 */
export async function setQueueAutoDrain(
  this: AgentRuntimeInternal,
  options: {
    autoDrain: boolean;
    traceContext: TraceContext;
  },
): Promise<void> {
  // false -> true 表示用户从暂停队列恢复。旧暂停项只存在于事件投影，不在新
  // activeTurn.pendingInputs 中；恢复期间改由 CLI 外层按完整投影 FIFO 逐项提升。
  if (options.autoDrain && !this.queueAutoDrain) {
    this.queueExternalDrainActive = true;
  } else if (!options.autoDrain) {
    this.queueExternalDrainActive = false;
  }
  // 授权位同时进 runtime（drain 门）与事件日志（投影派生暂停队列）。
  this.queueAutoDrain = options.autoDrain;
  const event = createSessionEvent(
    SessionEventType.QueueAutoDrainChanged,
    this.sessionId,
    { autoDrain: options.autoDrain },
    { traceId: options.traceContext.traceId },
  );
  await this.appendEvent(event, options.traceContext);
}

/** CLI 投影确认恢复队列已空后，重新允许 core 在后续 tool batch 边界消费 guide。 */
export function completeExternalQueueDrain(this: AgentRuntimeInternal): void {
  this.queueExternalDrainActive = false;
}

/**
 * （v4 setFollowupMode）：翻转 followup 路由模式（会话级配置）。
 * 仅追加 FollowupModeChanged 事件供 v4 投影消费；running 时 computeInputRouting 依此在
 * enqueue（queue）与 guide 之间选择。
 */
export async function setFollowupMode(
  this: AgentRuntimeInternal,
  options: {
    mode: "queue" | "guide";
    traceContext: TraceContext;
  },
): Promise<void> {
  const event = createSessionEvent(
    SessionEventType.FollowupModeChanged,
    this.sessionId,
    { mode: options.mode },
    { traceId: options.traceContext.traceId },
  );
  await this.appendEvent(event, options.traceContext);
}
