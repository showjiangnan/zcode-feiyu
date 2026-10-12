// Modified by ZCode Feiyu.
import type { WorkspaceConfigState, ConversationTopicFrame } from "@zcode/shared/zcode-protocol-v4";
import { WorkspaceConfigPublisher } from "./workspace-config-publisher.js";
import type { V4SubscribeDispatchResult } from "./v4-gateway-conversation-v4-gateway-options.js";
import {
  v4ConversationSubscribeParamsSchema,
  parseConversationTopic,
  DELIVERY_PROFILES,
} from "@zcode/shared/zcode-protocol-v4";
import { subscriptionRouteKey } from "./v4-gateway-conversation-v4-gateway-options.js";
import type { ConversationV4Gateway } from "./v4-gateway.js";

export function publishWorkspaceConfig(
  this: ConversationV4Gateway,
  workspaceId: string,
  state: WorkspaceConfigState,
): void {
  if (this["disposed"]) return;
  let publisher = this["configPublishers"].get(workspaceId);
  if (!publisher) {
    publisher = new WorkspaceConfigPublisher(
      workspaceId,
      this["createLogEpoch"](`workspace-config/${workspaceId}`),
      this["now"],
    );
    this["configPublishers"].set(workspaceId, publisher);
  }
  try {
    if (publisher.publish(state)) this["flushConfig"](workspaceId);
  } catch (error) {
    this["host"].onError?.("v4.workspaceConfig.publish", error);
  }
}

export async function pullWorkspaceConfig(
  this: ConversationV4Gateway,
  workspaceId: string,
): Promise<WorkspaceConfigState | null> {
  if (!this["host"].getWorkspaceConfig) return null;
  return (await this["host"].getWorkspaceConfig(workspaceId)) ?? null;
}

export async function ensureConfigPublisher(
  this: ConversationV4Gateway,
  workspaceId: string,
): Promise<WorkspaceConfigPublisher> {
  const existing = this["configPublishers"].get(workspaceId);
  if (existing) return existing;
  const publisher = new WorkspaceConfigPublisher(
    workspaceId,
    this["createLogEpoch"](`workspace-config/${workspaceId}`),
    this["now"],
  );
  const seed = await this["pullWorkspaceConfig"](workspaceId).catch((error) => {
    this["host"].onError?.("v4.workspaceConfig.seed", error);
    return null;
  });
  if (seed) publisher.publish(seed);
  // await 期间的并发订阅可能已注册同 workspace publisher → 以先注册者为准。
  const raced = this["configPublishers"].get(workspaceId);
  if (raced) return raced;
  this["configPublishers"].set(workspaceId, publisher);
  return publisher;
}

export function flushConfig(
  this: ConversationV4Gateway,
  workspaceId: string,
  onlyConnectionId?: string,
): void {
  const publisher = this["configPublishers"].get(workspaceId);
  if (!publisher) return;
  for (const subscriptionId of publisher.subscriptionIds()) {
    const connectionId = publisher.connectionIdForSubscription(subscriptionId);
    if (
      connectionId === null ||
      this["pausedConnections"].has(connectionId) ||
      (onlyConnectionId !== undefined && connectionId !== onlyConnectionId)
    ) {
      continue;
    }
    const reservation = publisher.reserveFlush(subscriptionId);
    if (!reservation) continue;
    try {
      this["emitReservation"](reservation);
    } catch (error) {
      this["host"].onError?.("v4.workspaceConfig.emit", error);
    }
  }
}

export async function subscribe(
  this: ConversationV4Gateway,
  rawParams: unknown,
): Promise<V4SubscribeDispatchResult<ConversationTopicFrame>> {
  const dispatch = await this.subscribeReserved(rawParams);
  dispatch.commit();
  return dispatch;
}

