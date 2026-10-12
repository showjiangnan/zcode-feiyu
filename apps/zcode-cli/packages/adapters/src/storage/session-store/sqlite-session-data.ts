// Modified by ZCode Feiyu.
import { claimImageGenerationSubmission } from "./repositories/image-generation-admission.js";
import * as permissionFullAccessRepository from "./repositories/permission-full-access.js";
import type {
  CollaborationMode,
  ClaimLegacySessionWorkspaceInput,
  RepairLegacyRemoteSessionWorkspaceInput,
  RepairRemoteSessionPathsInput,
  FileDiff,
  InputHistoryAttachment,
  InputHistoryEntry,
  InputHistoryKind,
  MessageId,
  MessageInfo,
  MessagePart,
  MessageWithParts,
  PartId,
  PermissionRuleset,
  ProjectId,
  SessionEntryInfo,
  SessionEntryType,
  SessionId,
  SessionInputDelivery,
  SessionInputRecord,
  SessionInputStatus,
  SessionRevert,
  SessionStorePort,
  TodoItem,
} from "@zcode/contracts";
import * as inputHistoryRepository from "./repositories/input-history.js";
import * as localSettingsRepository from "./repositories/local-settings.js";
import * as messageRepository from "./repositories/messages.js";
import { withMemoryCoordination } from "./memory-coordination.js";
import * as proactiveRepository from "./repositories/proactive-events.js";
import { resumeRetiredProactiveWorkspace } from "./repositories/proactive-upgrade.js";
import * as sessionEntryRepository from "./repositories/session-entries.js";
import * as sessionInputRepository from "./repositories/session-inputs.js";
import * as sessionRepository from "./repositories/sessions.js";
import * as todoRepository from "./repositories/todos.js";
import { SqliteSessionStoreMemory } from "./sqlite-memory-coordination.js";

