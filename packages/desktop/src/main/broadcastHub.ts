// Modified by ZCode Feiyu contributors (2026).
import type { UtilityProcess as ElectronUtilityProcess } from "electron";
import {
  HostMessageTypes,
  HostResponseTypes,
  broadcastMessageSchema,
  formatZodError,
  hostResponseMessageSchema,
  APP_RUNTIME_PREFERENCES_CHANGED_BROADCAST_CHANNEL,
  appRuntimePreferencesChangedBroadcastPayloadSchema,
  type RuntimePolicyAcknowledgement,
  type BroadcastDeliveryReceipt,
} from "@zcode/shared";
import type { BroadcastMessage } from "@zcode/services";
import { logger } from "./logger.js";

/**
 * BroadcastHub —— main 进程中的广播中转站
 *
 * 管理所有活跃的 host process，当某个 host 发来广播消息时，
 * 转发给所有其他 host process。
 *
 * 广播路径：
 *   Renderer A → (RPC) → Host A → (parentPort) → Main(BroadcastHub)
 *     → (postMessage) → Host B → (RPC event) → Renderer B
 *     → (postMessage) → Host C → (RPC event) → Renderer C
 */
const MAX_BROADCAST_CLAIMS = 1_024;
const BROADCAST_CLAIM_RESERVATION_TTL_MS = 5_000;
const BROADCAST_CLAIM_RETRY_MS = 250;
const BROADCAST_DELIVERY_TIMEOUT_MS = 30_000;
let claimTokenSequence = 0;

type BroadcastClaimRecord = {
  token: string;
  ownerWindowId: number;
  status: "reserved" | "committed";
  expiresAt: number | null;
};

type PendingDelivery = {
  sourceWindowId: number;
  source: ElectronUtilityProcess;
  requestId: string;
  targetCount: number;
  remaining: Set<number>;
  requestedPolicyRevision?: number;
  receipts: Map<number, BroadcastDeliveryReceipt>;
  timeout: ReturnType<typeof setTimeout>;
  applyMain?: () => void;
};

function createClaimToken(windowId: number, requestId: string): string {
  claimTokenSequence += 1;
  return `${windowId}:${requestId}:${claimTokenSequence}`;
}

export class BroadcastHub {
  constructor(
    private readonly applyToMain?: (
      message: BroadcastMessage,
      sourceWindowId: number,
    ) => Promise<RuntimePolicyAcknowledgement | void>,
    private readonly deliveryTimeoutMs = BROADCAST_DELIVERY_TIMEOUT_MS,
  ) {}
  private processes = new Map<number, ElectronUtilityProcess>();
  /** 通用 opaque reservation/claim；不保存 Coding Plan 等业务状态。 */
  private readonly claims = new Map<string, BroadcastClaimRecord>();
  /** 仅保留一次进程转发的回执屏障，不保存设置等业务状态。 */
  private readonly pendingDeliveries = new Map<string, PendingDelivery>();

  /** 内存诊断计数器；只读 size。 */
  collectMemoryDiagnostics(): Record<string, number> {
    return { claims: this.claims.size, processes: this.processes.size };
  }

  /** 注册 host process 并监听其广播消息 */
  register(windowId: number, child: ElectronUtilityProcess): void {
    // 同窗口换代不能让旧进程的回执证明新进程已应用。
    if (this.processes.has(windowId)) this.unregister(windowId);
    this.processes.set(windowId, child);

    child.on("message", (msg: unknown) => {
      const result = hostResponseMessageSchema.safeParse(msg);
      if (!result.success) {
        logger.warn("[BroadcastHub] invalid host response message:", formatZodError(result.error));
        return;
      }
      if (this.processes.get(windowId) !== child) return;
      if (result.data.type === HostResponseTypes.Broadcast) {
        this.relay(windowId, result.data.message);
        return;
      }
      if (result.data.type === HostResponseTypes.BroadcastDeliveryRequest) {
        this.relayWithAcknowledgements(windowId, child, result.data.requestId, result.data.message);
        return;
      }
      if (result.data.type === HostResponseTypes.BroadcastDeliveryResult) {
        if (this.processes.get(windowId) !== child) return;
        this.settleDelivery(
          windowId,
          result.data.sourceWindowId,
          result.data.requestId,
          result.data.ok,
          result.data.acknowledgement,
        );
        return;
      }
      if (result.data.type === HostResponseTypes.BroadcastClaimRequest) {
        this.handleClaim(windowId, child, result.data.requestId, result.data.key);
        return;
      }
      if (result.data.type === HostResponseTypes.BroadcastClaimCommit) {
        this.handleClaimCommit(windowId, result.data.key, result.data.claimToken);
        return;
      }
      if (result.data.type === HostResponseTypes.BroadcastClaimRelease) {
        this.handleClaimRelease(windowId, result.data.key, result.data.claimToken);
      }
    });
  }

