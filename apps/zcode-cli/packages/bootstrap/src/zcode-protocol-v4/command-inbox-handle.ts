// Modified by ZCode Feiyu.
import type { CommandInboxOutcome, InFlightEntry } from "./command-inbox-guard-decision.js";
import { parseCommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import { commandRequestFingerprint } from "./command-fingerprint.js";
import type {
  CommandAck,
  CommandEnvelope,
  CommandKey,
  ConversationInputIntent,
} from "@zcode/shared/zcode-protocol-v4";
import { queueItemIdForCommand } from "./command-inbox-guard-decision.js";
import type { CommandInbox } from "./command-inbox.js";

export async function handle(this: CommandInbox, raw: unknown): Promise<CommandInboxOutcome> {
  const parsed = parseCommandEnvelope(raw);
  if (!parsed.ok) {
    return this["ackOnly"]({
      commandId: this["extractCommandId"](raw),
      status: "rejected",
      reasonCode: "proto.invalidPayload",
      message: parsed.error.message,
      revisionAtDecision: 0,
    });
  }
  const envelope = parsed.envelope;
  const key = { sessionId: envelope.sessionId, commandId: envelope.commandId };
  const bucketKey = this["bucketKey"](envelope.sessionId);
  const releaseKey = await this["keyGates"].acquire(this["keyGateKey"](key));
  try {
    const pinned = this["inFlight"].get(bucketKey)?.get(envelope.commandId);
    if (pinned) return this["ackOnly"](await this["checkedRetry"](envelope, await pinned.final));
    const existing = await this["lookupExact"](key);
    if (existing) return this["ackOnly"](await this["checkedRetry"](envelope, existing));
    // 固定锁序：key gate → per-session admission gate。session gate 持有到 settle，
    // 因而同 session 不同 commandId 以 CLI 实际执行 admission 的顺序串行。
    const releaseSession = await this["sessionGates"].acquire(bucketKey);
    try {
      // 等待 session gate 期间，上一条命令可能增量写入了本 key 的持久化事实。
      const afterWaitPinned = this["inFlight"].get(bucketKey)?.get(envelope.commandId);
      if (afterWaitPinned) {
        releaseSession();
        return this["ackOnly"](await this["checkedRetry"](envelope, await afterWaitPinned.final));
      }
      const afterWait = await this["lookupExact"](key);
      if (afterWait) {
        releaseSession();
        return this["ackOnly"](await this["checkedRetry"](envelope, afterWait));
      }
      const decision = this["decide"](envelope);
      if (decision.kind === "ack") {
        if (decision.remember) this["rememberSettled"](bucketKey, envelope.commandId, decision.ack);
        releaseSession();
        return this["ackOnly"](decision.ack);
      }
      decision.ack.requestFingerprint = commandRequestFingerprint(envelope);
      const nextAdmissionSeq = (this["admissionSeq"].get(bucketKey) ?? 0) + 1;
      const admittedAt = this["host"].now?.() ?? Date.now();
      this["admissionSeq"].set(bucketKey, nextAdmissionSeq);
      let resolveFinal!: (ack: CommandAck) => void;
      const final = new Promise<CommandAck>((resolve) => {
        resolveFinal = resolve;
      });
      const entry: InFlightEntry = { ack: decision.ack, final, resolveFinal };
      this["mapFor"](this["inFlight"], bucketKey).set(envelope.commandId, entry);
      // 旧单表 LRU 会在 >512 条 churn 时淘汰仍在执行/队列里的命令，随后
      // query 返回 unknown、重试再次执行。新命令先 pin，再释放 key gate。
      releaseKey();
      let settled = false;
      return {
        kind: "execute",
        envelope,
        ack: decision.ack,
        admissionSeq: nextAdmissionSeq,
        admittedAt,
        queueItemId: queueItemIdForCommand(envelope.commandId),
        settle: (final) => {
          if (settled) return;
          settled = true;
          const live = this["liveInputs"].get(bucketKey)?.get(envelope.commandId);
          const ack = {
            ...decision.ack,
            ...final,
          };
          this["inFlight"].get(bucketKey)?.delete(envelope.commandId);
          if (live) {
            live.ack = ack;
          } else {
            this["rememberSettled"](bucketKey, envelope.commandId, ack);
          }
          // 在途 duplicate 过去直接拿 admission ACK，fork/create 尚无 child
          // result 时就返回，ACK 丢失重试会导航失败。所有同 key 请求必须共享这一个
          // final promise，并在释放 session FIFO 前看到同一终态。
          entry.resolveFinal(ack);
          releaseSession();
        },
      };
    } catch (error) {
      releaseSession();
      throw error;
    }
  } catch (error) {
    return this["ackOnly"](this["queryUnavailableAck"](key, error));
  } finally {
    // execute 路径已在 pin 后提前 release；release 幂等，其他路径在这里释放。
    releaseKey();
  }
}

export async function checkedRetry(
  this: CommandInbox,
  envelope: CommandEnvelope,
  ack: CommandAck,
): Promise<CommandAck> {
  const prior =
    ack.requestFingerprint ??
    (await this["host"].lookupRequestFingerprint?.({
      sessionId: envelope.sessionId,
      commandId: envelope.commandId,
    }));
  if (prior && prior !== commandRequestFingerprint(envelope))
    return {
      commandId: envelope.commandId,
      status: "rejected",
      reasonCode: "proto.invalidPayload",
      message: "The command ID was already used with a different payload.",
      revisionAtDecision: ack.revisionAtDecision,
    };
  if (
    !prior &&
    envelope.type === "sendText" &&
    Boolean((envelope.payload as Record<string, unknown>).interTaskSourceTaskId)
  )
    return {
      commandId: envelope.commandId,
      status: "rejected",
      reasonCode: "proto.payloadFingerprintUnavailable",
      message:
        "The original payload cannot be verified; inspect the original command before submitting a new ID.",
      revisionAtDecision: ack.revisionAtDecision,
    };
  return this["retryAck"](ack);
}

export async function query(
  this: CommandInbox,
  keys: readonly CommandKey[],
): Promise<Array<{ key: CommandKey; result: CommandAck | "unknown" }>> {
  return Promise.all(keys.map((key) => this["queryOne"](key)));
}

export function pinLiveInput(
  this: CommandInbox,
  sessionId: string,
  intent: ConversationInputIntent,
  ack?: CommandAck,
): void {
  const bucketKey = this["bucketKey"](sessionId);
  const inFlightAck = this["inFlight"].get(bucketKey)?.get(intent.sourceCommandId)?.ack;
  this["mapFor"](this["liveInputs"], bucketKey).set(intent.sourceCommandId, {
    intent,
    ack: ack ??
      inFlightAck ?? {
        commandId: intent.sourceCommandId,
        status: "accepted",
        revisionAtDecision: 0,
      },
  });
  this["settled"].get(bucketKey)?.delete(intent.sourceCommandId);
}

export function releaseLiveInput(this: CommandInbox, key: CommandKey, finalAck?: CommandAck): void {
  const bucketKey = this["bucketKey"](key.sessionId);
  const live = this["liveInputs"].get(bucketKey)?.get(key.commandId);
  this["liveInputs"].get(bucketKey)?.delete(key.commandId);
  if (finalAck ?? live?.ack) {
    this["rememberSettled"](bucketKey, key.commandId, finalAck ?? live!.ack);
  }
}

export function hasPinnedSessionState(this: CommandInbox, sessionId: string): boolean {
  const bucketKey = this["bucketKey"](sessionId);
  return (
    (this["inFlight"].get(bucketKey)?.size ?? 0) > 0 ||
    (this["liveInputs"].get(bucketKey)?.size ?? 0) > 0
  );
}

export function clearSession(this: CommandInbox, sessionId: string): boolean {
  const bucketKey = this["bucketKey"](sessionId);
  if (this.hasPinnedSessionState(sessionId)) return false;
  this["inFlight"].delete(bucketKey);
  this["liveInputs"].delete(bucketKey);
  this["settled"].delete(bucketKey);
  this["admissionSeq"].delete(bucketKey);
  return true;
}

export async function queryOne(
  this: CommandInbox,
  key: CommandKey,
): Promise<{ key: CommandKey; result: CommandAck | "unknown" }> {
  const releaseKey = await this["keyGates"].acquire(this["keyGateKey"](key));
  try {
    return { key, result: (await this["lookupExact"](key)) ?? "unknown" };
  } catch (error) {
    return { key, result: this["queryUnavailableAck"](key, error) };
  } finally {
    releaseKey();
  }
}
