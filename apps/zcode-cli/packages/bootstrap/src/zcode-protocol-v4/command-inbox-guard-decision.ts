// Modified by ZCode Feiyu.
import type {
  CommandAck,
  CommandKey,
  CommandEnvelope,
  ConversationInputIntent,
} from "@zcode/shared/zcode-protocol-v4";

/** guard 裁决结果：拒绝（撤 optimistic）或 noop（晚到者静默收口，§6.3）。 */
export type GuardDecision =
  | { verdict: "allow" }
  | { verdict: "stale"; reasonCode: string; message?: string }
  | { verdict: "reject"; reasonCode: string; message?: string }
  | { verdict: "noop"; reasonCode: string; result?: CommandAck["result"] };

export type PersistentLookup = (key: CommandKey) => Promise<CommandAck | null> | CommandAck | null;

export interface CommandInboxHost {
  /** 会话当前 revision；未知会话返回 null（createSession 用 null sessionId）。 */
  getRevision(sessionId: string): number | null;
  /** 会话当前投影代际；CAS 必须先校验 epoch，再校验 revision。 */
  getLogEpoch(sessionId: string): string | null;
  /** row-targeting command 的 entity/action 同源 resolver 裁决。 */
  validateRowTarget?(envelope: CommandEnvelope): GuardDecision;
  /** 业务 guard（product-protocol guard id）。缺省一律放行。 */
  guard?(envelope: CommandEnvelope): GuardDecision;
  /** 以下回调顺序就是持久化事实优先级；实现必须精确匹配 sourceCommandId。 */
  lookupRequestFingerprint?(key: CommandKey): Promise<string | null>;
  lookupTranscriptCommand?: PersistentLookup;
  lookupTimelineCommand?: PersistentLookup;
  lookupChildCommand?: PersistentLookup;
  lookupDiscardedCommand?: PersistentLookup;
  now?(): number;
}

export interface InFlightEntry {
  ack: CommandAck;
  final: Promise<CommandAck>;
  resolveFinal: (ack: CommandAck) => void;
}

export type CommandFinal = Pick<
  CommandAck,
  "status" | "reasonCode" | "message" | "result" | "memoryEnabled"
>;

export interface LiveInputEntry {
  ack: CommandAck;
  intent: ConversationInputIntent;
}

export type CommandInboxOutcome =
  | { kind: "ack"; ack: CommandAck }
  | {
      kind: "execute";
      envelope: CommandEnvelope;
      ack: CommandAck;
      /** CLI 串行 admission 分配的权威顺序；用它构造 ConversationInputIntent。 */
      admissionSeq: number;
      admittedAt: number;
      queueItemId: string;
      /** 执行完成后回填终态。必须调用一次，用于释放 per-session admission gate。 */
      settle: (final: CommandFinal) => void;
    };

// createSession 与 null sessionId query 归全局桶。
export const GLOBAL_BUCKET = "@global";

export function queueItemIdForCommand(commandId: string): string {
  return `queue_${commandId}`;
}

export type GateRelease = () => void;

/**
 * FIFO async gate。返回显式 release 是因为 per-session gate 要跨过 gateway execute，
 * 直到 settle 才释放；普通 with-lock 会在 handle 返回时过早放行下一条 admission。
 */
export class AsyncGateRegistry {
  private readonly tails = new Map<string, Promise<void>>();

  async acquire(key: string): Promise<GateRelease> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const tail = previous.then(() => current);
    this.tails.set(key, tail);
    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseCurrent();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    };
  }
}
