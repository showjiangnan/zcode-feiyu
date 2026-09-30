// Modified by ZCode Feiyu contributors (2026).
import {
  SESSION_ENTRY_TEAM_MESSAGE,
  type SessionEntryInfo,
  type SessionId,
  type SessionStorePort,
  type SubagentSendMessageRequest,
  type SubagentSendMessageResult,
  type TraceContext,
} from "@zcode/contracts";

type DeliveryStatus = "pending" | "promoted" | "failed" | "cancelled";

const MAX_TEAM_MESSAGE_CHARS = 4_000;
const MAX_PENDING_MEMBER_MESSAGES = 32;

interface TeamMessageRecord {
  messageId: string;
  agentId: string;
  childSessionId: SessionId;
  parentToolCallId: string;
  senderAgentId?: string;
  senderName?: string;
  summary: string;
  message: string;
  branchGeneration: number;
  status: DeliveryStatus;
  createdAt: number;
  updatedAt: number;
}

export interface TeamMessageLedger {
  admit(input: {
    messageId: string;
    agentId: string;
    childSessionId: SessionId;
    parentToolCallId: string;
    senderAgentId?: string;
    senderName?: string;
    summary: string;
    message: string;
    branchGeneration: number;
  }): Promise<"new" | "pending" | "promoted">;
  reconcile(messageId: string, childSessionId: SessionId): Promise<boolean>;
  cancelOtherBranches(branchGeneration: number): Promise<void>;
  cancelMember(agentId: string, branchGeneration: number): Promise<void>;
  settle(messageId: string, status: "failed" | "cancelled"): Promise<void>;
  replay(input: {
    branchGeneration: number;
    canDeliver: boolean;
    agentId?: string;
    receivedAfter?: number;
    excludeMessageId?: string;
    resolveMember: (agentId: string) => { childSessionId?: SessionId; status: string } | undefined;
    send: (request: SubagentSendMessageRequest) => Promise<SubagentSendMessageResult>;
    trace: TraceContext;
    workingDirectory: string;
    workspaceRoot: string;
  }): Promise<void>;
}

