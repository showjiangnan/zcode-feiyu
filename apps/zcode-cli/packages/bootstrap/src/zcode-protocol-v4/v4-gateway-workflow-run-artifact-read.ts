// Modified by ZCode Feiyu.
import type {
  V4ConversationWorkflowRunArtifactReadResult,
  V4ConversationWorkflowRunWorkspaceResult,
  V4ConversationWorkflowRunNodeResultResult,
  V4ConversationFileChangesResult,
  BackgroundBashOutputResult,
  V4ConversationFileRewindPreviewResult,
} from "@zcode/shared/zcode-protocol-v4";
import {
  v4ConversationWorkflowRunArtifactReadParamsSchema,
  v4ConversationWorkflowRunArtifactReadResultSchema,
  v4ConversationWorkflowRunWorkspaceParamsSchema,
  WORKFLOW_WORKSPACE_LIMITS,
  v4ConversationWorkflowRunWorkspaceResultSchema,
  v4ConversationWorkflowRunNodeResultParamsSchema,
  v4ConversationWorkflowRunNodeResultResultSchema,
  v4ConversationFileChangesParamsSchema,
  v4BackgroundBashOutputParamsSchema,
  backgroundBashOutputResultSchema,
  v4ConversationFileRewindPreviewParamsSchema,
} from "@zcode/shared/zcode-protocol-v4";
import { V4CapabilityUnsupportedError } from "./commands/handlers/interaction-background.js";
import { toRuntimeTurnId } from "./v4-gateway-to-runtime-turn-id.js";
import type { ConversationV4Gateway } from "./v4-gateway.js";

export async function workflowRunArtifactRead(
  this: ConversationV4Gateway,
  rawParams: unknown,
): Promise<V4ConversationWorkflowRunArtifactReadResult> {
  const params = v4ConversationWorkflowRunArtifactReadParamsSchema.parse(rawParams);
  if (!this["host"].readDynamicWorkflowRunArtifact) {
    throw new V4CapabilityUnsupportedError("readDynamicWorkflowRunArtifact", params.sessionId);
  }
  await this["ensureHostRecordForJournalRead"](params.sessionId);
  const artifact = await this["readWorkflowArtifactPayload"](params);
  const totalBytes = artifact.bytes.byteLength;
  const start = Math.min(params.offset, totalBytes);
  const end = Math.min(start + params.limit, totalBytes);
  const chunk = artifact.bytes.subarray(start, end);
  return v4ConversationWorkflowRunArtifactReadResultSchema.parse({
    dataBase64: Buffer.from(chunk).toString("base64"),
    mediaType: artifact.mediaType,
    totalBytes,
    nextOffset: end < totalBytes ? end : null,
  });
}

export async function workflowRunWorkspace(
  this: ConversationV4Gateway,
  rawParams: unknown,
): Promise<V4ConversationWorkflowRunWorkspaceResult> {
  const params = v4ConversationWorkflowRunWorkspaceParamsSchema.parse(rawParams);
  if (!this["host"].listDynamicWorkflowRunWorkspaceNodes) {
    throw new V4CapabilityUnsupportedError(
      "listDynamicWorkflowRunWorkspaceNodes",
      params.sessionId,
    );
  }
  await this["ensureHostRecordForJournalRead"](params.sessionId);
  const nodes =
    (await this["host"].listDynamicWorkflowRunWorkspaceNodes(params.sessionId, {
      runId: params.runId,
    })) ?? [];
  const truncated = nodes.length > WORKFLOW_WORKSPACE_LIMITS.maxNodes;
  return v4ConversationWorkflowRunWorkspaceResultSchema.parse({
    nodes: truncated ? nodes.slice(0, WORKFLOW_WORKSPACE_LIMITS.maxNodes) : nodes,
    ...(truncated ? { truncated: true } : {}),
  });
}

export async function workflowRunNodeResult(
  this: ConversationV4Gateway,
  rawParams: unknown,
): Promise<V4ConversationWorkflowRunNodeResultResult> {
  const params = v4ConversationWorkflowRunNodeResultParamsSchema.parse(rawParams);
  if (!this["host"].readDynamicWorkflowRunNodeResult) {
    throw new V4CapabilityUnsupportedError("readDynamicWorkflowRunNodeResult", params.sessionId);
  }
  await this["ensureHostRecordForJournalRead"](params.sessionId);
  const maxBytes = Math.max(
    1,
    Math.min(
      params.maxBytes ?? WORKFLOW_WORKSPACE_LIMITS.resultMaxBytes,
      WORKFLOW_WORKSPACE_LIMITS.resultMaxBytes,
    ),
  );
  const result = await this["host"].readDynamicWorkflowRunNodeResult(params.sessionId, {
    runId: params.runId,
    siteId: params.siteId,
    ordinal: params.ordinal,
    maxBytes,
  });
  if (result === undefined) {
    throw new Error(
      `fault.workflowRunNodeResult.notFound: ${params.runId}/${params.siteId}@${params.ordinal}`,
    );
  }
  return v4ConversationWorkflowRunNodeResultResultSchema.parse(result);
}

