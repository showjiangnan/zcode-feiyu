// Modified for ZCode Feiyu (2026): local task services, privacy controls and image generation.
import type { TaskAppOperation, TaskAppResponse } from "@zcode/shared";

export interface SessionMessageSendRequested {
  content: string;
  createdAt: string;
  fromSessionId: string;
  messageId: string;
  requestId: string;
  toSessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  operation?: TaskAppOperation;
}

export interface SessionMessageDeliveryResult {
  error?: string;
  messageId: string;
  requestId: string;
  sessionId: string;
  status: "success" | "failed" | "unknown";
  delivery?: "startNow" | "queue" | "guide";
  fallbackReasonCode?: string;
  targetTurnId?: string;
  inputId?: string;
  response?: TaskAppResponse;
}
