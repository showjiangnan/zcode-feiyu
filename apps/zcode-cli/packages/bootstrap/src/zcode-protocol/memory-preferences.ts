// Modified by ZCode Feiyu contributors (2026).
import { zcodeWorkspaceUpdateMemoryPreferencesParamsSchema } from "@zcode/shared";
import { parseParams, type ZCodeProtocolAgentServerContext } from "./server-types.js";
import { getWorkspaceMaintenanceApps } from "./maintenance-registry.js";
import { startProactiveDispatcher } from "./proactive-dispatcher.js";

const applications = new WeakMap<ZCodeProtocolAgentServerContext, Promise<unknown>>();

export async function updateMemoryPreferences(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeWorkspaceUpdateMemoryPreferencesParamsSchema, rawParams);
  const previous = applications.get(context) ?? Promise.resolve();
  // 同 context 的版本决策与全目标收口串行；一次失败不毒化后续同版本重试。
  const application = previous.catch(() => undefined).then(() => applyPreferences(context, params));
  applications.set(context, application);
  return application;
}

async function applyPreferences(
  context: ZCodeProtocolAgentServerContext,
  params: ReturnType<typeof zcodeWorkspaceUpdateMemoryPreferencesParamsSchema.parse>,
) {
  const requested = normalizePreferences(params.preferences);
  const current =
    context.appRuntimePreferences.memory &&
    normalizePreferences(context.appRuntimePreferences.memory);
  if (
    current &&
    current.policyRevision === requested.policyRevision &&
    JSON.stringify(current) !== JSON.stringify(requested)
  ) {
    throw new Error("Runtime policy revision was reused with different preferences");
  }
  // 旧请求不能回滚门禁；仍须对本工作区实际应用当前版本，不能仅返回门禁中的版本伪造 ACK。
  const preferences =
    current && current.policyRevision > requested.policyRevision ? current : requested;
  context.appRuntimePreferences.memory = preferences;
  startProactiveDispatcher(context, params.workspace);
  const records = [...context.sessions.values()].filter(
    (record) => record.workspace.workspaceKey === params.workspace.workspaceKey,
  );
  const results = await Promise.allSettled([
    ...records.map(async (record) => {
      await record.app.runtime.updateProjectMemoryPreferences(preferences);
      record.memoryEnabled = preferences.enabled;
      record.memoryExtractionEnabled = preferences.extractionEnabled;
      record.memoryReviewEnabled = preferences.reviewEnabled;
    }),
    ...[...getWorkspaceMaintenanceApps(context).values()].map((app) =>
      app.runtime.updateProjectMemoryPreferences(preferences),
    ),
    ...(preferences.continuityPolicy?.proactiveWorkAllowed === false
      ? [
          // 活跃 owner 必须先发布自身状态变化；数据库批量暂停只处理未加载会话。
          context.deps.sessionStore?.pauseProactiveWorkspace?.(
            params.workspace.workspaceKey,
            "permission_disabled",
            records.map((record) => record.app.sessionId),
          ),
        ]
      : []),
  ]);
  const failedCount = results.filter((result) => result.status === "rejected").length;
  if (failedCount > 0)
    throw new Error(`Project memory preference update failed for ${failedCount} active session(s)`);
  return { workspace: params.workspace, ...preferences, updatedSessionCount: records.length };
}

function normalizePreferences(
  input: NonNullable<ZCodeProtocolAgentServerContext["appRuntimePreferences"]["memory"]>,
) {
  return {
    policyRevision: input.policyRevision ?? 0,
    continuityPolicy: input.continuityPolicy,
    enabled: input.enabled,
    extractionEnabled: input.enabled && input.extractionEnabled,
    reviewEnabled: input.enabled && input.reviewEnabled,
  };
}
