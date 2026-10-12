// Modified by ZCode Feiyu.
import {
  SessionEventType,
  type WorkspaceHookBundleSnapshot,
  type WorkspaceHookReasonCode,
} from "@zcode/contracts";
import { type WorkspaceHookReviewTarget } from "@zcode/core";
import type {
  WorkspaceHookReviewDecision,
  WorkspaceHookReviewRequestPayload,
  WorkspaceHookTrustRevokeTarget,
} from "@zcode/shared/zcode-protocol-v4";
import { WorkspaceHookMutationError } from "@zcode/shared/workspace-hook-mutation";
import type { WorkspaceHookReviewCommandResult } from "./workspace-hook-review-types.js";
import { resolveWorkspaceHookReviewDigests } from "./workspace-hook-review-request.js";

import { applyWorkspaceHookRevoke } from "./workspace-hook-review-revoke.js";

import { WorkspaceHookReviewState } from "./workspace-hook-review-state.js";

export type * from "./workspace-hook-review-types.js"; // 拆分职责时原实例、状态和执行顺序保持唯一；继承链不新建队列或会话。
export class WorkspaceHookReviewController extends WorkspaceHookReviewState {
  /**
   * 软门禁:按需开审核 flow。
   *
   * 用户点击「去审核」时经 requestWorkspaceHookReview 命令调用。
   * 无 pending 项时为安全 no-op(返回 accepted)。
   * 已有活跃 flow 时幂等复用(openOrReuseFlow)。
   * 必须经 superviseFlow 监管——否则 flow 超时后会静默死亡、面板永久失效。
   */
  async requestReview(target: {
    workspaceIdentity: string;
    bundleDigest: string;
  }): Promise<WorkspaceHookReviewCommandResult> {
    const snapshot = this.admission.getCurrentSnapshot();
    if (
      target.workspaceIdentity !== snapshot.workspaceIdentity ||
      target.bundleDigest !== snapshot.bundleDigest
    ) {
      return {
        accepted: false,
        reasonCode: "workspace_hooks_snapshot_mismatch" as const,
      };
    }
    const evaluation = this.coordinator.evaluateSnapshot({ snapshot });
    // 旧实现只把 configuredEnabled=true 的 pending 当成可审核项，导致
    // Settings 把未信任开关锁定后形成死锁——disabled Hook 不会运行、不会触发 Banner，
    // 也永远无法预先建立 Trust。配置 gate 与 Trust 正交；review request 本就携带全部
    // snapshot items，因此按 admissionClass 判断即可，disabled item 信任后仍不会运行。
    const hasPending = evaluation.items.some((item) => item.admissionClass === "pending");
    if (!hasPending) {
      if (evaluation.items.some((item) => item.trustState === "blocked_policy")) {
        return {
          accepted: false,
          reasonCode: "workspace_hooks_blocked_by_policy" as const,
        };
      }
      if (evaluation.storeStatus === "corrupt") {
        return {
          accepted: false,
          reasonCode: "workspace_hooks_trust_store_corrupt" as const,
        };
      }
      // 无待审项:安全 no-op
      return { accepted: true, reviewItemIds: [] };
    }
    const flow = await this.openOrReuseFlow(snapshot, evaluation);
    void this.superviseFlow(flow).catch(() => undefined);
    return { accepted: true, reviewItemIds: [] };
  }