export class SqliteSessionStoreData extends SqliteSessionStoreMemory {
  async claimImageGenerationSubmission(
    input: Parameters<NonNullable<SessionStorePort["claimImageGenerationSubmission"]>>[0],
  ) {
    this.throwBeforeWrite();
    return claimImageGenerationSubmission(this.db, input);
  }
  async publishProactiveEvent(
    input: Parameters<NonNullable<SessionStorePort["publishProactiveEvent"]>>[0],
  ) {
    this.throwBeforeWrite();
    proactiveRepository.publishProactiveEvent(this.db, input);
  }
  async resumeRetiredProactiveWorkspace(
    workspaceKey: string,
    now: number,
    activeSessionIds?: readonly string[],
  ) {
    this.throwBeforeWrite();
    resumeRetiredProactiveWorkspace(this.db, workspaceKey, now, activeSessionIds);
  }
  async claimProactiveTriggers(workspaceKey: string, ownerId: string, now: number) {
    this.throwBeforeWrite();
    return proactiveRepository.claimProactiveTriggers(this.db, workspaceKey, ownerId, now);
  }
  async settleProactiveTrigger(
    input: Parameters<NonNullable<SessionStorePort["settleProactiveTrigger"]>>[0],
  ) {
    this.throwBeforeWrite();
    proactiveRepository.settleProactiveTrigger(this.db, input);
  }
  async readProactiveTrigger(commandId: string) {
    return proactiveRepository.readProactiveTrigger(this.db, commandId);
  }
  async listProactiveMailboxTargets(workspaceKey: string) {
    return proactiveRepository.listProactiveMailboxTargets(this.db, workspaceKey);
  }
  async pauseProactiveWorkspace(
    workspaceKey: string,
    reason: string,
    activeSessionIds?: readonly string[],
  ) {
    this.throwBeforeWrite();
    proactiveRepository.pauseProactiveWorkspace(this.db, workspaceKey, reason, activeSessionIds);
  }
  async proactiveDepthForSource(sourceSessionId: string, commandId: string) {
    return proactiveRepository.proactiveDepthForSource(this.db, sourceSessionId, commandId);
  }
  async mergeProactiveInputCause(
    sessionId: SessionId,
    cause: Parameters<NonNullable<SessionStorePort["mergeProactiveInputCause"]>>[1],
  ) {
    this.throwBeforeWrite();
    proactiveRepository.mergeProactiveInputCause(this.db, sessionId, cause);
  }
  async rejectSupersededProactiveTriggers(
    targetSessionId: string,
    generation: number,
    reason: string,
    now: number,
  ) {
    this.throwBeforeWrite();
    return proactiveRepository.rejectSupersededProactiveTriggers(
      this.db,
      targetSessionId,
      generation,
      reason,
      now,
    );
  }
  async claimLegacySessionWorkspace(input: ClaimLegacySessionWorkspaceInput): Promise<number> {
    this.throwBeforeWrite();
    return sessionRepository.claimLegacySessionWorkspace(this.db, input);
  }
  async repairLegacyRemoteSessionWorkspace(
    input: RepairLegacyRemoteSessionWorkspaceInput,
  ): Promise<boolean> {
    this.throwBeforeWrite();
    return sessionRepository.repairLegacyRemoteSessionWorkspace(this.db, input);
  }
  async repairRemoteSessionPaths(input: RepairRemoteSessionPathsInput): Promise<boolean> {
    this.throwBeforeWrite();
    return sessionRepository.repairRemoteSessionPaths(this.db, input);
  }
  async saveMessage(
    input: MessageInfo,
    copyFrom?: Parameters<SessionStorePort["saveMessage"]>[1],
  ): Promise<void> {
    this.throwBeforeWrite();
    return messageRepository.saveMessage(this.db, input, copyFrom);
  }
  async removeMessage(input: { sessionID: SessionId; messageID: MessageId }): Promise<void> {
    this.throwBeforeWrite();
    return messageRepository.removeMessage(this.db, input);
  }
  async savePart(
    input: MessagePart,
    copyFrom?: Parameters<SessionStorePort["savePart"]>[1],
  ): Promise<void> {
    this.throwBeforeWrite();
    return messageRepository.savePart(this.db, input, copyFrom);
  }
  async removePart(input: {
    sessionID: SessionId;
    messageID: MessageId;
    partID: PartId;
  }): Promise<void> {
    this.throwBeforeWrite();
    return messageRepository.removePart(this.db, input);
  }
  async messageWithParts(input: {
    sessionID: SessionId;
    messageID: MessageId;
  }): Promise<MessageWithParts | null> {
    return messageRepository.messageWithParts(this.db, input);
  }
  async messages(input: { sessionID: SessionId }): Promise<MessageWithParts[]> {
    return messageRepository.messages(this.db, input);
  }
  async saveSessionEntry(input: SessionEntryInfo): Promise<void> {
    this.throwBeforeWrite();
    return sessionEntryRepository.saveSessionEntry(this.db, input);
  }
  async sessionEntries(input: {
    sessionID: SessionId;
    type?: SessionEntryType | string;
  }): Promise<SessionEntryInfo[]> {
    return sessionEntryRepository.sessionEntries(this.db, input);
  }
  // ── session_input 账本──

