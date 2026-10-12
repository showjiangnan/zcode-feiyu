// Modified by ZCode Feiyu.
import type { TurnId, SessionEvent } from "@zcode/contracts";
import type { CommandEnvelope, ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import type {
  ConversationRowTargetAction,
  SessionSubagentsSeed,
  SessionUsageSeed,
} from "./product-projection.js";

export function toRuntimeTurnId(turnId: string | null): TurnId | null {
  // conversation projection 为了 row 索引用 string 保存 product turnId；
  // 离开 gateway 调 runtime 文件摘要/回退能力时，需要恢复 contracts 的品牌类型。
  return turnId as TurnId | null;
}

export function rowTargetActionForCommand(
  type: CommandEnvelope["type"],
): ConversationRowTargetAction | null {
  switch (type) {
    case "forkAssistant":
    case "editUserQuery":
    case "retryTurn":
    case "applyFileRewind":
    case "setAssistantFeedback":
    case "setHighspeedMetrics":
      return type;
    default:
      return null;
  }
}

export interface PersistedEventsLoadResult {
  events: SessionEvent[];
  synthesized: boolean;
  /** durable transcript 重放后、live buffer 补回前注入的 store-verified child manifest。 */
  subagentsSeed?: SessionSubagentsSeed;
  /** shared_context 不生成可见 row；只把脱敏 handover metadata 下发。 */
  sharedContextImport?: ConversationSnapshot["sharedContextImport"];
  /** memory eventStore 取快照时已包含的 raw sequence 水位。 */
  sourceEventSeq?: number;
  /** 与本次历史事件使用同一容量的种子；null 表示已查询但没有历史水位。 */
  usageSeed?: SessionUsageSeed | null;
}

export type V4GatewayErrorContext = Record<string, unknown>;

/**
 * 一条已读回的**整份字节**，供分块读取复用。
 *
 * 两个家族共用这张表：已发送附件的预览（`attachmentRead`）与 dwf 用户面产物的字节
 * （`workflowRunArtifactRead`）。共用是有意的——两者的失效规则逐字相同（TTL、字节预算、
 * 最旧先逐、会话销毁时按 `sessionId` 清），而分成两张表会得到两份**各自**的字节预算，
 * 于是"最多缓存多少字节"这条约束就再也说不清了。
 *
 * 键空间靠**首段标签**区分（`att` / `dwfart`），不靠字段个数或内容——两个家族的键都是
 * NUL 分隔的四五段，段数相同、内容也可能撞（一个叫 "1" 的产物 id 与一个 attachmentIndex
 * 1 会长得一样），只有一个不可能相等的首段才是可证明的隔离。
 *
 * `bytes` 为 null 表示读还在飞：此时它不计入预算，也不会被按预算逐出（逐出一个正在被
 * await 的条目只会让下一块重新读一遍整份文件，正是这张表要消灭的事）。
 */
export interface BinaryReadCacheEntry {
  sessionId: string;
  accessedAt: number;
  bytes: number | null;
  payload: Promise<{ bytes: Uint8Array; mediaType: string }>;
}
