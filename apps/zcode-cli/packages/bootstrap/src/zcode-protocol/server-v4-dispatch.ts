// Modified by ZCode Feiyu.
import type { ZCodeProtocolRequest } from "@zcode/shared";

import {
  V4_METHODS,
  V4_NOTIFICATIONS,
  parseSessionsIndexTopic,
  parseWorkspaceConfigTopic,
} from "@zcode/shared/zcode-protocol-v4";

import { getTaskTokenUsage, getUsageStats } from "./server-operations.js";

import { ProtocolServerLifecycle } from "./server-lifecycle.js";
// V4 分派仍复用同一 server context 和 ACK 后 outbox，没有独立协议状态。
export class ProtocolServerV4Dispatch extends ProtocolServerLifecycle {
  protected async dispatchV4Request(request: ZCodeProtocolRequest): Promise<unknown> {
    switch (request.method) {
      // ── v4 conversation 通道（竖切，与旧 session/* 并存）──
      case V4_METHODS.connectionFlow: {
        this.requireV4Gateway().setConnectionFlowState(request.params);
        return {};
      }

      case V4_METHODS.conversationSubscribe: {
        // 同一 subscribe 方法按 topic 前缀分派：
        // sessions-index/* → 列表订阅；workspace-config/* → 配置目录订阅；否则 conversation。
        const gateway = this.requireV4Gateway();
        const topic = (request.params as { topic?: unknown } | null)?.topic;
        let dispatch;
        if (typeof topic === "string" && parseSessionsIndexTopic(topic) !== null) {
          dispatch = await gateway.subscribeSessionsIndexReserved(request.params);
        } else if (typeof topic === "string" && parseWorkspaceConfigTopic(topic) !== null) {
          dispatch = await gateway.subscribeWorkspaceConfigReserved(request.params);
        } else {
          dispatch = await gateway.subscribeReserved(request.params);
        }
        if (dispatch.initialWires.length > 0) {
          this.postResponseOutbox.set(request.id, {
            messages: dispatch.initialWires.map((wire) => ({
              method: V4_NOTIFICATIONS.conversationFrame,
              params: wire,
            })),
            commit: dispatch.commit,
          });
        }
        return { ack: dispatch.ack };
      }

      case V4_METHODS.conversationResync: {
        // same-sub recovery 与 subscribe 共用确定性 post-response outbox；公共
        // response 仍 strict ACK-only，physical recovery 只能在 ACK line 后发送。
        const dispatch = this.requireV4Gateway().resyncReserved(request.params);
        if (dispatch.initialWires.length > 0) {
          this.postResponseOutbox.set(request.id, {
            messages: dispatch.initialWires.map((wire) => ({
              method: V4_NOTIFICATIONS.conversationFrame,
              params: wire,
            })),
            commit: dispatch.commit,
          });
        }
        return { ack: dispatch.ack };
      }

      case V4_METHODS.conversationUnsubscribe: {
        // topic + subscriptionId + connectionId 精确命中唯一 publisher；禁止按裸
        // subId 对 conversation/sessions-index/workspace-config 广撒网。
        this.requireV4Gateway().unsubscribe(request.params);
        return {};
      }

      // ── 行分页 query（独立分支，便于与帧分派改动合并）──
      case V4_METHODS.conversationRowsRange:
        return await this.requireV4Gateway().rowsRange(request.params);

      case V4_METHODS.conversationPlans:
        return await this.requireV4Gateway().plans(request.params);

      case V4_METHODS.backgroundBashOutput:
        return await this.requireV4Gateway().backgroundBashOutput(request.params);

      case V4_METHODS.conversationFileChanges:
        return await this.requireV4Gateway().fileChanges(request.params);

      case V4_METHODS.conversationFileRewindPreview:
        return await this.requireV4Gateway().fileRewindPreview(request.params);

      // workflow run 事件日志分页（只读、无状态、超时重发安全；新方法天然偏斜安全）。
      case V4_METHODS.conversationWorkflowRunEvents:
        return await this.requireV4Gateway().workflowRunEvents(request.params);

      // dwf run 枚举（重启后的发现查询）。
      case V4_METHODS.conversationWorkflowRuns:
        return await this.requireV4Gateway().workflowRuns(request.params);

      // dwf 用户面产物的三个读面。同族：只读、无状态、
      // 超时重发安全；ArtifactRead 的授权在宿主端口侧，网关只校参数与分块。
      case V4_METHODS.conversationWorkflowRunArtifacts:
        return await this.requireV4Gateway().workflowRunArtifacts(request.params);

      case V4_METHODS.conversationWorkflowRunArtifactData:
        return await this.requireV4Gateway().workflowRunArtifactData(request.params);

      case V4_METHODS.conversationWorkflowRunArtifactRead:
        return await this.requireV4Gateway().workflowRunArtifactRead(request.params);

      // dwf 工作区 transcript 的两个读面。同族。
      case V4_METHODS.conversationWorkflowRunWorkspace:
        return await this.requireV4Gateway().workflowRunWorkspace(request.params);

      case V4_METHODS.conversationWorkflowRunNodeResult:
        return await this.requireV4Gateway().workflowRunNodeResult(request.params);

      // 附件只能走小 RPC transaction，禁止 full-data attachment/put 单行。
      case V4_METHODS.attachmentBegin:
        return await this.requireV4Gateway().attachmentBegin(request.params);

      case V4_METHODS.attachmentChunk:
        return await this.requireV4Gateway().attachmentChunk(request.params);

      case V4_METHODS.attachmentCommit:
        return await this.requireV4Gateway().attachmentCommit(request.params);

      case V4_METHODS.attachmentAbort:
        await this.requireV4Gateway().attachmentAbort(request.params);
        return {};

      case V4_METHODS.attachmentRead:
        return await this.requireV4Gateway().attachmentRead(request.params);

      case V4_METHODS.conversationAttachmentRead:
        return await this.requireV4Gateway().conversationAttachmentRead(request.params);

      case V4_METHODS.conversationAttachmentStat:
        return await this.requireV4Gateway().conversationAttachmentStat(request.params);

      case V4_METHODS.attachmentPreviewSource:
        return await this.requireV4Gateway().attachmentPreviewSource(request.params);

      // ── usage query（additive）：与旧 usage/stats、session/usage 同一数据访问
      // 层（usage store 聚合），仅换 v4 名字空间——不经 v4Gateway（无会话投影依赖），
      // 也不经旧 op 分派（无桥）。旧 case 保留到旧词删除（老 host 版本兼容）。──
      case V4_METHODS.usageStats:
        return await getUsageStats(this.context, request.params);

      case V4_METHODS.conversationUsage:
        return await getTaskTokenUsage(this.context, request.params);

      case V4_METHODS.command:
        return this.requireV4Gateway().handleCommand(request.params);

      case V4_METHODS.commandsQuery:
        return this.requireV4Gateway().queryCommands(request.params);
    }
  }
}