  respond(
    target: WorkspaceHookReviewTarget,
    decision: WorkspaceHookReviewDecision,
  ): Promise<WorkspaceHookReviewCommandResult> {
    return this.enqueueMutation(async () => {
      const validation = this.registry.validate(target, decision);
      if (!validation.accepted) {
        this.telemetry.responseRejected(target, validation.reasonCode);
        return validation;
      }
      const flow = this.registry.getCurrentFlow(this.sessionId);
      if (!flow) {
        return {
          accepted: false,
          reasonCode: "workspace_hooks_review_superseded" as const,
        };
      }
      const snapshot = this.admission.getCurrentSnapshot();
      // request 绑定打开时的 immutable snapshot bundle。今天
      // replaceSnapshot 只有 toggle 一个合法调用方（经 refreshPendingFlow supersede 旧
      // flow），等价校验靠这一隐式不变量；配置热监听 watcher 一旦成为第二
      // 个调用方且绕过 refreshPendingFlow，tombstone 缺失会让授权落到新 bundle 上。
      // 与 revokeCurrent 对齐显式校验，消除隐式依赖。
      if (
        target.workspaceIdentity !== snapshot.workspaceIdentity ||
        target.bundleDigest !== snapshot.bundleDigest
      ) {
        this.telemetry.responseRejected(target, "workspace_hooks_snapshot_mismatch");
        return {
          accepted: false,
          reasonCode: "workspace_hooks_snapshot_mismatch" as const,
        };
      }
      // grant 前显式检查 persistent Trust 的 policy 资格：applyDecision 内
      // assertPersistentTrustMutationAllowed 抛出的策略拒绝若落入下方 catch-all，
      // 会被一律报成 trust_store_corrupt（“信任存储损坏”），企业策略收紧时
      // 用户看到的是错误诊断；与 revoke 路径对齐：前置检查 + 精确 reasonCode。
      if (!this.coordinator.canMutatePersistentTrust(snapshot.workspaceIdentity)) {
        this.telemetry.responseRejected(target, "workspace_hooks_blocked_by_policy");
        return {
          accepted: false,
          reasonCode: "workspace_hooks_blocked_by_policy" as const,
        };
      }
      let applied: { grantedRecordCount?: number };
      try {
        applied = await this.applyPersistentTrust(validation.reviewItemIds);
      } catch (error) {
        // applyDecision 可因非存储原因抛错——resolveWorkspaceHookReviewDigests
        // 对未知 reviewItemId、coordinator 内部错误、store 落盘失败等。裸 catch 会把全部
        // 失败一律报成 trust_store_corrupt 且把原始错误彻底丢弃，与 toggle 路径同类。
        // reasonCode 不变（新增需 contracts 评审），仅把
        // errorMessage 透传进 telemetry 供回溯。
        //
        // 脱敏：WorkspaceHookMutationError 的 message 已在上游脱敏
        // （见 workspace-hook-review-mutation.ts 使用 workspaceIdentitySummary / digestSummary）。
        // 对任意 Error 仅取 error.message——上游抛错点必须保证消息不含绝对路径/完整 digest
        // （禁止上报完整 workspace path / source path）。
        this.telemetry.trustStoreFailure(
          target.bundleDigest,
          error instanceof Error ? error.message : String(error),
        );
        return {
          accepted: false,
          reasonCode: "workspace_hooks_trust_store_corrupt" as const,
        };
      }
      this.telemetry.decisionAccepted(target, decision, {
        ...(applied.grantedRecordCount === undefined
          ? {}
          : { grantedRecordCount: applied.grantedRecordCount }),
        requestEnabledCount: flow.request.items.filter((item) => item.configuredEnabled).length,
      });
      const resolved = this.registry.resolve(target, decision);
      // applyDecision 与 registry.resolve 非原子——两者之间若
      // registry 的 deadline timer 恰好触发，flow 变为 timed_out，resolve 返回
      // superseded，于是「Trust 已落盘」却回报「审核已过期」。用户据此重试、排障者
      // 据此以为没写成功——同样属于错误归属倒错。
      //
      // 决策已经生效（持久 Trust 已落盘），故按 accepted 回报并照发
      // Settled，让前端收敛到已决状态；resolve 被拒仅说明 flow 已被别的终态占用，
      // 不代表授权失败。此处只多不错：不会把未授权说成已授权。
      if (!resolved.accepted) {
        // 保留观测：flow 已被别的终态占用（通常是 deadline 恰好触发）。
        this.telemetry.responseRejected(target, resolved.reasonCode);
      }
      await this.host.emit({
        type: SessionEventType.WorkspaceHookReviewSettled,
        payload: { interactionId: target.interactionId, state: "resolved" },
      });
      // 软门禁:settle 后重新评估 pending 状态,通知投影层更新提示条
      await this.emitAdmissionUpdatedAfterMutation();
      // 行内逐条 Trust 不能让其他待审项一起失去操作入口。旧 generation settle 后，
      // 若仍有 pending 声明，立即发布下一 immutable generation；已信任行由 Settings
      // 刷新后消失，其他行继续可操作。
      await this.refreshPendingFlow(snapshot);
      return resolved.accepted
        ? resolved
        : {
            accepted: true as const,
            reviewItemIds: [...validation.reviewItemIds],
          };
    });
  }