export function readWorkflowArtifactPayload(
  this: ConversationV4Gateway,
  params: {
    sessionId: string;
    runId: string;
    artifactId: string;
    version: number;
  },
): Promise<{ bytes: Uint8Array; mediaType: string }> {
  const now = this["now"]();
  this["pruneBinaryReadCache"](now);
  // 首段标签 `dwfart`：与附件预览共用同一张表，靠首段隔离（见 BinaryReadCacheEntry）。
  const key = `dwfart\u0000${params.sessionId}\u0000${params.runId}\u0000${params.artifactId}\u0000${params.version}`;
  const cached = this["binaryReadCache"].get(key);
  if (cached) {
    cached.accessedAt = now;
    return cached.payload;
  }
  const payload = this["host"].readDynamicWorkflowRunArtifact!(params.sessionId, {
    runId: params.runId,
    artifactId: params.artifactId,
    version: params.version,
  })
    .then((artifact) => {
      if (artifact === undefined) {
        throw new Error(
          `fault.workflowRunArtifactRead.notFound: ${params.runId}/${params.artifactId}@${params.version}`,
        );
      }
      const current = this["binaryReadCache"].get(key);
      if (current) {
        current.bytes = artifact.bytes.byteLength;
        this["binaryReadCacheBytes"] += artifact.bytes.byteLength;
        this["pruneBinaryReadCache"](this["now"]());
      }
      // contentType 归一成表里的 mediaType 词汇；值仍是 journal 记录上的那一份
      // （UI 分派渲染器的精确匹配契约），不是 store 按文件名再推的那个。
      return { bytes: artifact.bytes, mediaType: artifact.contentType };
    })
    .catch((error: unknown) => {
      this["deleteBinaryReadCacheEntry"](key);
      throw error;
    });
  this["binaryReadCache"].set(key, {
    sessionId: params.sessionId,
    accessedAt: now,
    bytes: null,
    payload,
  });
  return payload;
}

export async function ensureHostRecordForJournalRead(
  this: ConversationV4Gateway,
  sessionId: string,
): Promise<void> {
  if (this["hasLiveConversation"](sessionId)) return;
  await this["coldResume"].ensureResumed(sessionId);
}

export async function fileChanges(
  this: ConversationV4Gateway,
  rawParams: unknown,
): Promise<V4ConversationFileChangesResult> {
  const params = v4ConversationFileChangesParamsSchema.parse(rawParams);
  if (!this["host"].getConversationFileChanges) {
    throw new Error("fault.fileChanges.unsupported");
  }
  const existingReady = this["readyFlights"].get(params.sessionId);
  const publisher = existingReady
    ? await existingReady
    : !this["hasLiveConversation"](params.sessionId)
      ? await this["ensureColdReadyPublisher"](params.sessionId)
      : await this["hydratePublisher"](params.sessionId);
  const resolution = this["resolveQueryRowTarget"](publisher, params, "fileChanges");
  const messageIds = resolution.messageIds ?? [];
  const targetTurnId = toRuntimeTurnId(resolution.row.turnId);
  return this["host"].getConversationFileChanges(
    params.sessionId,
    params.target.rowId,
    messageIds,
    targetTurnId,
  );
}

export async function backgroundBashOutput(
  this: ConversationV4Gateway,
  rawParams: unknown,
): Promise<BackgroundBashOutputResult> {
  const { sessionId, workId } = v4BackgroundBashOutputParamsSchema.parse(rawParams);
  // 观察查询不能 hydrate/恢复冷会话；任务由现有 runtime 授权。
  if (!this["host"].readBackgroundBashOutput) return { kind: "unsupported", workId };
  return backgroundBashOutputResultSchema.parse(
    await this["host"].readBackgroundBashOutput(sessionId, workId),
  );
}

export async function fileRewindPreview(
  this: ConversationV4Gateway,
  rawParams: unknown,
): Promise<V4ConversationFileRewindPreviewResult> {
  const params = v4ConversationFileRewindPreviewParamsSchema.parse(rawParams);
  if (!this["host"].previewConversationFileRewind) {
    throw new Error("fault.fileRewindPreview.unsupported");
  }
  const existingReady = this["readyFlights"].get(params.sessionId);
  const publisher = existingReady
    ? await existingReady
    : !this["host"].sessionExists(params.sessionId)
      ? await this["ensureColdReadyPublisher"](params.sessionId)
      : await this["hydratePublisher"](params.sessionId);
  const resolution = this["resolveQueryRowTarget"](publisher, params, "fileRewindPreview");
  const messageIds = resolution.messageIds ?? [];
  const targetTurnId = toRuntimeTurnId(resolution.row.turnId);
  return this["host"].previewConversationFileRewind(
    params.sessionId,
    params.target.rowId,
    messageIds,
    targetTurnId,
  );
}