  async saveSessionInput(input: {
    id: string;
    sessionID: SessionId;
    kind: string;
    delivery: SessionInputDelivery;
    payload: { text: string; [key: string]: unknown };
  }): Promise<void> {
    this.throwBeforeWrite();
    return sessionInputRepository.saveSessionInput(this.db, input);
  }
  async commitPermissionFullAccess(
    input: Parameters<NonNullable<SessionStorePort["commitPermissionFullAccess"]>>[0],
  ): Promise<void> {
    this.throwBeforeWrite();
    return permissionFullAccessRepository.commitPermissionFullAccess(this.db, input);
  }
  async updateSessionInputs(
    input: Parameters<NonNullable<SessionStorePort["updateSessionInputs"]>>[0],
  ): Promise<void> {
    this.throwBeforeWrite();
    return sessionInputRepository.updateSessionInputs(this.db, input);
  }
  async promoteSessionInput(input: {
    id: string;
    sessionID: SessionId;
    message: MessageInfo;
    parts: MessagePart[];
  }): Promise<void> {
    this.throwBeforeWrite();
    return sessionInputRepository.promoteSessionInput(this.db, input);
  }
  async markSessionInputPromoted(input: {
    id: string;
    sessionID: SessionId;
    promotedMessageID: MessageId;
  }): Promise<void> {
    this.throwBeforeWrite();
    return sessionInputRepository.markSessionInputPromoted(this.db, input);
  }
  async settleSessionInput(input: {
    id: string;
    sessionID: SessionId;
    status: "cancelled" | "discarded" | "failed";
    reason?: string;
  }): Promise<void> {
    this.throwBeforeWrite();
    return sessionInputRepository.settleSessionInput(this.db, input);
  }
  async listSessionInputs(input: {
    sessionID: SessionId;
    status?: SessionInputStatus;
  }): Promise<SessionInputRecord[]> {
    return sessionInputRepository.listSessionInputs(this.db, input);
  }
  async getSessionInputById(id: string): Promise<SessionInputRecord | null> {
    return sessionInputRepository.getSessionInputById(this.db, id);
  }
  async readTodos(input: { sessionID: SessionId }): Promise<TodoItem[]> {
    return todoRepository.readTodos(this.db, input);
  }
  async updateTodos(input: { sessionID: SessionId; todos: TodoItem[] }): Promise<void> {
    this.throwBeforeWrite();
    return todoRepository.updateTodos(this.db, input);
  }
  async recordInputHistory(input: {
    projectID: ProjectId;
    sessionID?: SessionId;
    text: string;
    attachments?: InputHistoryAttachment[];
    kind: InputHistoryKind;
    time?: { created?: number };
  }): Promise<InputHistoryEntry | null> {
    return inputHistoryRepository.recordInputHistory(this.db, input);
  }
  async recallPreviousInputHistory(input: {
    projectID: ProjectId;
    skip?: number;
  }): Promise<InputHistoryEntry | null> {
    return inputHistoryRepository.recallPreviousInputHistory(this.db, input);
  }
  async getProjectPermission(projectID: ProjectId): Promise<PermissionRuleset | null> {
    return localSettingsRepository.getProjectPermission(this.db, projectID);
  }
  async saveProjectPermission(input: {
    projectID: ProjectId;
    permission: PermissionRuleset;
  }): Promise<PermissionRuleset> {
    return localSettingsRepository.saveProjectPermission(this.db, input);
  }
  getProjectPermissionMode(projectID: ProjectId): CollaborationMode | null {
    return localSettingsRepository.getProjectPermissionMode(this.db, projectID);
  }
  saveProjectPermissionMode(input: {
    mode: CollaborationMode;
    projectID: ProjectId;
  }): CollaborationMode {
    return localSettingsRepository.saveProjectPermissionMode(this.db, input);
  }
  async setRevert(input: {
    sessionID: SessionId;
    revert: SessionRevert;
    summary?: { additions: number; deletions: number; files: number; diffs?: FileDiff[] };
  }): Promise<void> {
    this.throwBeforeWrite();
    // 跨 Host 恢复也读取来源分支；撤回与最终文件/游标提交必须在线性化的同一屏障内。
    return withMemoryCoordination(this.dbPath, () => sessionRepository.setRevert(this.db, input));
  }
  async clearRevert(sessionID: SessionId): Promise<void> {
    this.throwBeforeWrite();
    return withMemoryCoordination(this.dbPath, () =>
      sessionRepository.clearRevert(this.db, sessionID),
    );
  }
}