  toggle(
    target: WorkspaceHookReviewTarget,
    reviewItemId: string,
    enabled: boolean,
  ): Promise<
    WorkspaceHookReviewCommandResult & {
      request?: WorkspaceHookReviewRequestPayload;
    }
  > {
    return this.enqueueMutation(async () => {
      const validation = this.registry.validate(target, {
        action: "trust_selected",
        reviewItemIds: [reviewItemId],
      });
      if (!validation.accepted) return validation;
      const currentSnapshot = this.admission.getCurrentSnapshot();
      const entry = currentSnapshot.hooks.find((item) => item.reviewItemId === reviewItemId);
      if (!entry?.editable) {
        return {
          accepted: false,
          reasonCode: "workspace_hooks_snapshot_mismatch" as const,
        };
      }
      let writeCommitted = false;
      let nextSnapshot: WorkspaceHookBundleSnapshot;
      try {
        nextSnapshot = await this.mutation.toggle(
          { snapshot: currentSnapshot, reviewItemId, enabled },
          () => {
            writeCommitted = true;
            this.admission.invalidate("workspace_hooks_config_rebuild_failed");
          },
        );
        this.admission.replaceSnapshot(nextSnapshot);
      } catch (error) {
        if (!writeCommitted) {
          // 裸 catch 曾把 mutation port 的全部失败一律报成
          // config_write_failed——包括发生在写盘之前的 snapshot mismatch（review 后
          // bundle 已变/discovery 读败）。用户据此重试"写"永远失败，也掩盖真实原因。
          // 按 WorkspaceHookMutationError.code 透传；telemetry 补 cause 便于定位。
          const isMutationError =
            error instanceof WorkspaceHookMutationError ||
            (error instanceof Error && error.name === "WorkspaceHookMutationError");
          const mutationCode = isMutationError
            ? ((error as WorkspaceHookMutationError).code as WorkspaceHookReasonCode)
            : ("workspace_hooks_config_write_failed" as const);
          this.telemetry.toggleFailure(
            target.bundleDigest,
            mutationCode,
            error instanceof Error ? error.message : String(error),
          );
          return {
            accepted: false,
            reasonCode: mutationCode as WorkspaceHookReasonCode,
          };
        }
        this.telemetry.toggleFailure(target.bundleDigest, "workspace_hooks_config_rebuild_failed");
        this.registry.fail(target, "workspace_hooks_config_rebuild_failed");
        await this.host.emit({
          type: SessionEventType.WorkspaceHookReviewSettled,
          payload: {
            interactionId: target.interactionId,
            state: "configuration_error",
            reasonCode: "workspace_hooks_config_rebuild_failed",
          },
        });
        return {
          accepted: false,
          reasonCode: "workspace_hooks_config_rebuild_failed" as const,
        };
      }

      const nextFlow = await this.refreshPendingFlow(nextSnapshot);
      // 软门禁:toggle 重建 bundle 后重新评估 pending 状态
      await this.emitAdmissionUpdatedAfterMutation();
      return {
        accepted: true,
        reviewItemIds: [reviewItemId],
        ...(nextFlow ? { request: nextFlow.request } : {}),
      };
    });
  }

  revoke(
    target: WorkspaceHookReviewTarget,
    reviewItemIds: readonly string[],
  ): Promise<WorkspaceHookReviewCommandResult> {
    return this.enqueueMutation(async () => {
      const validation = this.registry.validate(target, {
        action: "trust_selected",
        reviewItemIds: [...reviewItemIds],
      });
      if (!validation.accepted) return validation;
      const snapshot = this.admission.getCurrentSnapshot();
      const result = await applyWorkspaceHookRevoke({
        coordinator: this.coordinator,
        digests: resolveWorkspaceHookReviewDigests(snapshot, validation.reviewItemIds),
        reviewItemIds: validation.reviewItemIds,
        snapshot,
        store: this.store,
      });
      if (result.accepted) {
        this.telemetry.revoked(snapshot.bundleDigest, validation.reviewItemIds.length);
        await this.refreshPendingFlow(snapshot);
        // 软门禁:revoke 后重新评估 pending 状态
        await this.emitAdmissionUpdatedAfterMutation();
      }
      return result;
    });
  }

  revokeCurrent(target: WorkspaceHookTrustRevokeTarget): Promise<WorkspaceHookReviewCommandResult> {
    return this.enqueueMutation(async () => {
      const snapshot = this.admission.getCurrentSnapshot();
      if (
        target.sessionId !== this.sessionId ||
        target.remoteSessionId !== this.host.remoteSessionId ||
        target.workspaceIdentity !== snapshot.workspaceIdentity ||
        target.bundleDigest !== snapshot.bundleDigest
      ) {
        return {
          accepted: false,
          reasonCode: "workspace_hooks_snapshot_mismatch" as const,
        };
      }
      const digests = [...new Set(target.hookDeclarationDigests)];
      const entries = snapshot.hooks.filter((entry) =>
        digests.includes(entry.hookDeclarationDigest),
      );
      if (
        digests.length === 0 ||
        new Set(entries.map((entry) => entry.hookDeclarationDigest)).size !== digests.length
      ) {
        return {
          accepted: false,
          reasonCode: "workspace_hooks_snapshot_mismatch" as const,
        };
      }
      const result = await applyWorkspaceHookRevoke({
        coordinator: this.coordinator,
        digests,
        reviewItemIds: entries.map((entry) => entry.reviewItemId),
        snapshot,
        store: this.store,
      });
      if (result.accepted) {
        this.telemetry.revoked(snapshot.bundleDigest, digests.length);
        await this.refreshPendingFlow(snapshot);
        // 软门禁:revokeCurrent 后重新评估 pending 状态
        await this.emitAdmissionUpdatedAfterMutation();
      }
      return result;
    });
  }
}
