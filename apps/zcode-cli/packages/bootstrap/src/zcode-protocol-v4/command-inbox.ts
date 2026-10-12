// Modified by ZCode Feiyu.
// 状态仍由原 owner 独占；按事件职责装配 prototype 方法，确保原子 clone 继承同一实现。
import type {
  InFlightEntry,
  LiveInputEntry,
  CommandInboxHost,
} from "./command-inbox-guard-decision.js";
import type { CommandAck } from "@zcode/shared/zcode-protocol-v4";
import { AsyncGateRegistry } from "./command-inbox-guard-decision.js";
import { installV4OwnerMethods } from "./owner-methods.js";
import * as part1 from "./command-inbox-handle.js";
import * as part2 from "./command-inbox-lookup-exact.js";
import * as part3 from "./command-inbox-map-for.js";

export class CommandInbox {
  private readonly inFlight = new Map<string, Map<string, InFlightEntry>>();

  private readonly liveInputs = new Map<string, Map<string, LiveInputEntry>>();

  private readonly settled = new Map<string, Map<string, CommandAck>>();

  private readonly admissionSeq = new Map<string, number>();

  private readonly keyGates = new AsyncGateRegistry();

  private readonly sessionGates = new AsyncGateRegistry();

  constructor(private readonly host: CommandInboxHost) {}

  declare handle: typeof part1.handle;

  declare private checkedRetry: typeof part1.checkedRetry;

  /** 1..64 的上层 schema 由 gateway 校验；这里并行查询并保持 Promise.all 输入顺序。 */
  declare query: typeof part1.query;

  /** queue/guide admission 后 pin 同一个完整 intent；settled churn 不得触及它。 */
  declare pinLiveInput: typeof part1.pinLiveInput;

  /** queue/guide 进入 transcript、取消或失败时解除 pin，并可把终态转入 settled LRU。 */
  declare releaseLiveInput: typeof part1.releaseLiveInput;

  declare hasPinnedSessionState: typeof part1.hasPinnedSessionState;

  /**
   * Resident 去激活后，inbox 也必须回到 CLI 冷启动状态。in-flight/live facts 不能清，
   * 调用方必须把它们作为回收保护条件；settled 仍可从 durable transcript/timeline 回源。
   */
  declare clearSession: typeof part1.clearSession;

  declare private queryOne: typeof part1.queryOne;

  declare private lookupExact: typeof part2.lookupExact;

  declare private decide: typeof part2.decide;

  declare private retryAck: typeof part2.retryAck;

  declare private queryUnavailableAck: typeof part2.queryUnavailableAck;

  declare private ackOnly: typeof part2.ackOnly;

  declare private bucketKey: typeof part2.bucketKey;

  declare private keyGateKey: typeof part2.keyGateKey;

  declare private mapFor: typeof part3.mapFor;

  declare private touchSettled: typeof part3.touchSettled;

  declare private rememberSettled: typeof part3.rememberSettled;

  declare private extractCommandId: typeof part3.extractCommandId;
}

installV4OwnerMethods(CommandInbox.prototype, part1);
installV4OwnerMethods(CommandInbox.prototype, part2);
installV4OwnerMethods(CommandInbox.prototype, part3);

export type { GuardDecision } from "./command-inbox-guard-decision.js";
export type { CommandInboxHost } from "./command-inbox-guard-decision.js";
export type { CommandInboxOutcome } from "./command-inbox-guard-decision.js";
export { queueItemIdForCommand } from "./command-inbox-guard-decision.js";
