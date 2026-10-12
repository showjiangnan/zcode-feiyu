// Modified by ZCode Feiyu.
import type { ZCodeProtocolRequest } from "@zcode/shared";
import {
  zcodeProtocolMethods,
  zcodeSessionCancelProjectMemoryReviewParamsSchema,
  zcodeSessionReadProjectMemoryReviewParamsSchema,
  zcodeSessionReviewProjectMemoryParamsSchema,
  zcodeWorkspaceHookTrustGrantParamsSchema,
} from "@zcode/shared";

import { V4_METHODS } from "@zcode/shared/zcode-protocol-v4";

import { updateAccountProviderConfig } from "./account-provider-config.js";

import { updateDynamicWorkflowPolicy } from "./dynamic-workflow-policy.js";

import { updateInteractionPreferences } from "./interaction-preferences.js";

import {
  callMcpUiTool,
  cancelMcpUiSampling,
  cancelMcpUiToolCall,
  claimMcpUiAppToolCall,
  listMcpUiResourceTemplates,
  listMcpUiResources,
  readMcpUiResource,
  readMcpUiResourceForUi,
  registerMcpUiAppTools,
  resolveMcpUiAppToolCall,
  sampleMcpUi,
  subscribeMcpUiResource,
  unregisterMcpUiAppTools,
  unsubscribeMcpUiResource,
} from "./mcp-ui/index.js";
import { listMcpServers } from "./mcp.js";
import { updateMemoryPreferences } from "./memory-preferences.js";
import { updateModelIoPreferences } from "./model-io-preferences.js";
import { updateOffPeakToolPolicy } from "./off-peak-tool-policy.js";
import {
  getPluginReferenceCatalog,
  resolveSuggestedPluginReference,
} from "./plugin-reference-catalog.js";
import { listPluginUiSurfaces } from "./plugin-ui-surfaces.js";
import {
  addPluginMarketplace,
  configurePlugin,
  describePlugin,
  getPluginsOverview,
  installPlugin,
  listPlugins,
  removePluginMarketplace,
  resetPluginConfig,
  restoreBuiltinPlugin,
  setPluginEnabled,
  uninstallPlugin,
  updatePlugin,
  updatePluginMarketplace,
  validatePlugin,
} from "./plugins.js";

import { listChildProcesses } from "./process-child-processes.js";

import { findSavedWorkflowForRunOp, saveSavedWorkflowFromRunOp } from "./saved-workflows-run.js";
import {
  deleteSavedWorkflowOp,
  getSavedWorkflowOp,
  listSavedWorkflowRunsOp,
  listSavedWorkflowsOp,
  moveSavedWorkflowOp,
  updateSavedWorkflowMetaOp,
} from "./saved-workflows.js";
import {
  cancelBackgroundTask,
  closeSession,
  compactSession,
  createSession,
  forkSession,
  generateWorkspaceText,
  getTaskTokenUsage,
  getUsageStats,
  goalSession,
  listSessionSubagents,
  listSessions,
  readEvents,
  readMessages,
  readSession,
  resumeSession,
  sendPrompt,
  setMode,
  setModel,
  setThoughtLevel,
  stopSession,
  subscribeSession,
} from "./server-operations.js";
import { ProtocolRequestError, parseParams } from "./server-types.js";
import { querySessionDebug } from "./session-debug.js";

import { getSkillReferenceCatalog } from "./skill-reference-catalog.js";
import { updateTelemetryConsent } from "./telemetry-consent.js";

