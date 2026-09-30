// Modified by ZCode Feiyu contributors (2026).
import type { SessionId } from "./shared.js";

export interface SessionMailboxEnvelope {
  version: 1;
  messageId: string;
  fromSessionId: SessionId;
  /** 发送者的已提升输入；缺失时只保留既有读取语义，不触发主动唤醒。 */
  sourceCommandId?: string;
  toSessionId: SessionId;
  content: string;
  createdAt: string;
}

export interface SessionMailboxPort {
  drainUnread(
    input: { sessionId: SessionId; limit?: number },
    options?: { signal?: AbortSignal },
  ): Promise<SessionMailboxEnvelope[]>;
}
