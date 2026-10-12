// Modified by ZCode Feiyu.
import type { CanonicalConversationFact } from "./event-normalizer.js";
import type { ConversationDelta } from "@zcode/shared/zcode-protocol-v4";
import { SessionEventType } from "@zcode/contracts";
import { isZCodeModelRetryRecoveryProgressPayload } from "@zcode/shared";
import type {
  PluginUiResourceUpdatedPayload,
  PluginUiResourceListChangedPayload,
  PluginUiAppToolCallRequestedPayload,
} from "@zcode/contracts";
import type { ProductProjection } from "./product-projection.js";

export function reduce(
  this: ProductProjection,
  fact: CanonicalConversationFact,
): ConversationDelta[] {
  const event = fact.event;
  switch (event.type) {
    case SessionEventType.SessionCreated:
      return this["onSessionCreated"](event);
    case SessionEventType.SessionResumed:
      return this["onSessionResumed"](event);
    case SessionEventType.SessionTitleUpdated:
      return this["onSessionTitleUpdated"](event);
    case SessionEventType.TurnStarted:
      if (fact.semanticKind !== "userIntent") return [];
      return [
        ...this["onTurnStarted"](fact),
        // model-only 维护 turn（manual /compact、goal continuation）没有资格
        // 承载 SessionStart 摘要；pending 保持到下一条 user-visible 真实 turn。
        ...(this["currentTurnStartedModelOnly"]
          ? []
          : this["flushPendingSessionHookInvocations"](fact.productTurnId)),
      ];
    case SessionEventType.ModelStreaming: {
      if (fact.semanticKind !== "assistantSegment") return [];
      const shouldClearApiRetry =
        this["acceptsActiveModelEvent"](event) &&
        isZCodeModelRetryRecoveryProgressPayload(
          event.payload as unknown as Record<string, unknown>,
        );
      const streamingDeltas = this["onModelStreaming"](fact);
      return shouldClearApiRetry
        ? [...streamingDeltas, ...this["setApiRetry"](null)]
        : streamingDeltas;
    }
    case SessionEventType.ModelNetworkStatus:
      return this["onModelNetworkStatus"](event);
    case SessionEventType.StreamRecoveryStarted:
      return this["onStreamRecoveryStarted"](event);
    case SessionEventType.StreamRecoveryTailDiscarded:
      return this["onStreamRecoveryTailDiscarded"](event);
    case SessionEventType.StreamRecoveryRetryStarted:
      return this["onStreamRecoveryRetryStarted"](event);
    case SessionEventType.ModelSelected:
      return this["onModelSelected"](event);
    case SessionEventType.ModelComplete:
      return this["onModelComplete"](event);
    case SessionEventType.ToolCallScheduled:
      return this["onToolCallScheduled"](event);
    case SessionEventType.ToolCallStarted:
      return this["onToolCallActivity"](event);
    case SessionEventType.ToolCallProgress:
      return this["onToolCallProgress"](event);
    case SessionEventType.ToolCallResult:
      return this["onToolCallResult"](event);
    case SessionEventType.ToolCallError:
      return this["onToolCallError"](event);
    case SessionEventType.PermissionRequested:
      return this["onPermissionRequested"](event);
    case SessionEventType.PermissionResolved:
      return this["onPermissionResolved"](event);
    case SessionEventType.PermissionDenied:
      return this["onPermissionDenied"](event);
    case SessionEventType.PluginUiResourceUpdated: {
      // live-only，不改快照；renderer 按 subscribers 派发给沙箱实例。
      const payload = event.payload as PluginUiResourceUpdatedPayload;
      return [
        {
          op: "pluginUi.resourceUpdated",
          pluginId: payload.pluginId,
          serverName: payload.serverName,
          uri: payload.uri,
          subscribers: payload.subscribers,
        },
      ];
    }
    case SessionEventType.PluginUiResourceListChanged: {
      const payload = event.payload as PluginUiResourceListChangedPayload;
      return [
        {
          op: "pluginUi.resourceListChanged",
          pluginId: payload.pluginId,
          serverName: payload.serverName,
          subscribers: payload.subscribers,
        },
      ];
    }
    case SessionEventType.PluginUiInstanceClosed: {
      const payload = event.payload as PluginUiResourceListChangedPayload;
      return [{ op: "pluginUi.instanceClosed", ...payload }];
    }
    case SessionEventType.PluginUiAppToolCallRequested: {
      // App-Provided Tools 信箱：live-only，投递给 subscribers 里唯一的实例。
      const payload = event.payload as PluginUiAppToolCallRequestedPayload;
      return [
        {
          op: "pluginUi.appToolCall",
          activity: payload.activity,
          ...(payload.cancelled ? { cancelled: true } : {}),
          pluginId: payload.pluginId,
          serverName: payload.serverName,
          subscribers: payload.subscribers,
          callId: payload.callId,
          toolName: payload.toolName,
          arguments: payload.arguments,
        },
      ];
    }
    case SessionEventType.UserInputAutoResolutionUpdated:
      return this["onUserInputAutoResolutionUpdated"](event);
    case SessionEventType.WorkspaceHookReviewRequested:
      return this["onWorkspaceHookReviewRequested"](event);
    case SessionEventType.WorkspaceHookReviewSettled:
      return this["onWorkspaceHookReviewSettled"](event);
    case SessionEventType.WorkspaceHookReviewSuperseded:
      return this["onWorkspaceHookReviewSuperseded"](event);
    case SessionEventType.WorkspaceHookAdmissionUpdated:
      return this["onWorkspaceHookAdmissionUpdated"](event);
    case SessionEventType.HookRunStarted:
    case SessionEventType.HookRunProgress:
    case SessionEventType.HookRunCompleted:
    case SessionEventType.HookRunFailed:
    case SessionEventType.HookRunBlocked:
      return this["onHookRunLifecycle"](event);
    case SessionEventType.TurnSteerQueued:
      return this["onTurnSteerQueued"](event);
    case SessionEventType.TurnSteerDeliveryChanged:
      return this["onTurnSteerDeliveryChanged"](event);
    case SessionEventType.TurnSteerDispatchChanged:
      return this["onTurnSteerDispatchChanged"](event);
    case SessionEventType.TurnSteerDrained:
      return this["onTurnSteerDrained"](event);
    case SessionEventType.TurnSteerDiscarded:
      return this["onTurnSteerDiscarded"](event);
    case SessionEventType.SessionInputPromoted:
      return this["onSessionInputPromoted"](event);
    case SessionEventType.TurnSteerReordered:
      return this["onTurnSteerReordered"](event);
    case SessionEventType.QueueAutoDrainChanged:
      return this["onQueueAutoDrainChanged"](event);
    case SessionEventType.FollowupModeChanged:
      return this["onFollowupModeChanged"](event);
    case SessionEventType.SessionModeChanged:
      return this["onSessionModeChanged"](event);
    case SessionEventType.SessionOrchestrationChanged:
      return this["onSessionOrchestrationChanged"](event);
    case SessionEventType.TeamBoardChanged:
      return this["onTeamBoardChanged"](event);
    case SessionEventType.TurnComplete:
      return this["onTurnComplete"](event);
    case SessionEventType.TurnError:
      return this["onTurnError"](event);
    case SessionEventType.CompactStarted:
    case SessionEventType.CompactCompleted:
    case SessionEventType.CompactFailed:
      return this["onCompactLifecycle"](event);
    case SessionEventType.TargetChanged:
      return this["onTargetChanged"](event);
    case SessionEventType.TargetCompletionVerification:
      return this["onTargetVerification"](event);
    case SessionEventType.SessionForked:
      return this["onSessionForked"](event);
    case SessionEventType.RewindTriggered:
      return this["onRewindTriggered"](event);
    case SessionEventType.BackgroundTaskStarted:
    case SessionEventType.BackgroundTaskUpdated:
    case SessionEventType.BackgroundTaskCompleted:
      return this["onBackgroundTaskLifecycle"](event);
    case SessionEventType.DynamicWorkflowRunProgress:
      return this["onDynamicWorkflowRunProgress"](event);
    case SessionEventType.SubagentSpawned:
      return this["onSubagentSpawned"](event);
    case SessionEventType.SubagentMessage:
      return this["onSubagentMessage"](event);
    case SessionEventType.SubagentStopped:
      return this["onSubagentStopped"](event);
    default:
      return [];
  }
}
