// Modified by ZCode Feiyu.
import {
  type AttachmentRef,
  type CommandEnvelope,
  type ConversationInputIntent,
} from "@zcode/shared/zcode-protocol-v4";

import type { ConversationRowTargetResolution } from "../zcode-protocol-v4/product-projection.js";

// 按职责拆分；保留原始规则、执行顺序与状态所有者。

export interface InputCommandForAdmission {
  inputOrigin?: "desktop" | "mobile";
  conversationQuotes?: import("@zcode/contracts").TurnInputIntentMetadata["conversationQuotes"];
  botGroupSource?: ConversationInputIntent["botGroupSource"];
  kind: ConversationInputIntent["kind"];
  text: string;
  attachments: readonly AttachmentRef[];
  sharedContextRefs?: ConversationInputIntent["sharedContextRefs"];
  requestedDelivery?: ConversationInputIntent["delivery"]["requested"];
  admittedDelivery?: ConversationInputIntent["delivery"]["admitted"];
  fallbackReasonCode?: string;
  highspeed?: ConversationInputIntent["highspeed"];
  provenance?: ConversationInputIntent["provenance"];
  interTaskSourceTaskId?: string;
  causalContext?: ConversationInputIntent["causalContext"];
}

export type ResolveAdmissionRowTarget = (
  sessionId: string,
  target: { rowId: number; entityId: string },
  action: "editUserQuery" | "retryTurn",
) => ConversationRowTargetResolution | null;

export function admissionAttachmentRefs(
  attachments: NonNullable<
    Extract<ConversationRowTargetResolution, { ok: true }>["editTarget"]
  >["intent"]["attachments"],
): AttachmentRef[] {
  return (
    attachments?.flatMap((attachment) =>
      attachment.ref
        ? [
            {
              // 重试／编辑必须保留与原 row 相同的附件来源，不能重新枚举字段丢失文本材料标记。
              ...attachment,
              ref: attachment.ref,
            },
          ]
        : [],
    ) ?? []
  );
}

/**
 * admission 只持久化真正会产生输入的命令。edit/retry 不能从 payload 猜 intent；
 * 必须复用 projection 的 canonical target，并把旧来源折叠进 provenance。
 */
export function resolveInputCommandForAdmission(
  envelope: CommandEnvelope,
  admissionSessionId: string,
  resolveRowTarget: ResolveAdmissionRowTarget,
): InputCommandForAdmission | null {
  if (envelope.type === "createSession") {
    const firstInput = (
      envelope.payload as {
        firstInput?: { text: string; attachments?: AttachmentRef[] };
      }
    ).firstInput;
    return firstInput
      ? {
          kind: "sendText",
          text: firstInput.text,
          attachments: firstInput.attachments ?? [],
        }
      : null;
  }
  if (envelope.type === "createSelectionSideSession") {
    const firstInput = (
      envelope.payload as {
        firstInput?: { text: string };
      }
    ).firstInput;
    return firstInput
      ? {
          kind: "sendText",
          text: firstInput.text,
          attachments: [],
        }
      : null;
  }
  if (envelope.type === "sendText" || envelope.type === "sendGoalCommand") {
    const payload = envelope.payload as {
      text: string;
      attachments?: AttachmentRef[];
      context_refs?: ConversationInputIntent["sharedContextRefs"];
      interTaskSourceTaskId?: string;
      causalContext?: ConversationInputIntent["causalContext"];
      highspeedMeta?: ConversationInputIntent["highspeed"];
      inputOrigin?: "desktop" | "mobile";
      conversationQuotes?: import("@zcode/contracts").TurnInputIntentMetadata["conversationQuotes"];
      botGroupSource?: ConversationInputIntent["botGroupSource"];
    };
    return {
      kind: envelope.type,
      text: payload.text,
      ...(payload.interTaskSourceTaskId
        ? {
            interTaskSourceTaskId: payload.interTaskSourceTaskId,
            causalContext: payload.causalContext,
          }
        : {}),
      attachments: payload.attachments ?? [],
      ...(payload.context_refs ? { sharedContextRefs: payload.context_refs } : {}),
      ...(payload.highspeedMeta ? { highspeed: payload.highspeedMeta } : {}),
      ...(payload.inputOrigin ? { inputOrigin: payload.inputOrigin } : {}),
      ...(payload.conversationQuotes ? { conversationQuotes: payload.conversationQuotes } : {}),
      ...(payload.botGroupSource ? { botGroupSource: payload.botGroupSource } : {}),
    };
  }
  if (envelope.type === "compact") {
    return { kind: "compact", text: "/compact", attachments: [] };
  }
  if (envelope.type !== "editUserQuery" && envelope.type !== "retryTurn") return null;
  if (!envelope.sessionId) return null;
  const payload = envelope.payload as {
    target: { rowId: number; entityId: string };
    newText?: string;
    conversationQuotes?: ConversationInputIntent["conversationQuotes"];
    attachments?: AttachmentRef[];
  };
  const resolution = resolveRowTarget(envelope.sessionId, payload.target, envelope.type);
  if (!resolution?.ok || !resolution.editTarget) return null;
  const canonical = resolution.editTarget;

  // 会先提交 append-only branch cut，不再为 edit 创建 hidden child。
  const originalSourceCommandId =
    canonical.intent.provenance?.sourceCommandId ?? canonical.intent.sourceCommandId;
  return {
    kind: canonical.intent.kind,
    ...(canonical.intent.causalContext ? { causalContext: canonical.intent.causalContext } : {}),
    ...(canonical.intent.interTaskSourceTaskId
      ? { interTaskSourceTaskId: canonical.intent.interTaskSourceTaskId }
      : {}),
    ...(canonical.intent.inputOrigin ? { inputOrigin: canonical.intent.inputOrigin } : {}),
    ...((payload.conversationQuotes ?? canonical.intent.conversationQuotes)
      ? { conversationQuotes: payload.conversationQuotes ?? canonical.intent.conversationQuotes }
      : {}),
    ...(canonical.intent.botGroupSource ? { botGroupSource: canonical.intent.botGroupSource } : {}),
    text:
      envelope.type === "editUserQuery"
        ? (payload.newText ?? canonical.intent.text)
        : canonical.intent.text,
    attachments:
      envelope.type === "editUserQuery" && payload.attachments
        ? payload.attachments
        : admissionAttachmentRefs(canonical.intent.attachments),
    ...(canonical.intent.requestedDelivery
      ? { requestedDelivery: canonical.intent.requestedDelivery }
      : {}),
    ...(canonical.intent.admittedDelivery
      ? { admittedDelivery: canonical.intent.admittedDelivery }
      : {}),
    ...(canonical.intent.fallbackReasonCode
      ? { fallbackReasonCode: canonical.intent.fallbackReasonCode }
      : {}),
    ...(originalSourceCommandId
      ? {
          provenance: canonical.intent.provenance ?? {
            sourceCommandId: originalSourceCommandId,
            ...(canonical.intent.queueItemId ? { queueItemId: canonical.intent.queueItemId } : {}),
            ...(canonical.intent.clientId ? { clientId: canonical.intent.clientId } : {}),
          },
        }
      : {}),
  };
}

export function isConversationInputAdmissionCommand(type: CommandEnvelope["type"]): boolean {
  return (
    type === "sendText" ||
    type === "sendGoalCommand" ||
    type === "compact" ||
    type === "editUserQuery" ||
    type === "retryTurn"
  );
}
