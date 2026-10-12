// Modified by ZCode Feiyu.
import type { V4SubscribeDispatchResult } from "./v4-gateway-conversation-v4-gateway-options.js";
import type {
  RoutedTopicFrame,
  V4ConversationRowsRangeResult,
  V4ConversationPlansResult,
  V4ConversationWorkflowRunEventsResult,
  V4ConversationWorkflowRunsResult,
  V4ConversationWorkflowRunArtifactsResult,
  V4ConversationWorkflowRunArtifactDataResult,
} from "@zcode/shared/zcode-protocol-v4";
import {
  v4ConversationResyncParamsSchema,
  parseConversationTopic,
  parseSessionsIndexTopic,
  parseWorkspaceConfigTopic,
  v4ConversationRowsRangeParamsSchema,
  v4ConversationPlansParamsSchema,
  v4ConversationWorkflowRunEventsParamsSchema,
  WORKFLOW_RUN_EVENTS_PAGE_LIMITS,
  v4ConversationWorkflowRunEventsResultSchema,
  v4ConversationWorkflowRunsParamsSchema,
  v4ConversationWorkflowRunsResultSchema,
  v4ConversationWorkflowRunArtifactsParamsSchema,
  v4ConversationWorkflowRunArtifactsResultSchema,
  v4ConversationWorkflowRunArtifactDataParamsSchema,
  WORKFLOW_ARTIFACT_LIMITS,
  v4ConversationWorkflowRunArtifactDataResultSchema,
} from "@zcode/shared/zcode-protocol-v4";
import { subscriptionRouteKey } from "./v4-gateway-conversation-v4-gateway-options.js";
import { V4CapabilityUnsupportedError } from "./commands/handlers/interaction-background.js";
import type { ConversationV4Gateway } from "./v4-gateway.js";

export function resyncReserved(
  this: ConversationV4Gateway,
  rawParams: unknown,
): V4SubscribeDispatchResult<RoutedTopicFrame> {
  const params = v4ConversationResyncParamsSchema.parse(rawParams);
  const request = {
    base: params.base,
    ...(params.forceSnapshot !== undefined ? { forceSnapshot: params.forceSnapshot } : {}),
  };
  const sessionId = parseConversationTopic(params.topic);
  if (sessionId !== null) {
    const publisher = this["publishers"].get(sessionId);
    if (!publisher?.hasSubscription(params.subscriptionId, params.connectionId)) {
      throw new Error("fault.subscription.notOwned");
    }
    const routeKey = subscriptionRouteKey(params.topic, params.subscriptionId, params.connectionId);
    const flushState = this["flushStates"].get(routeKey);
    if (flushState?.timer) {
      clearTimeout(flushState.timer);
      flushState.timer = null;
    }
    const result = publisher.resyncReserved(params.subscriptionId, request);
    if (!result) throw new Error("fault.subscription.notOwned");
    try {
      return this["subscribeDispatch"](result.ack, result.reservation, () => {
        const state = this["flushStates"].get(routeKey);
        if (state) this["scheduleFlush"](routeKey, state, publisher);
      });
    } catch (error) {
      // physical encode 在 ACK admission 前失败时，same-sub recovery
      // 不能留下新的 inFlight 或取消旧 online flush；原子恢复旧状态后重挂 timer。
      result.rollback();
      if (flushState) this["scheduleFlush"](routeKey, flushState, publisher);
      throw error;
    }
  }
  const indexWorkspaceId = parseSessionsIndexTopic(params.topic);
  if (indexWorkspaceId !== null) {
    const publisher = this["indexPublishers"].get(indexWorkspaceId);
    if (!publisher?.hasSubscription(params.subscriptionId, params.connectionId)) {
      throw new Error("fault.subscription.notOwned");
    }
    const result = publisher.resyncReserved(params.subscriptionId, request);
    if (!result) throw new Error("fault.subscription.notOwned");
    try {
      return this["subscribeDispatch"](
        {
          subscriptionId: result.subscriptionId,
          mode: result.mode,
          logEpoch: publisher.logEpoch,
        },
        result.reservation,
        () => this["flushIndex"](indexWorkspaceId),
      );
    } catch (error) {
      result.rollback();
      throw error;
    }
  }
  const configWorkspaceId = parseWorkspaceConfigTopic(params.topic);
  if (configWorkspaceId !== null) {
    const publisher = this["configPublishers"].get(configWorkspaceId);
    if (!publisher?.hasSubscription(params.subscriptionId, params.connectionId)) {
      throw new Error("fault.subscription.notOwned");
    }
    const result = publisher.resyncReserved(params.subscriptionId, request);
    if (!result) throw new Error("fault.subscription.notOwned");
    try {
      return this["subscribeDispatch"](
        {
          subscriptionId: result.subscriptionId,
          mode: result.mode,
          logEpoch: publisher.logEpoch,
        },
        result.reservation,
        () => this["flushConfig"](configWorkspaceId),
      );
    } catch (error) {
      result.rollback();
      throw error;
    }
  }
  throw new Error(`Unsupported topic: ${params.topic}`);
}

