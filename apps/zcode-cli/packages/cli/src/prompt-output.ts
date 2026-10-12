// Modified by ZCode Feiyu.
import { formatJson } from "@zcode/core";
import type { RunContext, GlobalOptions } from "@zcode/shared-types";
import type { ModeCapableApp } from "./cli-types.js";
import {
  resolveHeadlessWorkspaceHookTrustDiagnostic,
  writeHeadlessWorkspaceHookTrustDiagnostic,
} from "./prompt-hook-diagnostic.js";
import { wantsJsonSummary } from "./prompt-output-options.js";

export function writePromptOutput({
  ctx,
  options,
  sessionId,
  traceId,
  result,
  response,
  turnResponses,
  hookTrustDiagnostic,
  streamsEvents,
}: {
  ctx: RunContext;
  options: GlobalOptions;
  sessionId: string;
  traceId: string;
  result: Awaited<ReturnType<ModeCapableApp["submitPrompt"]>>;
  response: string;
  turnResponses: string[];
  hookTrustDiagnostic: Awaited<ReturnType<typeof resolveHeadlessWorkspaceHookTrustDiagnostic>>;
  streamsEvents: boolean;
}): number {
  const multiTurn = turnResponses.length > 1;

  if (streamsEvents) {
    // Closing summary, on its own line and tagged so it can be told apart
    // from the events preceding it. Same fields as --json, so a caller that
    // already parses that keeps working.
    ctx.stdout.write(
      `${JSON.stringify({
        type: "result",
        sessionId: sessionId,
        traceId,
        ...(result.turnId ? { turnId: result.turnId } : {}),
        response,
        ...(multiTurn ? { turnResponses } : {}),
        ...(result.usage ? { usage: { ...result.usage } } : {}),
        eventCount: result.events.length,
        projection: {
          status: result.projection.status,
          turnCount: result.projection.turnCount,
          totalTokenCount: result.projection.totalTokenCount,
          contextUsed: result.projection.contextUsed ?? null,
          contextWindow: result.projection.contextWindow ?? null,
        },
      })}\n`,
    );
    return 0;
  }

  if (wantsJsonSummary(options)) {
    ctx.stdout.write(
      formatJson({
        sessionId: sessionId,
        traceId,
        ...(result.turnId ? { turnId: result.turnId } : {}),
        response,
        ...(multiTurn ? { turnResponses } : {}),
        ...(result.usage ? { usage: { ...result.usage } } : {}),
        eventCount: result.events.length,
        ...(hookTrustDiagnostic
          ? {
              workspaceHookTrust: {
                workspacePath: hookTrustDiagnostic.workspacePath,
                workspaceIdentity: hookTrustDiagnostic.workspaceIdentity,
                bundleDigest: hookTrustDiagnostic.bundleDigest,
                reasonCode: hookTrustDiagnostic.reasonCode,
                items: hookTrustDiagnostic.items.map((item) => ({
                  reviewItemId: item.reviewItemId,
                  event: item.event,
                  matcher: item.matcher,
                  displayCommand: item.displayCommand,
                  sourcePath: item.sourcePath,
                  configuredEnabled: item.configuredEnabled,
                  hookDeclarationDigest: item.hookDeclarationDigest,
                  trustState: item.trustState,
                })),
              },
            }
          : {}),
        projection: {
          status: result.projection.status,
          turnCount: result.projection.turnCount,
          totalTokenCount: result.projection.totalTokenCount,
          contextUsed: result.projection.contextUsed ?? null,
          contextWindow: result.projection.contextWindow ?? null,
        },
      }),
    );
    return 0;
  }

  if (hookTrustDiagnostic) writeHeadlessWorkspaceHookTrustDiagnostic(ctx, hookTrustDiagnostic);
  // 每个回合的文本按到达序打印，所以最后一段自然就是结算后的总结。
  // 单回合时这与 `${result.response}\n` 逐字节相同。
  ctx.stdout.write(`${turnResponses.join("\n\n")}\n`);
  return 0;
}
