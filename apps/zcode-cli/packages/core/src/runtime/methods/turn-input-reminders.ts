// Modified by ZCode Feiyu.
import { formatLocalIsoDate } from "../deps.js";
import { buildDateChangeReminderBody } from "../helpers/index.js";
import type { ExecuteTurnOptions } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";

import { buildReferencedSessionContextReminderBody } from "../../session-context/read-session-context.js";

export function injectDateChangeReminderIntoMessageHistory(this: AgentRuntimeInternal): void {
  const currentDate = formatLocalIsoDate(this.now());
  const previousDate = this.lastEmittedLocalDate;
  this.lastEmittedLocalDate = currentDate;

  if (!previousDate || previousDate === currentDate) {
    return;
  }

  this.messageHistory.addAttachment(
    "date_change",
    buildDateChangeReminderBody(previousDate, currentDate),
  );
}
export function injectReferencedSessionContextReminderIntoMessageHistory(
  this: AgentRuntimeInternal,
  input: string,
  options?: ExecuteTurnOptions,
): void {
  if (options?.inputVisibility === "model-only") return;
  const reminderBody = buildReferencedSessionContextReminderBody(input);
  if (!reminderBody) return;
  this.messageHistory.addAttachment("referenced_session_context", reminderBody);
}
export function commandIdForImage(options?: ExecuteTurnOptions): string | undefined {
  return options?.intent?.sourceCommandId ?? options?.inputId;
}