export async function subscribeReserved(
  this: ConversationV4Gateway,
  rawParams: unknown,
): Promise<V4SubscribeDispatchResult<ConversationTopicFrame>> {
  const params = v4ConversationSubscribeParamsSchema.parse(rawParams);
  const sessionId = parseConversationTopic(params.topic);
  if (sessionId === null) {
    throw new Error(`Unsupported topic: ${params.topic}`);
  }
  const isLiveConversation = this["hasLiveConversation"](sessionId);
  this["host"].onDebug?.(
    `subscribe conversation session=${sessionId} coldResume=${String(!isLiveConversation)}`,
  );
  // Hydration：首次订阅时从权威来源重建投影。
  // - 无 publisher（cold）→ 建 + 重放。
  // - 有 publisher 但事件日志覆盖不了 transcript（fork child：resume 的 ingest 抢先
  //   建了个只含 fork 事件的 cold publisher）→ 用 transcript 合成**重建**。
  // - 有 publisher 且事件日志完整（流式 live）→ 保留，重放会双计且打断流。
  const restoreStartedAt = performance.now();
  const existingReady = this["readyFlights"].get(sessionId);
  const publisher = existingReady
    ? await existingReady
    : !isLiveConversation
      ? await this["ensureColdReadyPublisher"](
          sessionId,
          params.resumeThoughtLevel,
          params.workspace,
        )
      : await this["hydratePublisher"](sessionId);
  const cliSessionRestoreMs = !isLiveConversation
    ? Math.max(0, Math.round(performance.now() - restoreStartedAt))
    : undefined;
  // 旧入口允许 UI 自选 deliveryProfile，桌面调用遗漏时还会默认成
  // replayable。现在只认 host attachment 注入的可信 clientMode。
  const profileName = params.clientMode === "desktop-continuous" ? "continuous" : "replayable";
  // subscribeReserved 已构建 wire projection；若在它之后才开始计时，大会话的
  // 行过滤/窗口截断会落在 restore 与 encode 两段之外。起点必须覆盖构建与 physical encode。
  const initialFrameEncodeStartedAt = performance.now();
  const result = publisher.subscribeReserved({
    connectionId: params.connectionId,
    base: params.base,
    deliveryProfile: profileName,
    // 与 clientMode 同族的可信注入：能力位来自该连接的 clientHello，缺席一律按旧消费者办
    // （整键 patch + 旧界裁剪）。resync / rehydrate 沿用订阅上已记下的这一位，不再重取。
    workflowRunDeltas: params.workflowRunDeltas === true,
  });
  const routeKey = subscriptionRouteKey(
    params.topic,
    result.ack.subscriptionId,
    params.connectionId,
  );
  let dispatch: V4SubscribeDispatchResult<ConversationTopicFrame>;
  try {
    dispatch = this["subscribeDispatch"](result.ack, result.reservation, () => {
      const state = this["flushStates"].get(routeKey);
      if (state) this["scheduleFlush"](routeKey, state, publisher);
    });
    dispatch.ack = {
      ...dispatch.ack,
      openTiming: {
        version: 1,
        ...(cliSessionRestoreMs !== undefined ? { cliSessionRestoreMs } : {}),
        initialFrameEncodeMs: Math.max(
          0,
          Math.round(performance.now() - initialFrameEncodeStartedAt),
        ),
        sessionRuntimeState: isLiveConversation ? "warm" : "cold",
        snapshotRowCount: publisher.getSnapshot().rows.window.length,
      },
    };
  } catch (error) {
    // 重订 initial encode 失败时客户端仍持有旧 subId；replacement 必须
    // 原子 rollback，旧 publisher subscription 与 flush timer 都继续有效。
    result.rollback();
    throw error;
  }
  // encode 成功后 replacement 才 admission；此时再清旧调度状态，失败路径不碰旧 owner。
  for (const [staleRouteKey, staleState] of this["flushStates"]) {
    if (staleState.sessionId !== sessionId) continue;
    if (publisher.hasSubscription(staleState.subscriptionId, staleState.connectionId)) {
      continue;
    }
    if (staleState.timer) clearTimeout(staleState.timer);
    this["flushStates"].delete(staleRouteKey);
  }
  this["flushStates"].set(routeKey, {
    sessionId,
    topic: params.topic,
    subscriptionId: result.ack.subscriptionId,
    connectionId: params.connectionId,
    deliveryProfile: profileName,
    flushWindowMs: DELIVERY_PROFILES[profileName].flushWindowMs,
    timer: null,
  });
  return dispatch;
}