export function createTeamMessageLedger(
  parentSessionId: SessionId,
  store: SessionStorePort,
): TeamMessageLedger | undefined {
  if (
    !store.sessionEntries ||
    !store.saveSessionEntry ||
    !store.saveSessionInput ||
    !store.promoteSessionInput ||
    !store.getSessionInputById
  ) {
    return undefined;
  }
  let pending: Promise<void> = Promise.resolve();
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const work = pending.then(operation);
    pending = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  };
  const records = async (): Promise<TeamMessageRecord[]> => {
    const entries = await store.sessionEntries!({
      sessionID: parentSessionId,
      type: SESSION_ENTRY_TEAM_MESSAGE,
    });
    return entries.map((entry) => {
      const record = parseRecord(entry.data);
      if (!record) throw new Error(`Invalid team message entry ${entry.id}`);
      return record;
    });
  };
  const save = async (record: TeamMessageRecord): Promise<void> => {
    const entry: SessionEntryInfo = {
      id: `${parentSessionId}:team-message:${record.messageId}`,
      sessionID: parentSessionId,
      type: SESSION_ENTRY_TEAM_MESSAGE,
      touchSession: false,
      time: { created: record.createdAt, updated: record.updatedAt },
      data: record,
    };
    await store.saveSessionEntry!(entry);
  };
  const reconcile = async (record: TeamMessageRecord): Promise<boolean> => {
    const input = await store.getSessionInputById!(record.messageId);
    if (input?.sessionID !== record.childSessionId || input.status !== "promoted") return false;
    if (record.status !== "promoted") {
      await save({ ...record, status: "promoted", updatedAt: Date.now() });
    }
    return true;
  };
  return {
    admit: (input) =>
      serial(async () => {
        if (input.message.length > MAX_TEAM_MESSAGE_CHARS) {
          throw new Error(`Team message exceeds ${MAX_TEAM_MESSAGE_CHARS} characters`);
        }
        const all = await records();
        const existing = all.find((record) => record.messageId === input.messageId);
        if (existing) {
          if (
            existing.agentId !== input.agentId ||
            existing.childSessionId !== input.childSessionId ||
            // 摘要也进入 child 的模型输入，重试不能借同一 ID 偷换投递内容。
            existing.summary !== input.summary ||
            existing.parentToolCallId !== input.parentToolCallId ||
            existing.message !== input.message ||
            existing.senderAgentId !== input.senderAgentId ||
            existing.senderName !== input.senderName ||
            existing.branchGeneration !== input.branchGeneration
          ) {
            throw new Error("Team message identity conflicts with an existing delivery");
          }
          if (await reconcile(existing)) return "promoted";
          if (existing.status !== "pending") throw new Error("Team message is already settled");
          return "pending";
        }
        let pendingCount = 0;
        for (const record of all) {
          if (
            record.agentId === input.agentId &&
            record.status === "pending" &&
            !(await reconcile(record))
          ) {
            pendingCount++;
          }
        }
        if (pendingCount >= MAX_PENDING_MEMBER_MESSAGES) {
          throw new Error(
            `Local agent ${input.agentId} has ${MAX_PENDING_MEMBER_MESSAGES} pending messages`,
          );
        }
        const now = Date.now();
        await save({ ...input, status: "pending", createdAt: now, updatedAt: now });
        return "new";
      }),
    reconcile: (messageId, childSessionId) =>
      serial(async () => {
        const record = (await records()).find((item) => item.messageId === messageId);
        return record?.childSessionId === childSessionId ? reconcile(record) : false;
      }),
    cancelOtherBranches: (branchGeneration) =>
      serial(async () => {
        for (const record of await records()) {
          if (record.status !== "pending" || record.branchGeneration === branchGeneration) continue;
          if (await reconcile(record)) continue;
          await save({ ...record, status: "cancelled", updatedAt: Date.now() });
        }
      }),
    cancelMember: (agentId, branchGeneration) =>
      serial(async () => {
        // 停止在允许下一次显式续跑前收口旧 pending，避免旧消息借新运行复活。
        for (const record of await records()) {
          if (
            record.agentId !== agentId ||
            record.branchGeneration !== branchGeneration ||
            record.status !== "pending"
          )
            continue;
          if (await reconcile(record)) continue;
          await save({ ...record, status: "cancelled", updatedAt: Date.now() });
        }
      }),
    settle: (messageId, status) =>
      serial(async () => {
        const record = (await records()).find((item) => item.messageId === messageId);
        if (!record || record.status !== "pending") return;
        if (await reconcile(record)) return;
        await save({ ...record, status, updatedAt: Date.now() });
      }),
    replay: async (input) => {
      const eligible = (record: TeamMessageRecord): boolean =>
        record.status === "pending" &&
        (input.agentId === undefined || record.agentId === input.agentId) &&
        (input.receivedAfter === undefined || record.createdAt >= input.receivedAfter) &&
        record.messageId !== input.excludeMessageId;
      for (const snapshot of (await records()).filter(eligible)) {
        const record = await serial(async () => {
          const current = (await records()).find((item) => item.messageId === snapshot.messageId);
          if (!current || !eligible(current) || (await reconcile(current))) {
            return undefined;
          }
          const member = input.resolveMember(current.agentId);
          if (
            !input.canDeliver ||
            current.branchGeneration !== input.branchGeneration ||
            !member ||
            member.childSessionId !== current.childSessionId ||
            member.status === "cancelled" ||
            member.status === "killed" ||
            // stop 的内存状态是 killed，持久生命周期事件是 stopped；恢复不能因此复活旧消息。
            member.status === "stopped"
          ) {
            await save({ ...current, status: "cancelled", updatedAt: Date.now() });
            return undefined;
          }
          return current;
        });
        if (!record) continue;
        try {
          await input.send({
            messageId: record.messageId,
            sessionId: parentSessionId,
            parentToolCallId: record.parentToolCallId,
            senderAgentId: record.senderAgentId,
            senderName: record.senderName,
            to: record.agentId,
            summary: record.summary,
            message: record.message,
            workingDirectory: input.workingDirectory,
            workspaceRoot: input.workspaceRoot,
            trace: input.trace,
          });
        } catch {
          // 子进程刚退出等瞬时失败保留待投递记录；下一次恢复继续用同一 ID 对账。
        }
      }
    },
  };
}

function parseRecord(value: unknown): TeamMessageRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.messageId !== "string" ||
    typeof record.agentId !== "string" ||
    typeof record.childSessionId !== "string" ||
    typeof record.parentToolCallId !== "string" ||
    (record.senderAgentId !== undefined && typeof record.senderAgentId !== "string") ||
    (record.senderName !== undefined && typeof record.senderName !== "string") ||
    typeof record.summary !== "string" ||
    typeof record.message !== "string" ||
    record.message.length > MAX_TEAM_MESSAGE_CHARS ||
    typeof record.branchGeneration !== "number" ||
    !Number.isSafeInteger(record.branchGeneration) ||
    !["pending", "promoted", "failed", "cancelled"].includes(String(record.status)) ||
    typeof record.createdAt !== "number" ||
    typeof record.updatedAt !== "number"
  ) {
    return undefined;
  }
  return value as TeamMessageRecord;
}
