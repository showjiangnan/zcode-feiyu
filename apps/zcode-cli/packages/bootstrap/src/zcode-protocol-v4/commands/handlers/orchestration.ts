// Modified by ZCode Feiyu contributors (2026).
import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@zcode/shared/zcode-protocol-v4";
import { requireRecord } from "../record-access.js";
import { isTaskListSessionType } from "../../task-list-session-membership.js";
import type { V4CommandCoreHost } from "../types.js";

async function setOrchestrationMode(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const record = requireRecord(host, envelope.sessionId);
  if (!isTaskListSessionType(record.taskType)) {
    throw new Error("Only top-level sessions can change orchestration mode");
  }
  const payload = envelope.payload as CommandPayloadMap["setOrchestrationMode"];
  await record.app.runtime.requestOrchestrationMode(payload.mode);
  return undefined;
}

async function controlProactiveWork(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const record = requireRecord(host, envelope.sessionId);
  if (!isTaskListSessionType(record.taskType))
    throw new Error("Only top-level sessions can start proactive work");
  const payload = envelope.payload as CommandPayloadMap["controlProactiveWork"];
  await record.app.runtime.controlProactiveWork(payload.action, payload.subscriptions);
  return undefined;
}
export const orchestrationHandlers = { setOrchestrationMode, controlProactiveWork };
