// Modified by ZCode Feiyu.
import {
  SessionEventType,
  type BashInput,
  type CommandCategory,
  type CommandExecutionSpanWriter,
  type CommandShellKind,
  type ExecutionEvent,
  type ExecutionResult,
} from "@zcode/contracts";

import type { ToolExecutionContext } from "../types.js";

import { classifyCommand, classifySafeCommandIdentity } from "./tool-perf.js";

// 按职责拆分；保留原始规则、执行顺序与状态所有者。

export function startBashCommandTelemetry(
  input: BashInput,
  context: ToolExecutionContext,
): CommandExecutionSpanWriter | undefined {
  const identity = classifySafeCommandIdentity(input.command);
  return context.telemetry?.startCommand({
    category: commandCategory(input.command),
    commandCount: identity.count ?? 0,
    safeName: identity.name ?? "other",
    sandboxed: input.dangerouslyDisableSandbox !== true,
    shellKind: commandShellKind(context.bashShellSelection),
  });
}

export function finishBashCommandTelemetry(
  telemetry: CommandExecutionSpanWriter | undefined,
  result: ExecutionResult,
): void {
  if (!telemetry) return;
  if (result.exitCode !== undefined) telemetry.setExitCode(result.exitCode);
  if (result.signal) telemetry.setSignal(result.signal);
  telemetry.setOutputBytes(result.stdout.bytes + result.stderr.bytes);
  telemetry.setTimedOut(result.timedOut);

  if (result.timedOut) {
    telemetry.markTerminationRequested("timeout");
    telemetry.finishFailed("timeout", "timeout", result.error);
  } else if (result.cancelled) {
    telemetry.markTerminationRequested("cancelled");
    telemetry.finishCancelled("abort_signal");
  } else if (result.status === "spawn_error") {
    telemetry.finishFailed("spawn", "configuration", result.error);
  } else if (result.status === "failed" && result.error) {
    // 非零退出码是命令事实（例如 grep 未匹配），不等同于执行框架失败。
    // 只有 Adapter 明确提供结构化 failure 时才污染 command failure rate。
    telemetry.finishFailed("execute", "internal", result.error);
  } else {
    telemetry.finishCompleted();
  }
}

export function commandCategory(command: string): CommandCategory {
  switch (classifyCommand(command)) {
    case "git":
      return "git";
    case "package":
      return "package_manager";
    case "build":
      return "build";
    case "test":
      return "test";
    case "network":
      return "network";
    default:
      return "shell";
  }
}

export function commandShellKind(
  selection: ToolExecutionContext["bashShellSelection"],
): CommandShellKind | undefined {
  const displayName = selection?.display.name.toLowerCase();
  if (displayName?.includes("powershell")) return "powershell";
  if (displayName?.includes("zsh")) return "zsh";
  if (displayName?.includes("bash")) return "bash";
  if (selection?.dialect === "cmd") return "cmd";
  if (selection?.dialect === "posix") return "sh";
  return selection ? "other" : undefined;
}

export async function emitProgressEvent(
  event: Extract<ExecutionEvent, { type: "progress" }>,
  context: ToolExecutionContext,
): Promise<void> {
  if (!context.emitEvent) return;

  await context.emitEvent({
    id: crypto.randomUUID() as any,
    sessionId: context.sessionId,
    turnId: context.turnId,
    type: SessionEventType.ToolCallProgress,
    timestamp: event.timestamp,
    traceId: context.traceId,
    sequenceNumber: 0,
    payload: {
      toolCallId: context.toolCallId,
      toolName: "Bash",
      elapsedMs: event.elapsedMs,
      pid: event.pid,
      stdoutBytes: event.stdoutBytes,
      stderrBytes: event.stderrBytes,
      outputBytes: event.stdoutBytes + event.stderrBytes,
      outputPreview: event.outputPreview,
      stdoutTail: event.stdoutTail,
      stderrTail: event.stderrTail,
    },
  });
}