import { grantWorkspaceHookTrustForProtocol } from "./workspace-hook-trust.js";
import { workspaceMemory } from "./workspace-memory.js";
import {
  readWorkspacePresentation,
  testProviderModelConnectivity,
} from "./workspace-model-runtime.js";
import { closeMcpUiInstance, openMcpUiInstance, validateMcpUiInstance } from "./mcp-ui/index.js";
import { notifyWorkspaceHookTrustGrantSessions } from "./server-support.js";
import { ProtocolServerV4Dispatch } from "./server-v4-dispatch.js";
// 拆分职责时原实例、状态和执行顺序保持唯一；继承链不新建队列或会话。
export class ProtocolServerDispatch extends ProtocolServerV4Dispatch {
  protected async dispatchRequest(request: ZCodeProtocolRequest) {
    switch (request.method) {
      case V4_METHODS.connectionFlow:
      case V4_METHODS.conversationSubscribe:
      case V4_METHODS.conversationResync:
      case V4_METHODS.conversationUnsubscribe:
      case V4_METHODS.conversationRowsRange:
      case V4_METHODS.conversationPlans:
      case V4_METHODS.backgroundBashOutput:
      case V4_METHODS.conversationFileChanges:
      case V4_METHODS.conversationFileRewindPreview:
      case V4_METHODS.conversationWorkflowRunEvents:
      case V4_METHODS.conversationWorkflowRuns:
      case V4_METHODS.conversationWorkflowRunArtifacts:
      case V4_METHODS.conversationWorkflowRunArtifactData:
      case V4_METHODS.conversationWorkflowRunArtifactRead:
      case V4_METHODS.conversationWorkflowRunWorkspace:
      case V4_METHODS.conversationWorkflowRunNodeResult:
      case V4_METHODS.attachmentBegin:
      case V4_METHODS.attachmentChunk:
      case V4_METHODS.attachmentCommit:
      case V4_METHODS.attachmentAbort:
      case V4_METHODS.attachmentRead:
      case V4_METHODS.conversationAttachmentRead:
      case V4_METHODS.conversationAttachmentStat:
      case V4_METHODS.attachmentPreviewSource:
      case V4_METHODS.usageStats:
      case V4_METHODS.conversationUsage:
      case V4_METHODS.command:
      case V4_METHODS.commandsQuery:
        return await this.dispatchV4Request(request);
      case zcodeProtocolMethods.sessionCreate:
        return await createSession(this.context, request.params, request.trace);
      case zcodeProtocolMethods.sessionResume:
        return await resumeSession(this.context, request.params);
      case zcodeProtocolMethods.sessionList:
        return await listSessions(this.context, request.params);
      case zcodeProtocolMethods.sessionSubagents:
        return await listSessionSubagents(this.context, request.params);
      case zcodeProtocolMethods.sessionRead:
        return await readSession(this.context, request.params);
      case zcodeProtocolMethods.sessionMessages:
        return await readMessages(this.context, request.params);
      case zcodeProtocolMethods.sessionEvents:
        return await readEvents(this.context, request.params);
      case zcodeProtocolMethods.sessionSubscribe:
        return await subscribeSession(this.context, request.params);
      case zcodeProtocolMethods.sessionSend:
        return await sendPrompt(this.context, request.params);
      case zcodeProtocolMethods.sessionStop:
        return await stopSession(this.context, request.params);
      case zcodeProtocolMethods.sessionCancelBackgroundTask:
        return await cancelBackgroundTask(this.context, request.params);
      case zcodeProtocolMethods.sessionFork:
        return await forkSession(this.context, request.params);
      case zcodeProtocolMethods.sessionCompact:
        return await compactSession(this.context, request.params);
      case zcodeProtocolMethods.sessionReviewProjectMemory: {
        const params = parseParams(zcodeSessionReviewProjectMemoryParamsSchema, request.params);
        const record = this.context.sessions.get(params.sessionId);
        if (!record)
          throw new ProtocolRequestError(-32020, `Session not found: ${params.sessionId}`);
        return await record.app.runtime.reviewProjectMemoryNow();
      }
      case zcodeProtocolMethods.sessionReadProjectMemoryReview: {
        const params = parseParams(zcodeSessionReadProjectMemoryReviewParamsSchema, request.params);
        const record = this.context.sessions.get(params.sessionId);
        if (!record)
          throw new ProtocolRequestError(-32020, `Session not found: ${params.sessionId}`);
        return (
          (await this.context.deps.sessionStore?.getProjectMemoryReview?.(
            record.workspace.workspaceKey,
          )) ?? null
        );
      }
      case zcodeProtocolMethods.sessionCancelProjectMemoryReview: {
        const params = parseParams(
          zcodeSessionCancelProjectMemoryReviewParamsSchema,
          request.params,
        );
        const record = this.context.sessions.get(params.sessionId);
        if (!record)
          throw new ProtocolRequestError(-32020, `Session not found: ${params.sessionId}`);
        const workspaceKey = record.workspace.workspaceKey;
        const accepted =
          (await this.context.deps.sessionStore?.requestCancelProjectMemoryReview?.({
            workspaceKey,
            reviewId: params.reviewId,
          })) ?? false;
        if (accepted) {
          for (const candidate of this.context.sessions.values()) {
            if (candidate.workspace.workspaceKey === workspaceKey) {
              candidate.app.runtime.cancelProjectMemoryReview();
            }
          }
        }
        return { accepted };
      }
      case zcodeProtocolMethods.sessionGoal:
        return await goalSession(this.context, request.params);
      case zcodeProtocolMethods.sessionSetModel:
        return await setModel(this.context, request.params);
      case zcodeProtocolMethods.sessionSetThoughtLevel:
        return await setThoughtLevel(this.context, request.params);
      case zcodeProtocolMethods.sessionSetMode:
        return await setMode(this.context, request.params);
      case zcodeProtocolMethods.sessionClose:
        return await closeSession(this.context, request.params);
      case zcodeProtocolMethods.workspaceReadPresentation:
        return await readWorkspacePresentation(this.context, request.params);
      case zcodeProtocolMethods.workspaceHookTrustGrant: {
        const grantResult = await grantWorkspaceHookTrustForProtocol(request.params, {
          appVersion: this.context.deps.version,
          policyProvider: this.context.deps.workspaceHookPolicyProvider,
        });
        if (grantResult.accepted) {
          await notifyWorkspaceHookTrustGrantSessions({
            // dispatch 层的 params 是弱类型；grant 内部已用同一 schema parse 过，这里
            // safeParse 只为取出 workspaceKey 做匹配，失败即跳过通知（防御，正常必成功）。
            grantedWorkspaceKey: zcodeWorkspaceHookTrustGrantParamsSchema.safeParse(request.params)
              .success
              ? zcodeWorkspaceHookTrustGrantParamsSchema.parse(request.params).workspace
                  .workspaceKey
              : undefined,
            sessions: this.context.sessions,
          });
        }
        return grantResult;
      }
      case zcodeProtocolMethods.providerUpdateAccountConfig:
        return await updateAccountProviderConfig(this.context, request.params);
      case zcodeProtocolMethods.workspaceUpdateInteractionPreferences:
        return await updateInteractionPreferences(this.context, request.params);
      case zcodeProtocolMethods.workspaceUpdateMemoryPreferences:
        return await updateMemoryPreferences(this.context, request.params);
      case zcodeProtocolMethods.workspaceMemory:
        return await workspaceMemory(this.context, request.params);
      case zcodeProtocolMethods.workspaceUpdateModelIoPreferences:
        return await updateModelIoPreferences(this.context, request.params);
      case zcodeProtocolMethods.workspaceUpdateTelemetryConsent:
        return await updateTelemetryConsent(request.params);
      case zcodeProtocolMethods.workspaceUpdateOffPeakToolPolicy:
        return await updateOffPeakToolPolicy(this.context, request.params);
      case zcodeProtocolMethods.workspaceUpdateDynamicWorkflowPolicy:
        return await updateDynamicWorkflowPolicy(this.context, request.params);
      case zcodeProtocolMethods.workspaceGenerateText:
        return await this.withWorkspaceGenerateTextSignal(request, (signal) =>
          generateWorkspaceText(this.context, request.params, signal),
        );
      case zcodeProtocolMethods.workspaceCancelGenerateText:
        return this.cancelWorkspaceGenerateText(request.params);
      case zcodeProtocolMethods.providerTestModelConnectivity:
        return await testProviderModelConnectivity(this.context, request.params);
      case zcodeProtocolMethods.mcpList:
        return await listMcpServers(this.context, request.params);
      case zcodeProtocolMethods.mcpReadResource:
        return await readMcpUiResource(this.context, request.params);
      case zcodeProtocolMethods.mcpUiOpenInstance:
        return openMcpUiInstance(this.context, request.params);
      case zcodeProtocolMethods.mcpUiValidateInstance:
        return validateMcpUiInstance(this.context, request.params);
      case zcodeProtocolMethods.mcpUiCloseInstance:
        return closeMcpUiInstance(this.context, request.params);
      case zcodeProtocolMethods.mcpUiSampling:
        return sampleMcpUi(this.context, request.params);
      case zcodeProtocolMethods.mcpUiCancelSampling:
        return cancelMcpUiSampling(this.context, request.params);
      case zcodeProtocolMethods.mcpUiCallTool:
        return await callMcpUiTool(this.context, request.params);
      case zcodeProtocolMethods.mcpUiCancelCall:
        return await cancelMcpUiToolCall(this.context, request.params);
      case zcodeProtocolMethods.mcpUiReadResource:
        return await readMcpUiResourceForUi(this.context, request.params);
      case zcodeProtocolMethods.mcpUiListResources:
        return await listMcpUiResources(this.context, request.params);
      case zcodeProtocolMethods.mcpUiListResourceTemplates:
        return await listMcpUiResourceTemplates(this.context, request.params);
      case zcodeProtocolMethods.mcpUiSubscribeResource:
        return await subscribeMcpUiResource(this.context, request.params);
      case zcodeProtocolMethods.mcpUiUnsubscribeResource:
        return await unsubscribeMcpUiResource(this.context, request.params);
      case zcodeProtocolMethods.mcpUiRegisterAppTools:
        return await registerMcpUiAppTools(this.context, request.params);
      case zcodeProtocolMethods.mcpUiUnregisterAppTools:
        return await unregisterMcpUiAppTools(this.context, request.params);
      case zcodeProtocolMethods.mcpUiClaimAppToolCall:
        return await claimMcpUiAppToolCall(this.context, request.params);
      case zcodeProtocolMethods.mcpUiResolveAppToolCall:
        return await resolveMcpUiAppToolCall(this.context, request.params);
      case zcodeProtocolMethods.pluginsList:
        return await listPlugins(this.context, request.params);
      case zcodeProtocolMethods.pluginsReferenceCatalogWithCategory:
        return await getPluginReferenceCatalog(this.context, request.params, true);
      case zcodeProtocolMethods.pluginsReferenceCatalog:
        return await getPluginReferenceCatalog(this.context, request.params);
      case zcodeProtocolMethods.pluginsListUiSurfaces:
        return await listPluginUiSurfaces(this.context, request.params);
      case zcodeProtocolMethods.skillsReferenceCatalog:
        return await getSkillReferenceCatalog(this.context, request.params);
      case zcodeProtocolMethods.workflowsList:
        return await listSavedWorkflowsOp(this.context, request.params);
      case zcodeProtocolMethods.workflowsGet:
        return await getSavedWorkflowOp(this.context, request.params);
      case zcodeProtocolMethods.workflowsUpdateMeta:
        return await updateSavedWorkflowMetaOp(this.context, request.params);
      case zcodeProtocolMethods.workflowsDelete:
        return await deleteSavedWorkflowOp(this.context, request.params);
      case zcodeProtocolMethods.workflowsRuns:
        return await listSavedWorkflowRunsOp(this.context, request.params);
      case zcodeProtocolMethods.workflowsMove:
        return await moveSavedWorkflowOp(this.context, request.params);
      case zcodeProtocolMethods.workflowsSave:
        return await saveSavedWorkflowFromRunOp(this.context, request.params);
      case zcodeProtocolMethods.workflowsForRun:
        return await findSavedWorkflowForRunOp(this.context, request.params);
      case zcodeProtocolMethods.pluginsResolveSuggestedReference:
        return await this.withPluginOperationSignal(request, (signal) =>
          resolveSuggestedPluginReference(this.context, request.params, signal),
        );
      case zcodeProtocolMethods.pluginsSetEnabled:
        return await this.withPluginOperationSignal(request, (signal) =>
          setPluginEnabled(this.context, request.params, signal),
        );
      case zcodeProtocolMethods.pluginsOverview:
        return await getPluginsOverview(this.context, request.params);
      case zcodeProtocolMethods.processChildProcesses:
        return listChildProcesses(this.context.deps.mcpTelemetry?.listProcesses() ?? []);
      case zcodeProtocolMethods.runtimeCapabilities:
        return { independentPlanState: true };
      case zcodeProtocolMethods.pluginsMarketplaceAdd:
        return await this.withPluginOperationSignal(request, (signal) =>
          addPluginMarketplace(this.context, request.params, signal),
        );
      case zcodeProtocolMethods.pluginsMarketplaceRemove:
        return await removePluginMarketplace(this.context, request.params);
      case zcodeProtocolMethods.pluginsMarketplaceUpdate:
        return await this.withPluginOperationSignal(request, (signal) =>
          updatePluginMarketplace(this.context, request.params, signal),
        );
      case zcodeProtocolMethods.pluginsInstall:
        return await this.withPluginOperationSignal(request, (signal) =>
          installPlugin(this.context, request.params, signal),
        );
      case zcodeProtocolMethods.pluginsCancelOperation:
        return this.cancelPluginOperation(request.params);
      case zcodeProtocolMethods.pluginsUninstall:
        return await uninstallPlugin(this.context, request.params);
      case zcodeProtocolMethods.pluginsUpdate:
        return await updatePlugin(this.context, request.params);
      case zcodeProtocolMethods.pluginsRestoreBuiltin:
        return await restoreBuiltinPlugin(this.context, request.params);
      case zcodeProtocolMethods.pluginsConfigure:
        return await configurePlugin(this.context, request.params);
      case zcodeProtocolMethods.pluginsResetConfig:
        return await resetPluginConfig(this.context, request.params);
      case zcodeProtocolMethods.pluginsValidate:
        return await validatePlugin(this.context, request.params);
      case zcodeProtocolMethods.pluginsDescribe:
        return await describePlugin(this.context, request.params);
      case zcodeProtocolMethods.usageStats:
        return await getUsageStats(this.context, request.params);
      case zcodeProtocolMethods.sessionDebug:
        return querySessionDebug(this.context, request.params);
      case zcodeProtocolMethods.sessionUsage:
        return await getTaskTokenUsage(this.context, request.params);
      default:
        throw new ProtocolRequestError(-32601, `Method not found: ${request.method}`);
    }
  }
}