export async function rowsRange(
  this: ConversationV4Gateway,
  rawParams: unknown,
): Promise<V4ConversationRowsRangeResult> {
  const params = v4ConversationRowsRangeParamsSchema.parse(rawParams);
  const existingReady = this["readyFlights"].get(params.sessionId);
  const publisher = existingReady
    ? await existingReady
    : !this["hasLiveConversation"](params.sessionId)
      ? await this["ensureColdReadyPublisher"](params.sessionId)
      : await this["hydratePublisher"](params.sessionId);
  const history = publisher.getRowsRange(
    {
      ...(params.beforeRowId !== undefined ? { beforeRowId: params.beforeRowId } : {}),
      limit: params.limit,
    },
    // clientMode 决定行可见性过滤档位：桌面 continuous（默认）/ 断线恢复 replayable。
    params.clientMode === "desktop-continuous" ? "continuous" : "replayable",
  );
  // 同一个同步片段读取行与控制状态，避免 Host 把不同 revision 的事实拼成快照。
  const { control, inputRouting, queue, pendingInteractions } = publisher.getSnapshot();
  return { ...history, observation: { control, inputRouting, queue, pendingInteractions } };
}

export async function plans(
  this: ConversationV4Gateway,
  rawParams: unknown,
): Promise<V4ConversationPlansResult> {
  const params = v4ConversationPlansParamsSchema.parse(rawParams);
  const existingReady = this["readyFlights"].get(params.sessionId);
  const publisher = existingReady
    ? await existingReady
    : !this["hasLiveConversation"](params.sessionId)
      ? await this["ensureColdReadyPublisher"](params.sessionId)
      : await this["hydratePublisher"](params.sessionId);
  return publisher.getPlans();
}

export async function workflowRunEvents(
  this: ConversationV4Gateway,
  rawParams: unknown,
): Promise<V4ConversationWorkflowRunEventsResult> {
  const params = v4ConversationWorkflowRunEventsParamsSchema.parse(rawParams);
  if (!this["host"].listDynamicWorkflowRunEvents) {
    throw new V4CapabilityUnsupportedError("listDynamicWorkflowRunEvents", params.sessionId);
  }
  await this["ensureHostRecordForJournalRead"](params.sessionId);
  const page = await this["host"].listDynamicWorkflowRunEvents(params.sessionId, {
    runId: params.runId,
    ...(params.afterSequence === undefined ? {} : { afterSequence: params.afterSequence }),
    limit: params.limit ?? WORKFLOW_RUN_EVENTS_PAGE_LIMITS.maxEvents,
    maxBytes: WORKFLOW_RUN_EVENTS_PAGE_LIMITS.maxBytes,
  });
  return v4ConversationWorkflowRunEventsResultSchema.parse(page);
}

export async function workflowRuns(
  this: ConversationV4Gateway,
  rawParams: unknown,
): Promise<V4ConversationWorkflowRunsResult> {
  const params = v4ConversationWorkflowRunsParamsSchema.parse(rawParams);
  if (!this["host"].listDynamicWorkflowRuns) {
    throw new V4CapabilityUnsupportedError("listDynamicWorkflowRuns", params.sessionId);
  }
  await this["ensureHostRecordForJournalRead"](params.sessionId);
  const runs = await this["host"].listDynamicWorkflowRuns(
    params.sessionId,
    params.limit === undefined ? {} : { limit: params.limit },
  );
  return v4ConversationWorkflowRunsResultSchema.parse({ runs });
}

export async function workflowRunArtifacts(
  this: ConversationV4Gateway,
  rawParams: unknown,
): Promise<V4ConversationWorkflowRunArtifactsResult> {
  const params = v4ConversationWorkflowRunArtifactsParamsSchema.parse(rawParams);
  if (!this["host"].listDynamicWorkflowRunArtifacts) {
    throw new V4CapabilityUnsupportedError("listDynamicWorkflowRunArtifacts", params.sessionId);
  }
  await this["ensureHostRecordForJournalRead"](params.sessionId);
  const artifacts = await this["host"].listDynamicWorkflowRunArtifacts(params.sessionId, {
    runId: params.runId,
  });
  return v4ConversationWorkflowRunArtifactsResultSchema.parse({ artifacts: artifacts ?? [] });
}

export async function workflowRunArtifactData(
  this: ConversationV4Gateway,
  rawParams: unknown,
): Promise<V4ConversationWorkflowRunArtifactDataResult> {
  const params = v4ConversationWorkflowRunArtifactDataParamsSchema.parse(rawParams);
  if (!this["host"].listDynamicWorkflowRunArtifactItems) {
    throw new V4CapabilityUnsupportedError("listDynamicWorkflowRunArtifactItems", params.sessionId);
  }
  await this["ensureHostRecordForJournalRead"](params.sessionId);
  const limit = Math.max(
    1,
    Math.min(
      params.limit ?? WORKFLOW_ARTIFACT_LIMITS.defaultItemsPerPage,
      WORKFLOW_ARTIFACT_LIMITS.maxItemsPerPage,
    ),
  );
  const page = await this["host"].listDynamicWorkflowRunArtifactItems(params.sessionId, {
    runId: params.runId,
    artifactId: params.artifactId,
    ...(params.afterSequence === undefined ? {} : { afterSequence: params.afterSequence }),
    limit,
    maxBytes: WORKFLOW_ARTIFACT_LIMITS.maxPageBytes,
    ...(params.fields === undefined ? {} : { fields: params.fields }),
  });
  return v4ConversationWorkflowRunArtifactDataResultSchema.parse(page);
}
