// Modified by ZCode Feiyu contributors (2026).
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { SessionStorePort } from "@zcode/contracts";

const LEASE_MS = 60_000;
const RENEW_MS = 10_000;
const ACQUIRE_WAIT_MS = 10_000;
const RETRY_MS = 200;

export async function withProjectMemoryWriteLease<T>(input: {
  sessionStore: SessionStorePort | undefined;
  workspaceKey: string;
  signal?: AbortSignal;
  operation: (
    signal: AbortSignal,
    guard: <R>(commit: () => Promise<R>) => Promise<R>,
  ) => Promise<T>;
}): Promise<T> {
  const store = input.sessionStore;
  if (
    !store?.claimProjectMemoryWrite ||
    !store.renewProjectMemoryWrite ||
    !store.releaseProjectMemoryWrite
  ) {
    throw new Error("Project memory write lease is unavailable");
  }
  const ownerId = `memory-write-${randomUUID()}`;
  const deadline = Date.now() + ACQUIRE_WAIT_MS;
  let epoch: number;
  while (true) {
    input.signal?.throwIfAborted();
    const claim = await store.claimProjectMemoryWrite({
      workspaceKey: input.workspaceKey,
      ownerId,
      now: Date.now(),
      leaseDurationMs: LEASE_MS,
    });
    if (claim.status === "claimed") {
      epoch = claim.epoch;
      break;
    }
    if (Date.now() >= deadline) throw new Error("Project memory write lease is busy");
    await delay(RETRY_MS, undefined, { signal: input.signal });
  }

  const controller = new AbortController();
  const signal = input.signal
    ? AbortSignal.any([input.signal, controller.signal])
    : controller.signal;
  let renewing = false;
  const heartbeat = setInterval(() => {
    if (renewing || controller.signal.aborted) return;
    renewing = true;
    void store.renewProjectMemoryWrite!({
      workspaceKey: input.workspaceKey,
      ownerId,
      epoch,
      now: Date.now(),
      leaseDurationMs: LEASE_MS,
    })
      .then((renewed) => {
        if (!renewed) controller.abort();
      })
      .catch(() => {
        controller.abort();
      })
      .finally(() => {
        renewing = false;
      });
  }, RENEW_MS);
  heartbeat.unref?.();
  let committed = false;
  try {
    signal.throwIfAborted();
    const result = await input.operation(signal, async (commit) => {
      if (!store.withProjectMemoryWriteFence)
        throw new Error("Project memory commit fence is unavailable");
      return store.withProjectMemoryWriteFence(
        { workspaceKey: input.workspaceKey, ownerId, epoch },
        async () => {
          signal.throwIfAborted();
          const value = await commit();
          committed = true;
          return value;
        },
      );
    });
    // 原子提交已胜出后，迟到取消或租约到期不能把成功写入伪报为未发生。
    if (committed) return result;
    signal.throwIfAborted();
    const renewed = await store.renewProjectMemoryWrite({
      workspaceKey: input.workspaceKey,
      ownerId,
      epoch,
      now: Date.now(),
      leaseDurationMs: LEASE_MS,
    });
    if (!renewed) throw new Error("Project memory write lease was lost");
    return result;
  } finally {
    clearInterval(heartbeat);
    controller.abort();
    await store.releaseProjectMemoryWrite({ workspaceKey: input.workspaceKey, ownerId, epoch });
  }
}
