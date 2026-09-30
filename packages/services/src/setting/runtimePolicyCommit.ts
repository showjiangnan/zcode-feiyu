// Modified by ZCode Feiyu contributors (2026).
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  appRuntimePreferencesChangedBroadcastPayloadSchema,
  type AppSettings,
  type AppRuntimePreferencesChangedBroadcastPayload,
  type RuntimePolicyAcknowledgement,
} from "@zcode/shared";
import { atomicWriteText } from "../fs/atomicFileUtils.js";
import type { ISettingService } from "./setting.js";

type ApplyPolicy = (policy: AppRuntimePreferencesChangedBroadcastPayload) => Promise<void>;
const bindings = new WeakMap<ISettingService, ApplyPolicy>();
const keys = [
  "askUserQuestionAutoResolutionEnabled",
  "modelIoFullRetentionEnabled",
  "telemetryReportingEnabled",
  "memoryEnabled",
  "memoryExtractionEnabled",
  "memoryReviewEnabled",
  "continueAfterCloseOnMac",
] as const;
const intentPath = (directory: string) => join(directory, "pending-runtime-policy.json");

/** 同一 Host 的执行投影；不读 setting.get，避免跨 Host 持锁提交等待回执时成环。 */
export function createRuntimePolicyApplier(
  apply: (policy: AppRuntimePreferencesChangedBroadcastPayload) => Promise<void>,
) {
  let accepted: AppRuntimePreferencesChangedBroadcastPayload | undefined;
  let appliedRevision: number | undefined;
  let tail = Promise.resolve();
  return (
    policy: AppRuntimePreferencesChangedBroadcastPayload,
  ): Promise<RuntimePolicyAcknowledgement> => {
    const operation = tail.then(async (): Promise<RuntimePolicyAcknowledgement> => {
      if (accepted && policy.policyRevision < accepted.policyRevision) {
        return {
          policyRevision: appliedRevision,
          status: "superseded",
          error: "A newer policy was already admitted",
        };
      }
      if (
        accepted &&
        policy.policyRevision === accepted.policyRevision &&
        JSON.stringify(policy) !== JSON.stringify(accepted)
      ) {
        return {
          policyRevision: appliedRevision,
          status: "failed",
          error: "Conflicting policy at the same revision",
        };
      }
      accepted = policy;
      try {
        await apply(policy);
        appliedRevision = policy.policyRevision;
        return { policyRevision: appliedRevision, status: "applied" };
      } catch (error) {
        // 部分失败不能把 accepted 冒充为 applied；重试同版本仍要执行完整收口。
        return {
          policyRevision: appliedRevision,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });
    tail = operation.then(
      () => {},
      () => {},
    );
    return operation;
  };
}

/** Host 装配端绑定执行回执，不向 Renderer RPC 暴露回调或第二条设置写入口。 */
export function bindSettingRuntimePolicy(service: ISettingService, apply: ApplyPolicy): void {
  bindings.set(service, apply);
}

export function runtimePolicyFromSettings(
  settings: AppSettings,
): AppRuntimePreferencesChangedBroadcastPayload {
  return {
    policyRevision: settings.policyRevision ?? 0,
    askUserQuestionAutoResolutionEnabled: settings.askUserQuestionAutoResolutionEnabled !== false,
    modelIoFullRetentionEnabled: settings.modelIoFullRetentionEnabled === true,
    telemetryReportingEnabled: settings.telemetryReportingEnabled === true,
    memoryEnabled: settings.memoryEnabled === true,
    memoryExtractionEnabled:
      settings.memoryEnabled === true && settings.memoryExtractionEnabled === true,
    memoryReviewEnabled: settings.memoryEnabled === true && settings.memoryReviewEnabled === true,
    continuityPolicy: settings.continuityPolicy,
    continueAfterCloseOnMac: settings.continueAfterCloseOnMac === true,
  };
}

export async function applyPendingRuntimePolicy(
  directory: string,
  settings: AppSettings,
): Promise<AppSettings> {
  try {
    const policy = appRuntimePreferencesChangedBroadcastPayloadSchema.parse(
      JSON.parse(await readFile(intentPath(directory), "utf8")),
    );
    const durableRevision = settings.policyRevision ?? 0;
    if (policy.policyRevision > durableRevision) return { ...settings, ...policy };
    // 修复原因：开启流程是「R+1 限制门禁 → 持久化 R+2 允许正文 → 等待执行端确认」。若在确认前进程退出，
    // 冷读以较高修订的正文为准，执行端从未确认过的开启就被当成已生效（复审 DEF-11）。
    // 依据：DEL-01 要求开启只有持久化并同步后才有效。遗留的意图正好是这次提交的前一修订（提交成功会清除它），
    // 说明允许项没有被确认，因此这些允许项保持关闭，直到下一次成功提交；已在门禁前就开启的项不受影响。
    if (policy.policyRevision === durableRevision - 1)
      return holdBackUnconfirmedEnables(settings, policy);
    return settings;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return settings;
    // 损坏的门禁不能恢复自动许可；错误保持可见，不把失败伪装为默认开启。
    throw new Error("Cannot read pending runtime policy", { cause: error });
  }
}

function holdBackUnconfirmedEnables(
  settings: AppSettings,
  gate: AppRuntimePreferencesChangedBroadcastPayload,
): AppSettings {
  let effective = settings;
  for (const key of keys) {
    if (gate[key] === false && settings[key] === true) effective = { ...effective, [key]: false };
  }
  if (
    gate.continuityPolicy?.proactiveWorkAllowed === false &&
    settings.continuityPolicy?.proactiveWorkAllowed === true
  ) {
    effective = {
      ...effective,
      continuityPolicy: { ...settings.continuityPolicy, proactiveWorkAllowed: false },
    };
  }
  return effective;
}

export async function commitRuntimePolicy(input: {
  directory: string;
  service: ISettingService;
  current: AppSettings;
  next: AppSettings;
  shouldCommit?: () => boolean;
  enterCommitPhase?: () => void;
  commit: (settings: AppSettings) => Promise<void>;
}): Promise<void> {
  const apply = bindings.get(input.service);
  const currentPolicy = runtimePolicyFromSettings(input.current);
  const nextPolicy = runtimePolicyFromSettings(input.next);
  if (
    !keys.some((key) => currentPolicy[key] !== nextPolicy[key]) &&
    JSON.stringify(currentPolicy.continuityPolicy) === JSON.stringify(nextPolicy.continuityPolicy)
  ) {
    const committed = { ...input.next, policyRevision: currentPolicy.policyRevision + 1 };
    await input.commit(committed);
    await apply?.(runtimePolicyFromSettings(committed));
    return;
  }
  const gate = { ...currentPolicy, policyRevision: currentPolicy.policyRevision + 1 };
  if (nextPolicy.continuityPolicy && !nextPolicy.continuityPolicy.proactiveWorkAllowed) {
    gate.continuityPolicy = { ...nextPolicy.continuityPolicy, proactiveWorkAllowed: false };
  }
  for (const key of keys) {
    // 关闭先持久化限制意图，再等所有执行端停止；开启必须等正文提交后。
    if (nextPolicy[key] === false) gate[key] = false;
  }
  if (input.shouldCommit && !input.shouldCommit()) throw new Error("Stale runtime policy commit");
  await atomicWriteText(intentPath(input.directory), JSON.stringify(gate), {
    beforeRename: () => {
      if (input.shouldCommit && !input.shouldCommit())
        throw new Error("Stale runtime policy commit");
      // 限制意图落盘后必须等本轮全部收口；不能让写队列先超时并放行旧提交的后续广播。
      input.enterCommitPhase?.();
    },
  });
  await apply?.(gate);
  const committed = { ...input.next, policyRevision: gate.policyRevision + 1 };
  await input.commit(committed);
  try {
    await apply?.(runtimePolicyFromSettings(committed));
  } catch (error) {
    // 开启的最终 ACK 部分失败时，新冷启动也必须看到 deny；不能遗留较低门禁让正文允许悄悄生效。
    const denied = { ...gate, policyRevision: committed.policyRevision + 1 };
    await atomicWriteText(intentPath(input.directory), JSON.stringify(denied));
    try {
      await apply?.(denied);
    } catch (drainError) {
      throw new AggregateError(
        [error, drainError],
        `Runtime policy commit and restriction drain failed: ${String(error)}; ${String(drainError)}`,
      );
    }
    throw error;
  }
  await unlink(intentPath(input.directory));
}
