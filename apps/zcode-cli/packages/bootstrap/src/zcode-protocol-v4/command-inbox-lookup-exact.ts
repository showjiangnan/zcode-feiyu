// Modified by ZCode Feiyu.
import type { CommandKey, CommandAck, CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import {
  COMMANDS_REQUIRING_BASE_REVISION,
  ROW_TARGETING_COMMANDS,
} from "@zcode/shared/zcode-protocol-v4";
import type { CommandInboxOutcome } from "./command-inbox-guard-decision.js";
import { GLOBAL_BUCKET } from "./command-inbox-guard-decision.js";
import type { CommandInbox } from "./command-inbox.js";

export async function lookupExact(this: CommandInbox, key: CommandKey): Promise<CommandAck | null> {
  const bucketKey = this["bucketKey"](key.sessionId);
  const inflight = this["inFlight"].get(bucketKey)?.get(key.commandId);
  if (inflight) return await inflight.final;
  const live = this["liveInputs"].get(bucketKey)?.get(key.commandId);
  if (live) return live.ack;
  const settled = this["settled"].get(bucketKey)?.get(key.commandId);
  if (settled) {
    this["touchSettled"](bucketKey, key.commandId, settled);
    return settled;
  }
  for (const lookup of [
    this["host"].lookupTranscriptCommand,
    this["host"].lookupTimelineCommand,
    this["host"].lookupChildCommand,
    this["host"].lookupDiscardedCommand,
  ]) {
    const found = await lookup?.(key);
    if (found) return found;
  }
  return null;
}

export function decide(
  this: CommandInbox,
  envelope: CommandEnvelope,
): { kind: "execute"; ack: CommandAck } | { kind: "ack"; ack: CommandAck; remember: boolean } {
  const revision = envelope.sessionId === null ? 0 : this["host"].getRevision(envelope.sessionId);
  if (revision === null || (envelope.type !== "createSession" && envelope.sessionId === null)) {
    return {
      kind: "ack",
      remember: false,
      ack: {
        commandId: envelope.commandId,
        status: "rejected",
        reasonCode: "proto.sessionNotFound",
        revisionAtDecision: 0,
      },
    };
  }
  if (COMMANDS_REQUIRING_BASE_REVISION.has(envelope.type)) {
    if (envelope.baseRevision === undefined) {
      return {
        kind: "ack",
        remember: false,
        ack: {
          commandId: envelope.commandId,
          status: "rejected",
          reasonCode: "proto.missingBaseRevision",
          revisionAtDecision: revision,
        },
      };
    }
    const logEpoch =
      envelope.sessionId === null ? null : this["host"].getLogEpoch(envelope.sessionId);
    if (ROW_TARGETING_COMMANDS.has(envelope.type) && envelope.baseLogEpoch !== logEpoch) {
      return {
        kind: "ack",
        remember: false,
        ack: {
          commandId: envelope.commandId,
          status: "stale",
          reasonCode: "proto.staleLogEpoch",
          revisionAtDecision: revision,
        },
      };
    }
    if (envelope.baseRevision !== revision) {
      return {
        kind: "ack",
        remember: false,
        ack: {
          commandId: envelope.commandId,
          status: "stale",
          reasonCode: "proto.staleRevision",
          revisionAtDecision: revision,
        },
      };
    }
  }
  const targetDecision = this["host"].validateRowTarget?.(envelope);
  if (targetDecision?.verdict === "stale") {
    return {
      kind: "ack",
      remember: false,
      ack: {
        commandId: envelope.commandId,
        status: "stale",
        reasonCode: targetDecision.reasonCode,
        message: targetDecision.message,
        revisionAtDecision: revision,
      },
    };
  }
  if (targetDecision?.verdict === "reject") {
    return {
      kind: "ack",
      remember: false,
      ack: {
        commandId: envelope.commandId,
        status: "rejected",
        reasonCode: targetDecision.reasonCode,
        message: targetDecision.message,
        revisionAtDecision: revision,
      },
    };
  }
  const decision = this["host"].guard?.(envelope) ?? {
    verdict: "allow" as const,
  };
  if (decision.verdict === "stale") {
    return {
      kind: "ack",
      remember: false,
      ack: {
        commandId: envelope.commandId,
        status: "stale",
        reasonCode: decision.reasonCode,
        message: decision.message,
        revisionAtDecision: revision,
      },
    };
  }
  if (decision.verdict === "reject") {
    return {
      kind: "ack",
      remember: false,
      ack: {
        commandId: envelope.commandId,
        status: "rejected",
        reasonCode: decision.reasonCode,
        message: decision.message,
        revisionAtDecision: revision,
      },
    };
  }
  if (decision.verdict === "noop") {
    return {
      kind: "ack",
      remember: true,
      ack: {
        commandId: envelope.commandId,
        status: "noop",
        reasonCode: decision.reasonCode,
        revisionAtDecision: revision,
        result: decision.result,
      },
    };
  }
  return {
    kind: "execute",
    ack: {
      commandId: envelope.commandId,
      status: "accepted",
      revisionAtDecision: revision,
    },
  };
}

export function retryAck(this: CommandInbox, ack: CommandAck): CommandAck {
  // failed 是终态事实，不得被 duplicate 状态覆盖后让 UI/服务误判为可接受。
  return ack.status === "failed" ? ack : { ...ack, status: "duplicate" };
}

export function queryUnavailableAck(
  this: CommandInbox,
  key: CommandKey,
  _error: unknown,
): CommandAck {
  return {
    commandId: key.commandId,
    status: "failed",
    reasonCode: "fault.command.queryUnavailable",
    revisionAtDecision: key.sessionId === null ? 0 : (this["host"].getRevision(key.sessionId) ?? 0),
  };
}

export function ackOnly(this: CommandInbox, ack: CommandAck): CommandInboxOutcome {
  return { kind: "ack", ack };
}

export function bucketKey(this: CommandInbox, sessionId: string | null): string {
  return sessionId ?? GLOBAL_BUCKET;
}

export function keyGateKey(this: CommandInbox, key: CommandKey): string {
  return `${this["bucketKey"](key.sessionId)}\0${key.commandId}`;
}