  /** 注销 host process（窗口关闭时调用） */
  unregister(windowId: number, child?: ElectronUtilityProcess): void {
    if (child && this.processes.get(windowId) !== child) return;
    this.processes.delete(windowId);
    for (const [key, pending] of this.pendingDeliveries) {
      if (pending.sourceWindowId === windowId) {
        // 修复原因：提交源退出时直接删除待确认投递，会让 Main 的原生动作（例如撤销后台许可后
        // 停止其余隐藏 Host）永远不会执行（复审 DEF-10）。
        // 依据：原生动作只取决于其余目标的收口，与源是否仍在无关。因此保留投递与计时器继续收集回执，
        // finishDelivery 发现源已离开时只是不再回投。
        continue;
      }
      if (pending.remaining.delete(windowId)) {
        pending.receipts.set(windowId, {
          windowId,
          status: "unconfirmed",
          error: "Host exited before acknowledgement",
        });
        this.advanceDelivery(key, pending);
      }
    }
    // 窗口在 reservation 返回前关闭时无法主动 release；只回收该窗口未 commit
    // 的占用，已 commit claim 继续保留，避免后来打开的窗口重播同一次完成提示。
    for (const [key, claim] of this.claims) {
      if (claim.ownerWindowId === windowId && claim.status === "reserved") {
        this.claims.delete(key);
      }
    }
  }

  private pruneExpiredReservations(now = Date.now()): void {
    for (const [key, claim] of this.claims) {
      if (claim.status === "reserved" && claim.expiresAt !== null && claim.expiresAt <= now) {
        this.claims.delete(key);
      }
    }
    while (this.claims.size > MAX_BROADCAST_CLAIMS) {
      const oldest = this.claims.keys().next().value as string | undefined;
      if (!oldest) {
        break;
      }
      this.claims.delete(oldest);
    }
  }

  /**
   * 原子申请 opaque key 的临时 reservation。Main 单线程保证 first-wins；reservation
   * 必须由 winner 在展示边界 commit，否则可按 token release，并受 TTL/host 注销兜底回收。
   */
  private handleClaim(
    windowId: number,
    source: ElectronUtilityProcess,
    requestId: string,
    key: string,
  ): void {
    const now = Date.now();
    this.pruneExpiredReservations(now);
    const existing = this.claims.get(key);
    if (existing?.status === "committed") {
      source.postMessage({
        type: HostMessageTypes.BroadcastClaimResult,
        requestId,
        status: "committed",
      });
      return;
    }
    if (existing) {
      source.postMessage({
        type: HostMessageTypes.BroadcastClaimResult,
        requestId,
        status: "busy",
        retryAfterMs: Math.max(
          0,
          Math.min(BROADCAST_CLAIM_RETRY_MS, (existing.expiresAt ?? now) - now),
        ),
      });
      return;
    }

    const claimToken = createClaimToken(windowId, requestId);
    this.claims.set(key, {
      token: claimToken,
      ownerWindowId: windowId,
      status: "reserved",
      expiresAt: now + BROADCAST_CLAIM_RESERVATION_TTL_MS,
    });
    this.pruneExpiredReservations(now);
    source.postMessage({
      type: HostMessageTypes.BroadcastClaimResult,
      requestId,
      status: "acquired",
      claimToken,
    });
  }

  private handleClaimCommit(windowId: number, key: string, claimToken: string): void {
    this.pruneExpiredReservations();
    const current = this.claims.get(key);
    if (
      current?.status === "reserved" &&
      current.ownerWindowId === windowId &&
      current.token === claimToken
    ) {
      this.claims.set(key, { ...current, status: "committed", expiresAt: null });
    }
  }

  private handleClaimRelease(windowId: number, key: string, claimToken: string): void {
    this.pruneExpiredReservations();
    const current = this.claims.get(key);
    if (
      current?.status === "reserved" &&
      current.ownerWindowId === windowId &&
      current.token === claimToken
    ) {
      this.claims.delete(key);
    }
  }

  /** 将广播消息转发给除发送源以外的所有 host process */
  private relay(sourceWindowId: number, message: BroadcastMessage): void {
    const result = broadcastMessageSchema.safeParse(message);
    if (!result.success) {
      logger.warn("[BroadcastHub] invalid broadcast message:", formatZodError(result.error));
      return;
    }

    // 填充来源信息，接收端可用于去重
    const enriched: BroadcastMessage = { ...result.data, sourceWindowId };

    for (const [id, proc] of this.processes) {
      if (id !== sourceWindowId) {
        proc.postMessage({ type: HostMessageTypes.Broadcast, message: enriched });
      }
    }
  }

