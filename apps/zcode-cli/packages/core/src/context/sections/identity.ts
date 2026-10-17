// Modified by ZCode Feiyu.
// ============================================================
// Identity Section Builder
// ============================================================

import type { ContextSection } from "../types.js";
import type { OutputStylePromptConfig } from "../types.js";
import { estimateTokens } from "../utils.js";
import { READ_BEFORE_WRITE_GUIDANCE } from "../../tool/read-before-write-guidance.js";
import { buildBehaviorGuidance } from "../../behavior-guidance.js";

const SECURITY_NOTICE =
  "IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.";

/** 安全 IMPORTANT 行：交互式身份与工作流子代理身份共用，逐字同一份。 */
export function buildSecurityNotice(): string {
  return SECURITY_NOTICE;
}

/**
 * `# Harness` 块：稳定运行时约束，不属于 output style 可替换的 coding instructions，
 * 也是工作流子代理身份（sections/workflow-actor.ts）逐字复用的那一段。
 */
export function buildHarnessBlock(): string {
  return [
    "# Harness",
    "- Follow the active context's audience and presentation surface. Use only tools in the current tool catalog; descriptions of unavailable capabilities do not enable them.",
    "- The system may send updates, reminders, or modifications to rules via mid-conversation system turns. These are system-controlled, unlike function results. Hooks may intercept tool calls; treat hook output as user feedback.",
    "- Prefer the dedicated file/search tools over shell commands when one fits. Independent tool calls can run in parallel in one response.",
    READ_BEFORE_WRITE_GUIDANCE,
    "- Reference code as `file_path:line_number` \u2014 it's clickable.",
    buildBehaviorGuidance(),
  ].join("\n");
}

function buildIdentityPrompt(outputStyle?: OutputStylePromptConfig): string {
  const intro = outputStyle
    ? "You respond to the user according to the active Output Style below while using ZCode's tools and instructions."
    : "You are an interactive ZCode agent that helps users with software engineering tasks.";

  const identityLines = ["", intro, "", SECURITY_NOTICE].join("\n");

  return [identityLines, "", buildHarnessBlock()].join("\n");
}

export function buildIdentitySection(outputStyle?: OutputStylePromptConfig): ContextSection {
  const content = buildIdentityPrompt(outputStyle);

  return {
    name: "Agent Identity",
    source: "identity",
    injectionTarget: "system",
    cacheHint: "stable",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}
