// Modified by ZCode Feiyu.
import { matchDangerousCommand } from "./guarded/command.js";
import { type ExecutionShellSelection } from "@zcode/contracts";

import type {
  ToolRuntimePermissionCapability,
  ToolRuntimePermissionCapabilityContext,
} from "../types.js";

import { readStringProperty } from "./bash-metadata.js";

import {
  prepareBashPermissionMatcherForCommand,
  isBashReadOnlyCommand,
  isRuntimeReadOnlyBashCommand,
  type BashPermissionMatcher,
} from "./bash-semantics.js";

// 按职责拆分；保留原始规则、执行顺序与状态所有者。

/** session shell selection 尚未初始化时 guarded matcher 采用的文法；与 readonly 判定的假设一致。 */
export const GUARDED_DEFAULT_DIALECT: ExecutionShellSelection["dialect"] = "posix";

export function isBashInputReadOnly(input: unknown): boolean {
  const command = readStringProperty(input, "command");
  return command ? isBashReadOnlyCommand(command) : false;
}

export function isBashInputConcurrencySafe(input: unknown): boolean {
  return isBashInputReadOnly(input);
}

export function checkBashInputPermissions(input: unknown): { behavior: "allow" } | undefined {
  return resolveBashPermissionCapability(input) ? { behavior: "allow" } : undefined;
}

export function prepareBashPermissionMatcher(input: unknown): BashPermissionMatcher | undefined {
  const command = readStringProperty(input, "command");
  return command === undefined ? undefined : prepareBashPermissionMatcherForCommand(command);
}

export function resolveBashPermissionCapability(
  input: unknown,
  context?: ToolRuntimePermissionCapabilityContext,
): ToolRuntimePermissionCapability | undefined {
  const command = readStringProperty(input, "command");
  if (command && context?.mode === "guarded") {
    // selection 缺失是基础设施状态而非语法边界；与下方 isRuntimeReadOnlyBashCommand 一致按 POSIX
    // 文法匹配，避免 guarded 在 selection 尚未初始化时静默退回 YOLO。显式 legacy-shell 仍 unsupported。
    const match = matchDangerousCommand(
      command,
      context.bashShellSelection?.dialect ?? GUARDED_DEFAULT_DIALECT,
    );
    if (match.status === "matched") return { userApprovalRule: match.ruleId };
  }
  if (!command || !isRuntimeReadOnlyBashCommand(command, context)) return undefined;
  return {
    destructive: false,
    needsApproval: false,
    readOnly: true,
    riskLevel: "low" as const,
    sideEffectScope: "none" as const,
    permission: {
      needsApproval: false,
      riskLevel: "low" as const,
      sideEffectScope: "none" as const,
    },
  };
}
