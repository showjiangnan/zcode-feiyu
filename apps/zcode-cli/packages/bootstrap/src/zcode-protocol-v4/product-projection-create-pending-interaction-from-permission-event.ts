// Modified by ZCode Feiyu.
import type {
  SessionEvent,
  PermissionRequestedPayload,
  PermissionResolvedPayload,
  PermissionDeniedPayload,
} from "@zcode/contracts";
import type { PendingInteraction, ConversationDelta } from "@zcode/shared/zcode-protocol-v4";
import {
  isAskUserQuestionToolName,
  readAskUserQuestionPayloadQuestions,
  isPlainRecord,
  isExitPlanModeToolName,
  createExitPlanModeApprovalQuestion,
  toProtocolToolCallDisplay,
} from "./product-projection-stream-recovery-reason-code.js";
import {
  MCP_ELICITATION_TOOL_NAME,
  MCP_ELICITATION_INTERACTION,
  mcpElicitationQuestions,
} from "./mcp-elicitation.js";
import { PERMISSION_FULL_ACCESS_OPTION_ID } from "@zcode/shared/zcode-protocol-v4";
import {
  buildProtocolPermissionOptions,
  SESSION_ALLOW_PERMISSION_OPTION_KIND,
} from "../permission-options.js";
import { CREATE_WORKFLOW_TOOL_NAME, AMEND_WORKFLOW_TOOL_NAME } from "@zcode/contracts";
import { WORKFLOW_REFINE_PERMISSION_OPTION_ID } from "@zcode/shared";
import type { ProductProjection } from "./product-projection.js";

export function createPendingInteractionFromPermissionEvent(
  this: ProductProjection,
  event: SessionEvent,
  payload: PermissionRequestedPayload,
  toolCallId: string,
  interactionId: string,
): PendingInteraction {
  if (isAskUserQuestionToolName(payload.toolName)) {
    // AskUserQuestion 的 permission_requested 只是 runtime 等待态；
    // v4 UI 需要结构化 questions 才能回填 answers，而不是 Allow/Deny 权限弹窗。
    return {
      interactionId,
      kind: "userInput",
      anchorRowId: this["toolRowIdByCallId"].get(toolCallId) ?? null,
      createdAt: this["ms"](event),
      payload: {
        kind: "userInput",
        prompt: payload.reason,
        freeText: true,
        toolCallId,
        toolName: payload.toolName,
        traceId: event.traceId,
        input: payload.input,
        schema: { toolName: payload.toolName },
        questions: readAskUserQuestionPayloadQuestions(payload.input),
        ...(payload.origin ? { origin: payload.origin } : {}),
      },
    };
  }
  if (payload.toolName === MCP_ELICITATION_TOOL_NAME) {
    // MCP elicitation：requestedSchema → 结构化问题，
    // 与 broker 用同一映射，v4 UI 复用 ElicitationDialog。
    const elicitation = isPlainRecord(payload.input) ? payload.input : {};
    return {
      interactionId,
      kind: "userInput",
      anchorRowId: this["toolRowIdByCallId"].get(toolCallId) ?? null,
      createdAt: this["ms"](event),
      payload: {
        kind: "userInput",
        prompt: payload.reason,
        freeText: true,
        toolCallId,
        toolName: payload.toolName,
        traceId: event.traceId,
        input: payload.input,
        schema: {
          interaction: MCP_ELICITATION_INTERACTION,
          serverName: elicitation.serverName,
          requestedSchema: elicitation.requestedSchema,
        },
        questions: mcpElicitationQuestions(payload.reason, elicitation.requestedSchema),
        ...(payload.origin ? { origin: payload.origin } : {}),
      },
    };
  }
  if (isExitPlanModeToolName(payload.toolName)) {
    // ExitPlanMode 复用 userInput/elicitation 通道承载计划审批反馈；
    // 普通 permission payload 无法表达 approve/custom feedback 的业务语义。
    return {
      interactionId,
      kind: "userInput",
      anchorRowId: this["toolRowIdByCallId"].get(toolCallId) ?? null,
      createdAt: this["ms"](event),
      payload: {
        kind: "userInput",
        prompt: payload.reason,
        freeText: true,
        toolCallId,
        toolName: payload.toolName,
        traceId: event.traceId,
        input: payload.input,
        schema: { interaction: "plan_approval", toolName: payload.toolName },
        questions: [createExitPlanModeApprovalQuestion(payload.reason)],
        ...(payload.origin ? { origin: payload.origin } : {}),
      },
    };
  }
  const askDisplay = toProtocolToolCallDisplay(payload.display);
  return {
    interactionId,
    kind: "permission",
    anchorRowId: this["toolRowIdByCallId"].get(toolCallId) ?? null,
    createdAt: this["ms"](event),
    payload: {
      kind: "permission",
      toolCallId,
      toolName: payload.toolName,
      summary: payload.reason,
      detail: payload.input,
      freeText: true,
      ...(payload.approvalMode !== "user-once" &&
      payload.fullAccessSupported === true &&
      !payload.origin &&
      !payload.optionsPolicy
        ? {
            fullAccessOption: {
              optionId: PERMISSION_FULL_ACCESS_OPTION_ID,
              label: "Full access",
              kind: "custom" as const,
              response: { decision: "deny" as const, reason: "Full access requires V4 approval" },
            },
          }
        : {}),
      ...(payload.origin ? { origin: payload.origin } : {}),
      ...(askDisplay ? { display: askDisplay } : {}),
      options: [
        ...buildProtocolPermissionOptions({
          approvalMode: payload.approvalMode,
          input: payload.input,
          suggestedPermissionUpdates: payload.suggestedPermissionUpdates,
          ...(payload.optionsPolicy ? { optionsPolicy: payload.optionsPolicy } : {}),
          toolName: payload.toolName,
        }).map((option) => ({
          optionId:
            option.kind === "allow_once"
              ? "allowOnce"
              : option.kind === "allow_always"
                ? "allowAlways"
                : option.optionId,
          label: option.name,
          // 会话免确认的 kind 映到闭集里的 allowAlways（排序槽位 / 样式与 always allow 同），
          // optionId 原样 allowSession——broker 靠它精确命中，GUI 靠 name 本地化。
          kind:
            option.kind === "allow_once"
              ? ("allowOnce" as const)
              : option.kind === "allow_always" ||
                  option.kind === SESSION_ALLOW_PERMISSION_OPTION_KIND
                ? ("allowAlways" as const)
                : ("deny" as const),
          response: option.response,
        })),
        // workflow Refine 只在 v4 投放（legacy 选项列表刻意不含，见 session-mapper 注释）。
        // 静态 response 是普通 deny：任何不认识该
        // optionId 的消费面（无 freeText 的应答）都退化为拒绝，反馈升级只发生在
        // interaction-broker 对 freeText 的特判里。
        ...(payload.toolName === CREATE_WORKFLOW_TOOL_NAME ||
        payload.toolName === AMEND_WORKFLOW_TOOL_NAME
          ? [
              {
                optionId: WORKFLOW_REFINE_PERMISSION_OPTION_ID,
                label: "Refine",
                kind: "custom" as const,
                response: { decision: "deny" as const, reason: "Denied" },
              },
            ]
          : []),
      ],
    },
  };
}

export function onPermissionResolved(
  this: ProductProjection,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as PermissionResolvedPayload;
  return this["settlePermission"](
    String(payload.toolCallId),
    payload.decision === "deny" ? "cancelled" : "running",
  );
}

export function onPermissionDenied(
  this: ProductProjection,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as PermissionDeniedPayload;
  return this["settlePermission"](String(payload.toolCallId), "cancelled");
}
