// Modified by ZCode Feiyu contributors (2026).
import { createHash } from "node:crypto";
import { createSessionId, type WorkspaceId } from "@zcode/contracts";
import type { ZCodeProtocolTrace, ZCodeSessionCreateParams } from "@zcode/shared";
import { projectIdFromDirectory } from "../app/paths.js";
import {
  createProtocolRootTraceContext,
  ProtocolRequestError,
  type ZCodeProtocolAgentServerContext,
  type ZCodeProtocolSessionRecord,
} from "./server-types.js";

// 只共享在飞物化；结束即删除。持久幂等真值在 SessionStore，不把 promise 当任务队列。
const materializations = new WeakMap<
  ZCodeProtocolAgentServerContext,
  Map<string, Promise<ZCodeProtocolSessionRecord>>
>();
const ORIGIN_UNAVAILABLE = "Persistent session create origin is unavailable";

/** origin 是请求幂等键而非会话 ID，也不改变原 workspace/权限/工具配置入口。 */
export async function getOrCreateSessionRecordByOrigin(
  context: ZCodeProtocolAgentServerContext,
  params: ZCodeSessionCreateParams,
  trace: ZCodeProtocolTrace | undefined,
  activate: (sessionId: string) => Promise<ZCodeProtocolSessionRecord>,
): Promise<ZCodeProtocolSessionRecord> {
  if (
    !params.originCommandId ||
    params.persistence === "deferred" ||
    params.importedHistory ||
    params.sessionId
  ) {
    throw new ProtocolRequestError(
      -32602,
      "originCommandId requires a persistent create without imported history or sessionId",
    );
  }
  const store = context.deps.sessionStore;
  if (!store?.getOrCreateSessionByOrigin)
    throw new ProtocolRequestError(-32603, ORIGIN_UNAVAILABLE);
  const workspace = params.workspace;
  const sessionId = createSessionId();
  // 排除 transport attachment 和观测 trace；相同 workspace 的重连不应变成另一项创建。
  // 保存摘要而非配置正文，MCP 凭据不能复制到来源 entry。
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify(
        {
          workspacePath: workspace.workspacePath,
          originRequestFingerprint: params.originRequestFingerprint,
          originTitle: params.originTitle,
          parentSessionId: params.parentSessionId,
          mode: params.mode ?? "build",
          model: params.model,
          thoughtLevel: params.thoughtLevel,
          titleGenerationEnabled: params.titleGenerationEnabled !== false,
          mcpServers: params.mcpServers ?? [],
          toolAllowlist: params.toolAllowlist,
          toolDenylist: params.toolDenylist,
          offPeakToolEnabled: params.offPeakToolEnabled === true,
          dynamicWorkflowEnabled: params.dynamicWorkflowEnabled === true,
        },
        (_key, value: unknown) =>
          value && typeof value === "object" && !Array.isArray(value)
            ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
            : value,
      ),
    )
    .digest("hex");
  const session = await store.getOrCreateSessionByOrigin(
    {
      id: sessionId,
      projectID: projectIdFromDirectory(workspace.workspacePath),
      workspaceID: workspace.workspaceIdentity?.trim() as WorkspaceId | undefined,
      parentID: params.parentSessionId as typeof sessionId | undefined,
      traceID: createProtocolRootTraceContext(sessionId, trace).traceId,
      taskType: "interactive",
      slug: sessionId,
      directory: workspace.workspacePath,
      path: workspace.workspacePath,
      title: params.originTitle ?? "Untitled session",
      titleSource: params.originTitle ? "custom" : "default",
      version: context.deps.version ?? "unknown",
      permission: { mode: params.mode ?? "build" },
    },
    {
      commandId: params.originCommandId,
      requestFingerprint: fingerprint,
      ...(params.originRequestFingerprint
        ? { commandFingerprint: params.originRequestFingerprint }
        : {}),
      modelSelection: params.model,
    },
  );
  let inFlight = materializations.get(context);
  if (!inFlight) {
    inFlight = new Map();
    materializations.set(context, inFlight);
  }
  let pending = inFlight.get(session.id);
  if (!pending) {
    const owners = inFlight;
    pending = activate(session.id).finally(() => {
      owners.delete(session.id);
    });
    owners.set(session.id, pending);
  }
  return pending;
}
