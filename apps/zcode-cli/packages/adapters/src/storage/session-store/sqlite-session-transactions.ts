// Modified by ZCode Feiyu.
import { commitExternalHistory } from "./external-import-commit.js";
import type { ExternalImportCommitBundle } from "@zcode/contracts";
import type {
  CreateSessionInput,
  ForkCommitBundle,
  ForkChildSessionMetadata,
  ListSessionsInput,
  SessionId,
  SessionInfo,
  SessionStorePort,
  SharedContextImportCommitBundle,
  SharedContextImportTransition,
  UpdateSessionInput,
} from "@zcode/contracts";
import { cloneSessionTargetForFork } from "../session-target.js";
import * as messageRepository from "./repositories/messages.js";
import { withMemoryCoordination } from "./memory-coordination.js";
import * as sessionEntryRepository from "./repositories/session-entries.js";
import * as sessionInputRepository from "./repositories/session-inputs.js";
import * as sessionRepository from "./repositories/sessions.js";
import {
  getOrCreateSessionByOrigin,
  readSessionCreateOrigins,
} from "./repositories/session-create-origin.js";
import { SqliteSessionStoreConnection } from "./sqlite-connection.js";
import { forkChildSessionId, assertForkBundleChildLocal } from "./fork-bundle-validation.js";

