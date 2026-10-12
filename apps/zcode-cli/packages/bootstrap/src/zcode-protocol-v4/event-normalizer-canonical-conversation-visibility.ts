// Modified by ZCode Feiyu.
import type {
  SessionEvent,
  BackgroundResultOriginMeta,
  WorkflowLaunchMeta,
  TurnInputIntentMetadata,
  HighspeedMessageMetadata,
  ModelStreamingPayload,
  TurnStartedPayload,
  SyntheticUserMessageSource,
  TurnAttachmentMeta,
} from "@zcode/contracts";
import type { AttachmentRef } from "@zcode/shared/zcode-protocol-v4";
import { SessionEventType } from "@zcode/contracts";

export type CanonicalConversationVisibility = "visible" | "modelOnly" | "stateOnly";

export type CanonicalConversationOrigin =
  | "realUser"
  | "interTaskAuto"
  | "backgroundResult"
  | "goalContinuation"
  | "mailbox"
  | "synthetic"
  | "workflowLaunch"
  | "assistant"
  | "system";

export interface CanonicalConversationPlacement {
  lane: "trigger" | "assistantWork" | "stateOnly";
  relation: "withinProductTurn" | "none";
}

export interface ConversationNormalizationDiagnostic {
  code:
    | "normalizer.user.missingTranscriptMessageId"
    | "normalizer.assistant.missingTranscriptMessageId";
  eventId: string;
}

export interface CanonicalConversationFactBase {
  event: SessionEvent;
  entityId: string;
  productTurnId: string;
  runtimeTurnId: string;
  transcriptMessageId: string | null;
  visibility: CanonicalConversationVisibility;
  origin: CanonicalConversationOrigin;
  placement: CanonicalConversationPlacement;
  diagnostics: readonly ConversationNormalizationDiagnostic[];
}

export interface CanonicalTurnAttachment extends Omit<AttachmentRef, "ref"> {
  ref?: string;
}

export interface CanonicalUserIntentFact extends CanonicalConversationFactBase {
  inputOrigin?: "desktop" | "mobile";
  conversationQuotes?: import("@zcode/contracts").TurnInputIntentMetadata["conversationQuotes"];
  botGroupSource?: import("@zcode/shared").BotGroupInputSource;
  semanticKind: "userIntent";
  visibility: "visible" | "modelOnly";
  // 用户意图事实只可能来自输入侧来源，助手与系统来源不在其中；复用总来源联合，避免两处各维护一份。
  origin: Exclude<CanonicalConversationOrigin, "assistant" | "system">;
  input: string;
  intentText: string;
  intentKind: "sendText" | "sendGoalCommand";
  turnNumber: number;
  executionKind: "agent" | "controlOnly";
  turnHeaderOrigin:
    | "userInput"
    | "backgroundResult"
    | "goalContinuation"
    | "editRerun"
    | "workflowLaunch";
  originMeta?: BackgroundResultOriginMeta;
  /**
   * 中枢直接启动已保存工作流的启动轮元数据（`inputSource === "workflow_launch"` 时在场）。
   * 活投影据它在 turnHeader / userInput 两行上画启动卡；与消息 metadata 里的同一份对齐（冷热同形）。
   */
  workflowLaunch?: WorkflowLaunchMeta;
  /** `input` 从此下标起是引擎附加文本。 */
  epilogueStart?: number;
  sourceCommandId?: string;
  sourceTaskId?: string;
  causalContext?: TurnInputIntentMetadata["causalContext"];
  foregroundExecutionId?: string;
  clientId?: string;
  highspeed?: HighspeedMessageMetadata;
  attachments?: readonly CanonicalTurnAttachment[];
  queueItemId?: string;
  admissionSeq?: number;
  admittedAt?: number;
  requestedDelivery?: "auto" | "startNow" | "queue" | "guide";
  admittedDelivery?: "startNow" | "queue" | "guide";
  sharedContextRefs?: readonly { kind: "shared_context_import"; context_id: string }[];
  fallbackReasonCode?: string;
  modelSelection?: TurnInputIntentMetadata["modelSelection"];
  mode?: TurnInputIntentMetadata["mode"];
  planEnabled?: boolean;
  provenance?: {
    sourceCommandId: string;
    queueItemId?: string;
    clientId?: string;
  };
  source?: TurnInputIntentMetadata["source"];
}

