// Modified by ZCode Feiyu.
import {
  PROJECT_MEMORY_BATCH_CANCELLED_CODE,
  selectActiveConversationBranch,
  type ProjectMemoryExtractionCursorPort,
} from "@zcode/contracts";
import type {
  MessageId,
  ProjectMemoryReviewClaim,
  ProjectMemoryReviewClaimInput,
  ProjectMemoryReviewFinishInput,
  ProjectMemoryReviewRecord,
  SessionId,
} from "@zcode/contracts";
import * as messageRepository from "./repositories/messages.js";
import * as projectMemoryExtractionCursorRepository from "./repositories/project-memory-extraction-cursor.js";
import * as projectMemoryReviewRepository from "./repositories/project-memory-review.js";
import * as projectMemoryWriteLeaseRepository from "./repositories/project-memory-write-lease.js";
import { withMemoryCoordination, assertMemoryFence } from "./memory-coordination.js";
import * as sessionRepository from "./repositories/sessions.js";
import { SqliteSessionStoreTransactions } from "./sqlite-session-transactions.js";

export class SqliteSessionStoreMemory extends SqliteSessionStoreTransactions {
  async readProjectMemoryExtractionCursor(sessionId: SessionId): Promise<MessageId | undefined> {
    return projectMemoryExtractionCursorRepository.readProjectMemoryExtractionCursor(
      this.db,
      sessionId,
    );
  }
  async withProjectMemoryExtractionFence<T>(
    sessionId: SessionId,
    commit: (cursor: ProjectMemoryExtractionCursorPort) => Promise<T>,
  ): Promise<T> {
    this.throwBeforeWrite();
    return withMemoryCoordination(this.dbPath, async () => {
      let active = true;
      const assertActive = () => {
        if (!active) throw new Error("Project memory extraction fence is closed");
      };
      const cursor: ProjectMemoryExtractionCursorPort = {
        read: async () => {
          assertActive();
          return projectMemoryExtractionCursorRepository.readProjectMemoryExtractionCursor(
            this.db,
            sessionId,
          );
        },
        advance: async (input) => {
          assertActive();
          const session = sessionRepository.getSession(this.db, sessionId);
          const messages = await messageRepository.messages(this.db, { sessionID: sessionId });
          assertActive();
          // batch 后的调度器也会 advance；即便游标相同，撤回后的旧边界也不能再被确认为有效。
          const branch = selectActiveConversationBranch(messages, {
            branchCutAfterMessageId: session?.revert?.branchCutAfterMessageID,
            rewindCreatedMessageId: session?.revert?.createdMessageID,
            rewindKeptMessageIds: session?.revert?.keptMessageIDs,
            rewindTargetMessageId: session?.revert?.targetMessageID,
          });
          if (!session || !branch.some((message) => message.info.id === input.nextCursor)) {
            // false 在原 scheduler 表示 CAS 失主并永久停机；单次分支取消必须保留新分支调度资格。
            throw Object.assign(new Error("Memory extraction boundary is no longer current"), {
              code: PROJECT_MEMORY_BATCH_CANCELLED_CODE,
            });
          }
          // 已持有同一协调锁：直接复用 repository，不能嵌套调用公开 advance 再获锁。
          return projectMemoryExtractionCursorRepository.advanceProjectMemoryExtractionCursor(
            this.db,
            { ...input, sessionId },
          );
        },
      };
      try {
        return await commit(cursor);
      } finally {
        active = false;
      }
    });
  }
  async advanceProjectMemoryExtractionCursor(input: {
    sessionId: SessionId;
    expectedCursor?: MessageId;
    nextCursor: MessageId;
    now: number;
  }): Promise<boolean> {
    return this.withProjectMemoryExtractionFence(input.sessionId, (cursor) =>
      cursor.advance(input),
    );
  }
  async claimProjectMemoryWrite(input: {
    workspaceKey: string;
    ownerId: string;
    now: number;
    leaseDurationMs: number;
  }): Promise<{ status: "claimed"; epoch: number } | { status: "leased" }> {
    this.throwBeforeWrite();
    return withMemoryCoordination(this.dbPath, (db) =>
      projectMemoryWriteLeaseRepository.claimProjectMemoryWrite(db, input, true),
    );
  }
  async withProjectMemoryWriteFence<T>(
    input: { workspaceKey: string; ownerId: string; epoch: number },
    commit: () => Promise<T>,
  ): Promise<T> {
    this.throwBeforeWrite();
    return withMemoryCoordination(this.dbPath, async (db) => {
      assertMemoryFence(db, input);
      return commit();
    });
  }
  async renewProjectMemoryWrite(input: {
    workspaceKey: string;
    ownerId: string;
    epoch: number;
    now: number;
    leaseDurationMs: number;
  }): Promise<boolean> {
    this.throwBeforeWrite();
    return withMemoryCoordination(this.dbPath, (db) =>
      projectMemoryWriteLeaseRepository.renewProjectMemoryWrite(db, input),
    );
  }
  async releaseProjectMemoryWrite(input: {
    workspaceKey: string;
    ownerId: string;
    epoch: number;
  }): Promise<boolean> {
    this.throwBeforeWrite();
    return withMemoryCoordination(this.dbPath, (db) =>
      projectMemoryWriteLeaseRepository.releaseProjectMemoryWrite(db, input),
    );
  }
  async claimProjectMemoryReview(
    input: ProjectMemoryReviewClaimInput,
  ): Promise<ProjectMemoryReviewClaim> {
    this.throwBeforeWrite();
    return withMemoryCoordination(this.dbPath, () =>
      projectMemoryReviewRepository.claimProjectMemoryReview(this.db, input),
    );
  }
  async renewProjectMemoryReview(input: {
    workspaceKey: string;
    reviewId: string;
    epoch: number;
    now: number;
    leaseDurationMs: number;
    stage?: ProjectMemoryReviewRecord["stage"];
    totalTokens?: number;
    changedFiles?: string[];
    sessionCount?: number;
    tokenUsageEstimated?: boolean;
  }): Promise<boolean> {
    this.throwBeforeWrite();
    return withMemoryCoordination(this.dbPath, () =>
      projectMemoryReviewRepository.renewProjectMemoryReview(this.db, input),
    );
  }
  async finishProjectMemoryReview(
    input: ProjectMemoryReviewFinishInput,
  ): Promise<"completed" | "failed" | "cancelled" | "stale"> {
    this.throwBeforeWrite();
    return withMemoryCoordination(this.dbPath, () =>
      projectMemoryReviewRepository.finishProjectMemoryReview(this.db, input),
    );
  }
  async requestCancelProjectMemoryReview(input: {
    workspaceKey: string;
    reviewId: string;
  }): Promise<boolean> {
    this.throwBeforeWrite();
    return withMemoryCoordination(this.dbPath, () =>
      projectMemoryReviewRepository.requestCancelProjectMemoryReview(this.db, input),
    );
  }
  async getProjectMemoryReview(workspaceKey: string): Promise<ProjectMemoryReviewRecord | null> {
    const record = projectMemoryReviewRepository.getProjectMemoryReview(this.db, workspaceKey);
    // 常见路径不取协调锁：只有确认 running 的租约已过期，才经与 claim 相同的屏障收口（复审 DEF-17）。
    if (record?.status === "running" && (record.leaseUntil ?? 0) <= Date.now()) {
      this.throwBeforeWrite();
      const reaped = await withMemoryCoordination(this.dbPath, () =>
        projectMemoryReviewRepository.reapExpiredProjectMemoryReview(
          this.db,
          workspaceKey,
          Date.now(),
        ),
      );
      if (reaped)
        return projectMemoryReviewRepository.getProjectMemoryReview(this.db, workspaceKey);
    }
    return record;
  }
  async listProjectMemoryReviews(
    workspaceKey: string,
    before?: { startedAt: number; reviewId: string },
  ) {
    return projectMemoryReviewRepository.listProjectMemoryReviews(this.db, workspaceKey, before);
  }
  // 只读门槛进度：与认领共用候选口径，只统计不写入，因此不需要写前守卫或协调锁（复审 GAP-05）。
  async readProjectMemoryReviewThreshold(input: {
    workspaceKey: string;
    workspacePath: string;
    currentSessionId: SessionId;
    historyScope: "workspace" | "current_session" | "none";
    now: number;
  }) {
    return projectMemoryReviewRepository.readProjectMemoryReviewThreshold(this.db, input);
  }
  // 整理租约的全部写入口也取得同一协调锁；跨库 SELECT 本身不能阻止取消或抢占。

  projectMemoryReviewFence(input: { workspaceKey: string; reviewId: string; epoch: number }) {
    // 统一栅栏形状以复用提交点断言：整理任务的 owner 就是本次 reviewId。
    return {
      workspaceKey: input.workspaceKey,
      ownerId: input.reviewId,
      epoch: input.epoch,
      assertHeld: () =>
        projectMemoryReviewRepository.assertProjectMemoryReviewFence(this.db, {
          ...input,
          now: Date.now(),
        }),
    };
  }
}