export class SqliteSessionStoreTransactions extends SqliteSessionStoreConnection {
  async commitExternalImportBundle(bundle: ExternalImportCommitBundle): Promise<SessionInfo> {
    this.throwBeforeWrite();
    return commitExternalHistory(this.db, bundle);
  }
  async readSessionCreateOrigins(commandId: string) {
    return readSessionCreateOrigins(this.db, commandId);
  }
  async createSession(input: CreateSessionInput): Promise<SessionInfo> {
    this.throwBeforeWrite();
    return sessionRepository.createSession(this.db, input);
  }
  async getOrCreateSessionByOrigin(
    input: CreateSessionInput,
    origin: Parameters<NonNullable<SessionStorePort["getOrCreateSessionByOrigin"]>>[1],
  ): Promise<SessionInfo> {
    this.throwBeforeWrite();
    return getOrCreateSessionByOrigin(this.db, input, origin);
  }
  async createForkedSessionWithMetadata(
    input: CreateSessionInput,
    metadata: ForkChildSessionMetadata,
  ): Promise<SessionInfo> {
    this.throwBeforeWrite();
    if (!input.parentID || String(input.parentID) !== metadata.parentSessionId) {
      throw new Error("Fork child metadata parent does not match session parentID");
    }
    const orderedMessageIds = metadata.forkTarget.orderedMessageIds;
    // compact 覆盖首轮 query 时，input 前稳定前缀合法为空；boundaryMessageId 仍记录
    // 被编辑 input，供幂等事实定位，但不会被复制进 child。
    const validBoundary =
      metadata.forkTarget.boundaryMessageId.trim().length > 0 &&
      (orderedMessageIds.length === 0 ||
        orderedMessageIds.at(-1) === metadata.forkTarget.boundaryMessageId);
    if (!metadata.sourceCommandId.trim() || !validBoundary) {
      throw new Error("Fork child metadata is invalid");
    }

    // command key 是 (parentSessionId, sourceCommandId)；session_entry.id 是全库主键，
    // 必须把 parent 纳入 id，避免两个 session 恰好复用 commandId 时互相覆盖事实。
    const entryId = `v4_command_fact:child:${metadata.parentSessionId}:${metadata.sourceCommandId}`;
    this.db.exec("begin immediate");
    try {
      const existing = sessionEntryRepository
        .sessionEntries(this.db, {
          sessionID: input.parentID,
          type: "v4/command_fact",
        })
        .find((entry) => entry.id === entryId);
      if (existing) {
        const childSessionId = forkChildSessionId(existing);
        if (!childSessionId) {
          throw new Error(`Fork child command fact is corrupt: ${entryId}`);
        }
        const child = sessionRepository.getSession(this.db, childSessionId);
        if (!child) {
          throw new Error(`Fork child session is missing: ${childSessionId}`);
        }
        this.db.exec("commit");
        return child;
      }

      const child = sessionRepository.createSession(this.db, input);
      const now = Date.now();
      sessionEntryRepository.saveSessionEntry(this.db, {
        id: entryId,
        sessionID: input.parentID,
        type: "v4/command_fact",
        time: { created: now, updated: now },
        data: {
          source: "child",
          ack: {
            commandId: metadata.sourceCommandId,
            status: "accepted",
            revisionAtDecision: 0,
            result: { type: "forkAssistant", sessionId: String(child.id) },
          },
          metadata,
        },
      });
      this.db.exec("commit");
      return child;
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }
  async commitForkBundle(bundle: ForkCommitBundle): Promise<SessionInfo> {
    this.throwBeforeWrite();
    const { child, commandFact, initialInput } = bundle;
    if (
      !child.parentID ||
      String(child.parentID) !== commandFact.parentSessionId ||
      (initialInput && String(initialInput.sessionID) !== String(child.id)) ||
      commandFact.ack.commandId !== commandFact.sourceCommandId
    ) {
      throw new Error("Fork commit bundle identity is invalid");
    }
    const entryId = `v4_command_fact:child:${commandFact.parentSessionId}:${commandFact.sourceCommandId}`;
    this.db.exec("begin immediate");
    try {
      const existing = sessionEntryRepository
        .sessionEntries(this.db, {
          sessionID: child.parentID,
          type: "v4/command_fact",
        })
        .find((entry) => entry.id === entryId);
      if (existing) {
        const existingChildId = forkChildSessionId(existing);
        const existingChild = existingChildId
          ? sessionRepository.getSession(this.db, existingChildId)
          : null;
        if (!existingChild) throw new Error(`Fork bundle command fact is corrupt: ${entryId}`);
        this.db.exec("commit");
        return existingChild;
      }

      assertForkBundleChildLocal(bundle);
      const persistedChild = sessionRepository.createSession(this.db, child);
      this.maybeThrowForkCommitFault("afterChild");
      for (const message of bundle.messages) {
        const messageSource = bundle.copySources?.messages[message.info.id];
        await messageRepository.saveMessage(
          this.db,
          message.info,
          messageSource ? { sessionID: child.parentID, id: messageSource } : undefined,
        );
        for (const part of message.parts) {
          const partSource = bundle.copySources?.parts[part.id];
          await messageRepository.savePart(
            this.db,
            part,
            partSource ? { sessionID: child.parentID, id: partSource } : undefined,
          );
        }
      }
      this.maybeThrowForkCommitFault("afterMessages");
      if (bundle.goal) {
        cloneSessionTargetForFork(this.db, {
          source: bundle.goal.source,
          sessionID: child.id,
          status: bundle.goal.status,
        });
      }
      this.maybeThrowForkCommitFault("afterGoal");
      for (const entry of bundle.entries) {
        sessionEntryRepository.saveSessionEntry(this.db, entry);
      }
      this.maybeThrowForkCommitFault("afterEntries");
      if (initialInput) {
        await sessionInputRepository.saveSessionInput(this.db, initialInput);
      }
      this.maybeThrowForkCommitFault("afterInput");
      const now = Date.now();
      sessionEntryRepository.saveSessionEntry(this.db, {
        id: entryId,
        sessionID: child.parentID,
        type: "v4/command_fact",
        time: { created: now, updated: now },
        data: {
          source: "child",
          ack: commandFact.ack,
          metadata: commandFact.metadata,
        },
      });
      this.maybeThrowForkCommitFault("afterCommandFact");
      this.maybeThrowForkCommitFault("beforeCommit");
      this.db.exec("commit");
      return persistedChild;
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }
  async commitSharedContextImportBundle(
    bundle: SharedContextImportCommitBundle,
  ): Promise<SessionInfo> {
    this.throwBeforeWrite();
    const { session, contextMessage, provenance } = bundle;
    if (
      String(contextMessage.info.sessionID) !== String(session.id) ||
      String(provenance.sessionID) !== String(session.id) ||
      // session_entry.id 是全库主键，saveSessionEntry 的 on conflict(id)
      // 会把 session_id 改绑到后写入者。provenance id 若不含 session 命名空间，同一个
      // share 导入到第二个会话时会夺走第一个会话的条目（旧会话 transcript 静默丢失）。
      // 这里在唯一写入口做守卫，覆盖所有调用方，而不是只修某一个构造点。
      !provenance.id.includes(String(session.id)) ||
      contextMessage.info.role !== "user" ||
      contextMessage.info.visibility !== "model-only" ||
      contextMessage.info.source !== "shared_context"
    ) {
      throw new Error("Shared context import bundle identity is invalid");
    }
    this.db.exec("begin immediate");
    try {
      const existing = sessionRepository.getSession(this.db, session.id);
      if (existing) {
        const entry = sessionEntryRepository
          .sessionEntries(this.db, { sessionID: session.id, type: provenance.type })
          .find((candidate) => candidate.id === provenance.id);
        if (!entry) throw new Error("Shared context import session is incomplete");
        this.db.exec("commit");
        return existing;
      }
      const persisted = sessionRepository.createSession(this.db, session);
      // 共享连接上的事务窗口内不得 await（复审 DEF-03），一律使用同步核心。
      messageRepository.saveMessageSync(this.db, contextMessage.info);
      for (const part of contextMessage.parts) {
        messageRepository.savePartSync(this.db, part);
      }
      sessionEntryRepository.saveSessionEntry(this.db, provenance);
      this.db.exec("commit");
      return persisted;
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }
  async transitionSharedContextImport(input: SharedContextImportTransition): Promise<boolean> {
    this.throwBeforeWrite();
    this.db.exec("begin immediate");
    try {
      const entry = sessionEntryRepository
        .sessionEntries(this.db, { sessionID: input.sessionID, type: "v4/shared_context_import" })
        .find((candidate) => {
          const data = candidate.data;
          return Boolean(
            data &&
            typeof data === "object" &&
            !Array.isArray(data) &&
            (data as Record<string, unknown>).contextId === input.contextId,
          );
        });
      if (!entry) {
        this.db.exec("rollback");
        return false;
      }
      const data = entry.data as Record<string, unknown>;
      const expected = Array.isArray(input.expectedStatus)
        ? input.expectedStatus
        : [input.expectedStatus];
      if (!expected.includes(data.status as SharedContextImportTransition["status"])) {
        this.db.exec("rollback");
        return false;
      }
      sessionEntryRepository.saveSessionEntry(this.db, {
        ...entry,
        time: { ...entry.time, updated: Date.now() },
        data: {
          ...data,
          status: input.status,
          ...(input.sourceId ? { sourceId: input.sourceId } : {}),
        },
      });
      const contextMessage = messageRepository
        .messagesSync(this.db, { sessionID: input.sessionID })
        .find((message) => {
          const metadata = message.info.metadata;
          return Boolean(
            metadata &&
            typeof metadata === "object" &&
            (metadata as Record<string, unknown>).contextId === input.contextId,
          );
        });
      if (contextMessage) {
        messageRepository.saveMessageSync(this.db, {
          ...contextMessage.info,
          metadata: {
            ...contextMessage.info.metadata,
            sharedContextStatus: input.status,
          },
        });
      }
      this.db.exec("commit");
      return true;
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }
  async updateSession(input: UpdateSessionInput): Promise<SessionInfo> {
    this.throwBeforeWrite();
    // repository 即使只改标题也会读后整行写回 revert；同屏障防止旧快照复活已撤回分支。
    return withMemoryCoordination(this.dbPath, () =>
      sessionRepository.updateSession(this.db, input),
    );
  }
  async getSession(sessionID: SessionId): Promise<SessionInfo | null> {
    return sessionRepository.getSession(this.db, sessionID);
  }
  async listSessions(input: ListSessionsInput = {}): Promise<SessionInfo[]> {
    return sessionRepository.listSessions(this.db, input);
  }
}