export interface CanonicalModelStream {
  kind: ModelStreamingPayload["kind"];
  delta: string;
  done: boolean;
  assistantResponseId?: string;
  transcriptPartId?: string;
  toolCallId?: ModelStreamingPayload["toolCallId"];
  toolName?: string;
  input?: unknown;
  providerExecuted?: boolean;
}

export interface CanonicalAssistantSegmentFact extends CanonicalConversationFactBase {
  semanticKind: "assistantSegment";
  visibility: "visible";
  origin: "assistant";
  stream: CanonicalModelStream;
}

export interface CanonicalPassthroughFact extends CanonicalConversationFactBase {
  semanticKind: "passthrough";
  sourceCommandId?: string;
}

export type CanonicalConversationFact =
  | CanonicalUserIntentFact
  | CanonicalAssistantSegmentFact
  | CanonicalPassthroughFact;

export interface CanonicalOpenSegmentIdentity {
  entityId: string;
  transcriptMessageId: string | null;
}

export interface NormalizeConversationEventContext {
  productTurnId?: string;
  openAssistantSegments?: Partial<Record<"text" | "reasoning", CanonicalOpenSegmentIdentity>>;
}

export function runtimeTurnIdOf(event: SessionEvent): string {
  if (event.turnId) return String(event.turnId);
  if (event.type === SessionEventType.TurnStarted) {
    const payload = event.payload as TurnStartedPayload;
    return `turn-${payload.turnNumber}`;
  }
  return "turn-unknown";
}

export function userInputOrigin(
  source: SyntheticUserMessageSource | undefined,
): CanonicalUserIntentFact["origin"] {
  switch (source) {
    case "background_task":
      return "backgroundResult";
    case "goal-continuation":
      return "goalContinuation";
    case "subagent":
    case "subagent_message":
      // child 回复是 mailbox runtime carrier，不是真实用户输入；
      // live/cold 即使都隐藏它，也必须保留相同 canonical origin。
      return "mailbox";
    case "fork":
    case "plugin_reference":
    case "rewind":
    case "todo_reminder":
      return "synthetic";
    // 中枢直接启动：用户在中枢里的真实动作，可见 user row 但以启动卡呈现（origin 区分它与普通气泡）。
    case "workflow_launch":
      return "workflowLaunch";
    default:
      return "realUser";
  }
}

export function turnHeaderOrigin(
  source: SyntheticUserMessageSource | undefined,
): CanonicalUserIntentFact["turnHeaderOrigin"] {
  switch (source) {
    case "background_task":
      return "backgroundResult";
    case "goal-continuation":
      return "goalContinuation";
    case "rewind":
      return "editRerun";
    // 中枢直接启动：turnHeader 与 userInput 同用 workflowLaunch origin，UI 据此画启动卡而非用户气泡。
    case "workflow_launch":
      return "workflowLaunch";
    default:
      return "userInput";
  }
}

export function normalizeAttachment(attachment: TurnAttachmentMeta): CanonicalTurnAttachment {
  return {
    ...(attachment.ref ? { ref: attachment.ref } : {}),
    fileName: attachment.fileName,
    mime: attachment.mime,
    bytes: attachment.bytes,
  };
}

export function normalizeAttachments(payload: TurnStartedPayload): {
  attachments?: readonly CanonicalTurnAttachment[];
} {
  if (payload.intent?.attachmentRefs && payload.intent.attachmentRefs.length > 0) {
    return { attachments: payload.intent.attachmentRefs.map((attachment) => ({ ...attachment })) };
  }
  if (!payload.attachments || payload.attachments.length === 0) return {};
  return { attachments: payload.attachments.map(normalizeAttachment) };
}
