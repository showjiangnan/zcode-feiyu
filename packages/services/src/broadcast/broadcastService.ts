// Modified by ZCode Feiyu contributors (2026).
import { Emitter } from "@zcode/rpc";
import {
  HostResponseTypes,
  HostMessageTypes,
  broadcastMessageSchema,
  hostBroadcastClaimResultMessageSchema,
  hostBroadcastDeliveryFinalMessageSchema,
  hostBroadcastDeliveryMessageSchema,
  hostBroadcastEnvelopeSchema,
  runtimePolicyAcknowledgementSchema,
  type RuntimePolicyAcknowledgement,
  type BroadcastDeliverySummary,
} from "@zcode/shared";
import type {
  BroadcastClaimAcquireResult,
  BroadcastClaimLease,
  IBroadcastService,
  BroadcastMessage,
} from "./broadcast.js";

const BROADCAST_CLAIM_TIMEOUT_MS = 2_000;
const BROADCAST_CLAIM_RESERVATION_TTL_MS = 5_000;
const BROADCAST_CLAIM_RETRY_MS = 250;
const MAX_LOCAL_CLAIMS = 1_024;
// Host ACK 与随后 Main 原生停止各有 30 秒屏障；源端不能在 Main 仍收口时先超时。
const BROADCAST_DELIVERY_TIMEOUT_MS = 65_000;
let claimRequestSequence = 0;

type LocalClaimRecord = {
  token: string;
  status: "reserved" | "committed";
  expiresAt: number | null;
};

function pruneLocalClaims(claims: Map<string, LocalClaimRecord>, now = Date.now()): void {
  for (const [key, claim] of claims) {
    if (claim.status === "reserved" && claim.expiresAt !== null && claim.expiresAt <= now) {
      claims.delete(key);
    }
  }
  while (claims.size > MAX_LOCAL_CLAIMS) {
    const oldest = claims.keys().next().value as string | undefined;
    if (!oldest) {
      break;
    }
    claims.delete(oldest);
  }
}

function createClaimRequestId(): string {
  const randomId = globalThis.crypto?.randomUUID?.();
  if (randomId) {
    return randomId;
  }
  claimRequestSequence += 1;
  return `broadcast-claim-${Date.now()}-${claimRequestSequence}`;
}

function createLocalClaimToken(): string {
  return `local-${createClaimRequestId()}`;
}

/**
 * 广播服务 Node 实现 —— 运行在 host process 中
 *
 * send() 时：
 *   1. 触发本地 emitter（本窗口的 Renderer 通过 RPC event 收到）
 *   2. 通过 parentPort 发给 main 进程（由 BroadcastHub 中转给其他窗口）
 *
 * 收到 main 转发的广播时：
 *   触发本地 emitter → Renderer 通过 RPC event 收到
 *
 * @param parentPort - Electron host process 的 parentPort（Electron.ParentPort）
 *                     传 null 表示无跨窗口能力（如 web server 模式）
 */
