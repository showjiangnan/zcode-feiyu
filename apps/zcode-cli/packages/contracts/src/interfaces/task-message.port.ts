import type { TaskAppRequest, TaskAppResponse } from "@zcode/shared";

export interface TaskMessageTarget {
  taskId: string;
  title: string;
  status: string;
}

export interface TaskMessageSendResult {
  ok: boolean;
  error?: string;
  delivery?: "startNow" | "queue" | "guide";
  fallbackReasonCode?: string;
  targetTurnId?: string;
  inputId?: string;
  targetTaskId: string;
}

export interface TaskMessagePort {
  request?(input: TaskAppRequest, signal?: AbortSignal): Promise<TaskAppResponse>;
  list(input: { sourceSessionId: string }): Promise<TaskMessageTarget[]>;
  send(input: {
    sourceSessionId: string;
    targetTaskId: string;
    requestId: string;
    message: string;
  }): Promise<TaskMessageSendResult>;
}
