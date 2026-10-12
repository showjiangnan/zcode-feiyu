// Modified by ZCode Feiyu.
import type { CommandAck, ConversationInputIntent } from "@zcode/shared/zcode-protocol-v4";
import { parseCommandEnvelope, PROTOCOL_V4_LIMITS } from "@zcode/shared/zcode-protocol-v4";
import { ConversationTopicPublisher } from "./conversation-topic-publisher.js";
import {
  V4CommandNoopError,
  V4CommandNotImplementedError,
} from "./v4-gateway-conversation-v4-gateway-options.js";
import type { ConversationV4Gateway } from "./v4-gateway.js";

export async function handleCommand(
  this: ConversationV4Gateway,
  rawParams: unknown,
): Promise<CommandAck> {
  let ttftCapacityRejected = false;
  const ttftCommand =
    typeof rawParams === "object" && rawParams !== null && "ttft" in rawParams
      ? parseCommandEnvelope(rawParams)
      : undefined;
  if (ttftCommand?.ok && ttftCommand.envelope.ttft) {
    const sessionId = ttftCommand.envelope.sessionId;
    const control = sessionId
      ? this["publishers"].get(sessionId)?.getSnapshot().control
      : undefined;
    ttftCapacityRejected = !this["localTtft"].receive(
      ttftCommand.envelope,
      control?.canStop === true,
    );
  }
  // READY 只存在于冷恢复窗口；正常命令直接进入 inbox，避免重复解析信封。
  if (this["readyFlights"].size > 0) {
    const parsed = parseCommandEnvelope(rawParams);
    const sessionId = parsed.ok ? parsed.envelope.sessionId : null;
    const ready = sessionId === null ? undefined : this["readyFlights"].get(sessionId);
    if (ready) await ready;
  }
  const outcome = await this["inbox"].handle(rawParams);
  if (outcome.kind === "ack")
    return {
      ...outcome.ack,
      ...(ttftCapacityRejected ? { ttftExcluded: "capacity" as const } : {}),
    };
  this["localTtft"].admitted(outcome.envelope.commandId);
  let durableInputIntent: ConversationInputIntent | null = null;
  let settledAck: CommandAck | null = null;
  type CommandFinal = Parameters<typeof outcome.settle>[0];
  const reportError = (scope: string, error: unknown): void => {
    try {
      this["host"].onError?.(scope, error);
    } catch {
      // 错误观察器不能反向破坏 command final 与 session FIFO 的收口。
    }
  };
  const settleOnce = (final: CommandFinal): CommandAck => {
    if (settledAck) return settledAck;
    const ack = {
      ...outcome.ack,
      ...final,
      ...(ttftCapacityRejected ? { ttftExcluded: "capacity" as const } : {}),
    };
    outcome.settle(final);
    settledAck = ack;
    return ack;
  };
  const cancelDurableInput = async (reason: string): Promise<void> => {
    if (!durableInputIntent) return;
    try {
      await this["host"].cancelCommandInput?.(outcome.envelope, outcome.queueItemId, reason);
    } catch (cancelError) {
      // 原命令 ACK 必须保留真实执行结果；ledger cancel 失败单独告警，不能覆盖原错误。
      reportError("v4.command.input.cancel", cancelError);
    }
  };
  const releaseDurableInput = (
    final: Pick<CommandAck, "status" | "reasonCode" | "message" | "result">,
  ) => {
    if (!durableInputIntent || outcome.envelope.sessionId === null) return;
    try {
      this["inbox"].releaseLiveInput(
        {
          sessionId: outcome.envelope.sessionId,
          commandId: durableInputIntent.sourceCommandId,
        },
        { ...outcome.ack, ...final },
      );
    } catch (releaseError) {
      reportError("v4.command.input.release", releaseError);
    }
  };
  try {
    const admission = {
      admissionSeq: outcome.admissionSeq,
      admittedAt: outcome.admittedAt,
      queueItemId: outcome.queueItemId,
    };
    const admissionPublisher =
      outcome.envelope.type === "createSession"
        ? new ConversationTopicPublisher(`pending-${outcome.envelope.commandId}`, "admission", {
            now: this["now"],
          })
        : outcome.envelope.sessionId === null
          ? null
          : this["ensurePublisher"](outcome.envelope.sessionId);
    const admissionProjectionBytes = admissionPublisher?.measureInputAdmissionProjectionBytes(
      outcome.envelope,
      admission,
    );
    if (
      admissionProjectionBytes !== null &&
      admissionProjectionBytes !== undefined &&
      admissionProjectionBytes > PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes
    ) {
      return settleOnce({
        status: "failed",
        reasonCode: "proto.payloadTooLarge",
        message: `conversation projection would exceed ${PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes} bytes`,
      });
    }
    durableInputIntent =
      (await this["host"].admitCommandInput?.(outcome.envelope, admission)) ?? null;
    if (durableInputIntent && outcome.envelope.sessionId !== null) {
      this["inbox"].pinLiveInput(outcome.envelope.sessionId, durableInputIntent);
    }
    const result = await this["host"].executeCommand(outcome.envelope, admission);
    // 新建/侧聊命令采用结果会话的开关，避免把父会话或当前 App 设置误记到新会话。
    const telemetrySessionId =
      result?.type === "createSession" || result?.type === "createSelectionSideSession"
        ? result.sessionId
        : outcome.envelope.sessionId;
    const memoryEnabled = telemetrySessionId
      ? this["host"].getSessionMemoryEnabled?.(telemetrySessionId)
      : undefined;
    const final = {
      status: "accepted" as const,
      ...(result ? { result } : {}),
      ...(memoryEnabled !== undefined ? { memoryEnabled } : {}),
    };
    return settleOnce(final);
  } catch (error) {
    // noop 不是失败（同值切换收口）：不进 onError，noop ACK 返回。
    if (error instanceof V4CommandNoopError) {
      await cancelDurableInput(error.reasonCode);
      const final = {
        status: "noop" as const,
        reasonCode: error.reasonCode,
      };
      releaseDurableInput(final);
      return settleOnce(final);
    }
    reportError("v4.command.execute", error);
    // 携带 reasonCode 的领域错误（V4PromptRejectedError / heldQueueDispositionRequired 等）
    // 原样上行，客户端才能按 guard 错误码分流；否则归一 executionFailed。
    const domainReasonCode =
      typeof (
        error as {
          reasonCode?: unknown;
        } | null
      )?.reasonCode === "string"
        ? String(
            (
              error as {
                reasonCode: string;
              }
            ).reasonCode,
          )
        : null;
    const final = {
      status: "failed" as const,
      reasonCode:
        error instanceof V4CommandNotImplementedError
          ? "fault.command.notImplemented"
          : (domainReasonCode ?? "fault.command.executionFailed"),
      message: error instanceof Error ? error.message : String(error),
    };
    await cancelDurableInput(final.reasonCode);
    releaseDurableInput(final);
    return settleOnce(final);
  } finally {
    if (!settledAck) {
      // publisher/measure/admission 任一同步异常过去会跳过 settle，
      // 导致相同 command 永久等待、同 session FIFO 也无法继续 admission。
      const final = {
        status: "failed" as const,
        reasonCode: "fault.command.executionFailed",
        message: "command admission terminated before a durable final was recorded",
      };
      releaseDurableInput(final);
      settleOnce(final);
    }
  }
}