  private relayWithAcknowledgements(
    sourceWindowId: number,
    source: ElectronUtilityProcess,
    requestId: string,
    message: BroadcastMessage,
  ): void {
    if (this.processes.get(sourceWindowId) !== source) return;
    const result = broadcastMessageSchema.safeParse(message);
    if (!result.success) return;
    const key = `${sourceWindowId}:${requestId}`;
    if (this.pendingDeliveries.has(key)) return;
    const targets = [...this.processes].filter(([id]) => id !== sourceWindowId);
    const pending: PendingDelivery = {
      sourceWindowId,
      source,
      requestId,
      targetCount: targets.length + (this.applyToMain ? 1 : 0),
      remaining: new Set([...targets.map(([id]) => id), ...(this.applyToMain ? [-1] : [])]),
      requestedPolicyRevision:
        result.data.channel === APP_RUNTIME_PREFERENCES_CHANGED_BROADCAST_CHANNEL
          ? appRuntimePreferencesChangedBroadcastPayloadSchema.parse(result.data.payload)
              .policyRevision
          : undefined,
      receipts: new Map(),
      timeout: setTimeout(() => {
        // 某个 Host 超时也不能跳过 Main 原生关闭；先把未确认 Host 结算，再执行原生屏障。
        for (const id of pending.remaining) {
          if (id === -1 && pending.applyMain) continue;
          pending.remaining.delete(id);
          pending.receipts.set(id, {
            windowId: id,
            status: "unconfirmed",
            error: "Acknowledgement timed out",
          });
        }
        this.advanceDelivery(key, pending);
      }, this.deliveryTimeoutMs),
    };
    if (this.applyToMain)
      pending.applyMain = () => {
        clearTimeout(pending.timeout);
        pending.timeout = setTimeout(() => {
          this.settleDelivery(-1, sourceWindowId, requestId, false, {
            status: "unconfirmed",
            error: "Main acknowledgement timed out",
          });
        }, this.deliveryTimeoutMs);
        pending.timeout.unref?.();
        void this.applyToMain!(result.data, sourceWindowId).then(
          (acknowledgement) =>
            this.settleDelivery(
              -1,
              sourceWindowId,
              requestId,
              !acknowledgement || acknowledgement.status === "applied",
              acknowledgement || undefined,
            ),
          (error: unknown) =>
            this.settleDelivery(-1, sourceWindowId, requestId, false, {
              status: "failed",
              error: error instanceof Error ? error.message : String(error),
            }),
        );
      };
    pending.timeout.unref?.();
    this.pendingDeliveries.set(key, pending);
    for (const [id, proc] of targets) {
      try {
        proc.postMessage({
          type: HostMessageTypes.BroadcastDelivery,
          requestId,
          sourceWindowId,
          message: { ...result.data, sourceWindowId },
        });
      } catch {
        // 已注册但无法投递的目标仍属于本轮快照；向发送方报告部分失败。
        pending.remaining.delete(id);
        pending.receipts.set(id, {
          windowId: id,
          status: "unconfirmed",
          error: "Host delivery failed",
        });
      }
    }
    this.advanceDelivery(key, pending);
  }

  private settleDelivery(
    targetWindowId: number,
    sourceWindowId: number,
    requestId: string,
    ok: boolean,
    acknowledgement?: RuntimePolicyAcknowledgement,
  ): void {
    const key = `${sourceWindowId}:${requestId}`;
    const pending = this.pendingDeliveries.get(key);
    if (!pending?.remaining.delete(targetWindowId)) return;
    let receipt: RuntimePolicyAcknowledgement = acknowledgement ?? {
      status: ok ? "applied" : "failed",
    };
    if (
      pending.requestedPolicyRevision !== undefined &&
      receipt.status === "applied" &&
      receipt.policyRevision !== pending.requestedPolicyRevision
    ) {
      receipt = {
        ...receipt,
        status: "unconfirmed",
        error: "Actual policy revision does not confirm the requested policy",
      };
    } else if (!ok && receipt.status === "applied") {
      receipt = { ...receipt, status: "failed" };
    }
    pending.receipts.set(targetWindowId, { ...receipt, windowId: targetWindowId });
    this.advanceDelivery(key, pending);
  }

  private advanceDelivery(key: string, pending: PendingDelivery): void {
    if (pending.remaining.size === 0) this.finishDelivery(key, pending);
    else if (pending.remaining.size === 1 && pending.remaining.has(-1) && pending.applyMain) {
      const apply = pending.applyMain;
      pending.applyMain = undefined;
      apply();
    }
  }

  private finishDelivery(key: string, pending: PendingDelivery): void {
    if (this.pendingDeliveries.get(key) !== pending) return;
    this.pendingDeliveries.delete(key);
    clearTimeout(pending.timeout);
    if (this.processes.get(pending.sourceWindowId) !== pending.source) return;
    try {
      pending.source.postMessage({
        type: HostMessageTypes.BroadcastDeliveryFinal,
        requestId: pending.requestId,
        targetCount: pending.targetCount,
        failedCount: [...pending.receipts.values()].filter(
          (receipt) => receipt.status !== "applied",
        ).length,
        receipts: [...pending.receipts.values()],
      });
    } catch {
      // 发送 Host 已退出；其 RPC 超时会如实返回未知状态。
    }
  }
}
