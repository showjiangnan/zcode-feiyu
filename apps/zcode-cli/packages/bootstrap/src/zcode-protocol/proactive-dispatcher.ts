// Modified by ZCode Feiyu contributors (2026).
import { randomUUID } from "node:crypto";
import { resolvePath } from "@zcode/adapters/config";
import { NodeSessionMailboxAdapter } from "@zcode/adapters/mailbox";
import type { SessionId } from "@zcode/contracts";
import {
  isRemoteWorkspaceIdentity,
  taskAppResponseSchema,
  zcodeProtocolMethods,
  type ZCodeWorkspaceRef,
} from "@zcode/shared";
import type { ZCodeProtocolAgentServerContext } from "./server-types.js";

interface Dispatcher {
  wake(): Promise<void>;
  stop(): void;
}
const dispatchers = new WeakMap<ZCodeProtocolAgentServerContext, Map<string, Dispatcher>>();
const DISPATCH_INTERVAL_MS = 5_000;

/** 单次扫描只从原事件/输入事实派发；可直接等待这一执行边界，不用 sleep 推测完成。 */
export async function dispatchProactiveEvents(
  context: ZCodeProtocolAgentServerContext,
  workspace: ZCodeWorkspaceRef,
  ownerId: string,
  signal?: AbortSignal,
): Promise<void> {
  const allowed = () =>
    !signal?.aborted &&
    context.appRuntimePreferences.memory?.continuityPolicy?.proactiveWorkAllowed === true;
  if (
    isRemoteWorkspaceIdentity(workspace.workspaceIdentity?.trim() || workspace.workspaceKey) ||
    workspace.remoteSessionId ||
    !allowed()
  )
    return;
  const store = context.deps.sessionStore;
  const activeSessionIds = [...context.sessions]
    .filter(([, record]) => record.workspace.workspaceKey === workspace.workspaceKey)
    .map(([id]) => id);
  await store?.resumeRetiredProactiveWorkspace?.(
    workspace.workspaceKey,
    Date.now(),
    activeSessionIds,
  );
  if (!allowed()) return;
  const mailbox = new NodeSessionMailboxAdapter({
    rootDir: resolvePath(
      (context.deps.env ?? process.env).ZCODE_MAILBOX_ROOT ?? "~/.zcode/mailbox",
    ),
  });
  for (const sessionId of (await store?.listProactiveMailboxTargets?.(workspace.workspaceKey)) ??
    []) {
    for (const message of await mailbox.peekUnread(sessionId as SessionId)) {
      if (!allowed()) return;
      // 缺失可信输入锚点的旧 Mailbox 仍可读取，但不得猜测为 depth=0 自动唤醒。
      if (!message.sourceCommandId) continue;
      const depth = await store?.proactiveDepthForSource?.(
        message.fromSessionId,
        message.sourceCommandId,
      );
      if (depth === undefined || depth === null) continue;
      await store?.publishProactiveEvent?.({
        eventId: `mailbox:${sessionId}:${message.messageId}`,
        workspaceKey: workspace.workspaceKey,
        sourceSessionId: message.fromSessionId,
        sourceId: message.fromSessionId,
        targetSessionId: sessionId,
        kind: "mailbox_message",
        depth,
        now: Date.now(),
      });
    }
  }
  while (allowed()) {
    const triggers =
      (await store?.claimProactiveTriggers?.(workspace.workspaceKey, ownerId, Date.now())) ?? [];
    if (!triggers.length) return;
    for (const trigger of triggers) {
      let status: "delivered" | "rejected" | "pending" = "pending";
      let reason: string | undefined;
      const current = await store?.readProactiveTrigger?.(trigger.commandId);
      if (!current || current.state === "rejected" || current.generation !== trigger.generation)
        continue;
      if (allowed()) {
        try {
          // retryCommandId 在 Host 端查询原命令；恢复不会绕过 owner/lease 或另开输入。
          const result = await context.requestClient(
            zcodeProtocolMethods.interactionTaskService,
            {
              sourceSessionId: trigger.sourceSessionId,
              requestId: trigger.commandId,
              operation: {
                type: "send",
                taskId: trigger.targetSessionId,
                message: trigger.prompt,
                delivery: "queue",
                retryCommandId: trigger.commandId,
              },
            },
            taskAppResponseSchema,
            { timeoutMs: 45_000 },
          );
          status = result.ok ? "delivered" : result.error.retryable ? "pending" : "rejected";
          reason = result.ok ? undefined : result.error.message;
        } catch (error) {
          reason = error instanceof Error ? error.message : String(error);
        }
      }
      await store?.settleProactiveTrigger?.({
        triggerId: trigger.triggerId,
        ownerId,
        status,
        error: reason,
        now: Date.now(),
      });
    }
  }
}

export function startProactiveDispatcher(
  context: ZCodeProtocolAgentServerContext,
  workspace: ZCodeWorkspaceRef,
): Dispatcher | undefined {
  if (
    isRemoteWorkspaceIdentity(workspace.workspaceIdentity?.trim() || workspace.workspaceKey) ||
    workspace.remoteSessionId
  )
    return;
  let registry = dispatchers.get(context);
  if (!registry) {
    registry = new Map();
    dispatchers.set(context, registry);
  }
  const existing = registry.get(workspace.workspaceKey);
  if (existing) {
    void existing.wake();
    return existing;
  }
  const ownerId = `proactive-dispatch:${process.pid}:${randomUUID()}`;
  const controller = new AbortController();
  let running: Promise<void> | undefined;
  let requested = false;
  const wake = (): Promise<void> => {
    if (controller.signal.aborted) return Promise.resolve();
    requested = true;
    if (running) return running;
    running = Promise.resolve()
      .then(async () => {
        // wake 与在途 I/O 交错时保留一次后续扫描，不靠五秒轮询遮掩丢唤醒。
        while (requested && !controller.signal.aborted) {
          requested = false;
          try {
            await dispatchProactiveEvents(context, workspace, ownerId, controller.signal);
          } catch (error) {
            if (!controller.signal.aborted)
              context.logger?.warn("Proactive event dispatch failed", {
                error: error instanceof Error ? error.message : String(error),
              });
          }
        }
      })
      .finally(() => {
        running = undefined;
      });
    return running;
  };
  const timer = setInterval(() => {
    void wake();
  }, DISPATCH_INTERVAL_MS);
  timer.unref?.();
  const dispatcher = {
    wake,
    stop: () => {
      controller.abort();
      clearInterval(timer);
    },
  };
  registry.set(workspace.workspaceKey, dispatcher);
  void wake();
  return dispatcher;
}

export function stopProactiveDispatchers(context: ZCodeProtocolAgentServerContext): void {
  for (const dispatcher of dispatchers.get(context)?.values() ?? []) dispatcher.stop();
  dispatchers.delete(context);
}