export function createBroadcastService(
  parentPort: {
    postMessage(message: unknown): void;
    on(event: "message", listener: (e: { data: unknown }) => void): void;
  } | null,
): IBroadcastService & {
  registerAcknowledgedHandler(
    channel: string,
    handler: (message: BroadcastMessage) => Promise<RuntimePolicyAcknowledgement | void>,
  ): void;
} {
  const emitter = new Emitter<BroadcastMessage>();
  const acknowledgedHandlers = new Map<
    string,
    (message: BroadcastMessage) => Promise<RuntimePolicyAcknowledgement | void>
  >();
  const pendingDeliveries = new Map<
    string,
    {
      resolve: (result: BroadcastDeliverySummary) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  const localClaims = new Map<string, LocalClaimRecord>();
  const pendingClaims = new Map<
    string,
    {
      key: string;
      resolve: (result: BroadcastClaimAcquireResult) => void;
      timeout: ReturnType<typeof setTimeout>;
      timedOut: boolean;
      cleanupTimeout: ReturnType<typeof setTimeout> | null;
    }
  >();

  const postClaimControl = (
    type:
      | typeof HostResponseTypes.BroadcastClaimCommit
      | typeof HostResponseTypes.BroadcastClaimRelease,
    lease: BroadcastClaimLease,
  ): void => {
    if (!parentPort) {
      return;
    }
    try {
      parentPort.postMessage({ type, key: lease.key, claimToken: lease.token });
    } catch {
      // host 正在退出时允许失败；Main 会在 unregister 时回收未 commit reservation。
    }
  };

  // 监听 main 进程转发的广播和跨窗口 claim 结果。
  if (parentPort) {
    parentPort.on("message", (e: { data: unknown }) => {
      const broadcastResult = hostBroadcastEnvelopeSchema.safeParse(e.data);
      if (broadcastResult.success && broadcastResult.data.type === HostMessageTypes.Broadcast) {
        emitter.fire(broadcastResult.data.message);
        const handler = acknowledgedHandlers.get(broadcastResult.data.message.channel);
        if (handler) {
          // 旧式广播没有 Main 回执；消费仍由 Host 持有，Renderer 是否挂载不影响生效。
          void handler(broadcastResult.data.message).catch(() => {});
        }
        return;
      }

      const delivery = hostBroadcastDeliveryMessageSchema.safeParse(e.data);
      if (delivery.success && delivery.data.type === HostMessageTypes.BroadcastDelivery) {
        const { message, requestId, sourceWindowId } = delivery.data;
        emitter.fire(message);
        const handler = acknowledgedHandlers.get(message.channel);
        void (handler ? handler(message) : Promise.reject(new Error("No delivery handler")))
          .then(
            (acknowledgement) =>
              parentPort.postMessage({
                type: HostResponseTypes.BroadcastDeliveryResult,
                requestId,
                sourceWindowId,
                ok: !acknowledgement || acknowledgement.status === "applied",
                ...(acknowledgement
                  ? { acknowledgement: runtimePolicyAcknowledgementSchema.parse(acknowledgement) }
                  : {}),
              }),
            (error: unknown) =>
              parentPort.postMessage({
                type: HostResponseTypes.BroadcastDeliveryResult,
                requestId,
                sourceWindowId,
                ok: false,
                acknowledgement: {
                  status: "failed",
                  error: error instanceof Error ? error.message : String(error),
                },
              }),
          )
          .catch(() => {
            // 进程关闭时 Main 的有界等待会把未回执目标计为失败。
          });
        return;
      }

      const deliveryFinal = hostBroadcastDeliveryFinalMessageSchema.safeParse(e.data);
      if (
        deliveryFinal.success &&
        deliveryFinal.data.type === HostMessageTypes.BroadcastDeliveryFinal
      ) {
        const pending = pendingDeliveries.get(deliveryFinal.data.requestId);
        if (!pending) return;
        pendingDeliveries.delete(deliveryFinal.data.requestId);
        clearTimeout(pending.timeout);
        pending.resolve({
          targetCount: deliveryFinal.data.targetCount,
          failedCount: deliveryFinal.data.failedCount,
          ...(deliveryFinal.data.receipts ? { receipts: deliveryFinal.data.receipts } : {}),
        });
        return;
      }

      const claimResult = hostBroadcastClaimResultMessageSchema.safeParse(e.data);
      if (!claimResult.success) {
        return;
      }
      const pending = pendingClaims.get(claimResult.data.requestId);
      if (!pending) {
        return;
      }
      pendingClaims.delete(claimResult.data.requestId);
      clearTimeout(pending.timeout);
      if (pending.cleanupTimeout) {
        clearTimeout(pending.cleanupTimeout);
      }
      // 请求已超时但 Main 稍后授予 reservation 时，必须用原 key/token 主动释放；
      // 否则已经没有组件持有该 lease，只能等 TTL 才能让其他窗口继续争抢。
      if (pending.timedOut) {
        if (claimResult.data.status === "acquired") {
          postClaimControl(HostResponseTypes.BroadcastClaimRelease, {
            key: pending.key,
            token: claimResult.data.claimToken,
          });
        }
        return;
      }
      if (claimResult.data.status === "acquired") {
        pending.resolve({
          status: "acquired",
          lease: { key: pending.key, token: claimResult.data.claimToken },
        });
        return;
      }
      if (claimResult.data.status === "busy") {
        pending.resolve({ status: "busy", retryAfterMs: claimResult.data.retryAfterMs });
        return;
      }
      pending.resolve({ status: "committed" });
    });
  }

  const acquireClaim = async (key: string): Promise<BroadcastClaimAcquireResult> => {
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      return { status: "unavailable" };
    }
    if (!parentPort) {
      const now = Date.now();
      pruneLocalClaims(localClaims, now);
      const existing = localClaims.get(normalizedKey);
      if (existing?.status === "committed") {
        return { status: "committed" };
      }
      if (existing) {
        return {
          status: "busy",
          retryAfterMs: Math.max(
            0,
            Math.min(BROADCAST_CLAIM_RETRY_MS, (existing.expiresAt ?? now) - now),
          ),
        };
      }
      const lease = { key: normalizedKey, token: createLocalClaimToken() };
      localClaims.set(normalizedKey, {
        token: lease.token,
        status: "reserved",
        expiresAt: now + BROADCAST_CLAIM_RESERVATION_TTL_MS,
      });
      pruneLocalClaims(localClaims, now);
      return { status: "acquired", lease };
    }

    const requestId = createClaimRequestId();
    return new Promise<BroadcastClaimAcquireResult>((resolve) => {
      // claim 超时不能乐观播放；Main 可能已经把同一 key 授予另一窗口。
      // 迟到的 acquired 结果会在消息处理器中按 token 主动 release。
      const timeout = setTimeout(() => {
        const pending = pendingClaims.get(requestId);
        if (pending) {
          pending.timedOut = true;
          pending.cleanupTimeout = setTimeout(() => {
            pendingClaims.delete(requestId);
          }, BROADCAST_CLAIM_RESERVATION_TTL_MS + BROADCAST_CLAIM_TIMEOUT_MS);
        }
        resolve({ status: "unavailable" });
      }, BROADCAST_CLAIM_TIMEOUT_MS);
      pendingClaims.set(requestId, {
        key: normalizedKey,
        resolve,
        timeout,
        timedOut: false,
        cleanupTimeout: null,
      });
      try {
        parentPort.postMessage({
          type: HostResponseTypes.BroadcastClaimRequest,
          requestId,
          key: normalizedKey,
        });
      } catch {
        clearTimeout(timeout);
        pendingClaims.delete(requestId);
        resolve({ status: "unavailable" });
      }
    });
  };

  const commitClaim = async (lease: BroadcastClaimLease): Promise<void> => {
    if (parentPort) {
      postClaimControl(HostResponseTypes.BroadcastClaimCommit, lease);
      return;
    }
    pruneLocalClaims(localClaims);
    const current = localClaims.get(lease.key);
    if (current?.status === "reserved" && current.token === lease.token) {
      localClaims.set(lease.key, { ...current, status: "committed", expiresAt: null });
    }
  };

  const releaseClaim = async (lease: BroadcastClaimLease): Promise<void> => {
    if (parentPort) {
      postClaimControl(HostResponseTypes.BroadcastClaimRelease, lease);
      return;
    }
    pruneLocalClaims(localClaims);
    const current = localClaims.get(lease.key);
    if (current?.status === "reserved" && current.token === lease.token) {
      localClaims.delete(lease.key);
    }
  };

  return {
    registerAcknowledgedHandler(channel, handler) {
      acknowledgedHandlers.set(channel, handler);
    },
    async sendWithAcknowledgements(message) {
      const validatedMessage = broadcastMessageSchema.parse(message);
      emitter.fire(validatedMessage);
      if (!parentPort) return { targetCount: 0, failedCount: 0 };
      const requestId = createClaimRequestId();
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pendingDeliveries.delete(requestId);
          reject(new Error("Broadcast delivery acknowledgement timed out"));
        }, BROADCAST_DELIVERY_TIMEOUT_MS);
        pendingDeliveries.set(requestId, { resolve, reject, timeout });
        try {
          parentPort.postMessage({
            type: HostResponseTypes.BroadcastDeliveryRequest,
            requestId,
            message: validatedMessage,
          });
        } catch (error) {
          clearTimeout(timeout);
          pendingDeliveries.delete(requestId);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    async send(message: BroadcastMessage): Promise<void> {
      const validatedMessage = broadcastMessageSchema.parse(message);
      // 1. 通知本窗口的 Renderer
      emitter.fire(validatedMessage);
      // 2. 发给 main 进程做跨窗口中转
      if (parentPort) {
        parentPort.postMessage({ type: HostResponseTypes.Broadcast, message: validatedMessage });
      }
    },
    acquireClaim,
    commitClaim,
    releaseClaim,
    async tryClaim(key: string): Promise<boolean> {
      const result = await acquireClaim(key);
      if (result.status !== "acquired") {
        return false;
      }
      await commitClaim(result.lease);
      return true;
    },
    onMessage: emitter.event,
  };
}
