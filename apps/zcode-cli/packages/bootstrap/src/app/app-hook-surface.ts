// Modified by ZCode Feiyu.
import type { ZCodeApp } from "./types.js";
import type { AppReturnSurfaceInput } from "./app-return-surface-types.js";
// 复用原装配实例；工具、权限与工作流入口保持原执行顺序。
export function createAppHookSurface(
  input: AppReturnSurfaceInput,
): Pick<
  ZCodeApp,
  | "respondWorkspaceHookReview"
  | "toggleWorkspaceHookReviewItem"
  | "revokeWorkspaceHookTrust"
  | "requestWorkspaceHookReview"
  | "reloadWorkspaceHookTrust"
> {
  const { workspaceHookRuntimeSecurity } = input;
  return {
    respondWorkspaceHookReview: (input) =>
      workspaceHookRuntimeSecurity?.respond(
        {
          sessionId: input.sessionId,
          taskId: input.taskId,
          runId: input.runId,
          ...(input.remoteSessionId ? { remoteSessionId: input.remoteSessionId } : {}),
          workspaceIdentity: input.workspaceIdentity,
          bundleDigest: input.bundleDigest,
          reviewFlowId: input.reviewFlowId,
          generation: input.generation,
          interactionId: input.interactionId,
        },
        input.decision,
      ) ??
      Promise.resolve({
        accepted: false as const,
        reasonCode: "workspace_hooks_require_trust_capable_host" as const,
      }),

    toggleWorkspaceHookReviewItem: (input) =>
      workspaceHookRuntimeSecurity?.toggle(
        {
          sessionId: input.sessionId,
          taskId: input.taskId,
          runId: input.runId,
          ...(input.remoteSessionId ? { remoteSessionId: input.remoteSessionId } : {}),
          workspaceIdentity: input.workspaceIdentity,
          bundleDigest: input.bundleDigest,
          reviewFlowId: input.reviewFlowId,
          generation: input.generation,
          interactionId: input.interactionId,
        },
        input.reviewItemId,
        input.enabled,
      ) ??
      Promise.resolve({
        accepted: false as const,
        reasonCode: "workspace_hooks_require_trust_capable_host" as const,
      }),

    revokeWorkspaceHookTrust: (input) =>
      ("hookDeclarationDigests" in input
        ? workspaceHookRuntimeSecurity?.revokeCurrent(input)
        : workspaceHookRuntimeSecurity?.revoke(
            {
              sessionId: input.sessionId,
              taskId: input.taskId,
              runId: input.runId,
              ...(input.remoteSessionId ? { remoteSessionId: input.remoteSessionId } : {}),
              workspaceIdentity: input.workspaceIdentity,
              bundleDigest: input.bundleDigest,
              reviewFlowId: input.reviewFlowId,
              generation: input.generation,
              interactionId: input.interactionId,
            },
            input.reviewItemIds,
          )) ??
      Promise.resolve({
        accepted: false as const,
        reasonCode: "workspace_hooks_require_trust_capable_host" as const,
      }),

    requestWorkspaceHookReview: (input) =>
      workspaceHookRuntimeSecurity?.requestReview({
        workspaceIdentity: input.workspaceIdentity,
        bundleDigest: input.bundleDigest,
      }) ??
      Promise.resolve({
        accepted: false as const,
        reasonCode: "workspace_hooks_require_trust_capable_host" as const,
      }),

    // Settings pretrust 写盘后由 server 按 workspace 调用：重载 Trust store 到本
    // session 的 coordinator 并重发 admission 状态（详见 types.ts 注释）。
    reloadWorkspaceHookTrust: () =>
      workspaceHookRuntimeSecurity?.reloadTrust() ?? Promise.resolve(),
  };
}
