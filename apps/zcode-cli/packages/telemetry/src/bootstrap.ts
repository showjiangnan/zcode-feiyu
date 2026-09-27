// Modified for ZCode Feiyu (2026): local task services, privacy controls and image generation.
import { randomUUID } from "node:crypto";
import { resolveStandaloneDeviceMid } from "./standalone-device-mid.js";
import type {
  AgentTelemetryRuntimeOwner,
  AgentExecutionTelemetryPort,
  ModelApiRuntimeSurface,
  ModelExecutionTelemetryPort,
  TelemetryIdentitySnapshot,
  TelemetryResourceContext,
} from "@zcode/contracts/telemetry";
import type { ModelStatusSink } from "@zcode/contracts/model";
import { NoopAgentExecutionTelemetry } from "./agent-trace-runtime.js";

type EnvRecord = Record<string, string | undefined>;

const TELEMETRY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const BUILD_COMMIT_PATTERN = /^[0-9a-f]{7,64}$/iu;
let preparedOwner: AgentTelemetryRuntimeOwner | undefined;
let preparingOwner: Promise<AgentTelemetryRuntimeOwner | undefined> | undefined;
let preparingOwnerEpoch = 0;
let lastPreparedEnv: EnvRecord | undefined;
let preparedTelemetryAllowed = false;
let preparedTelemetryEpoch = 0;
let shuttingDownOwner: Promise<void> | undefined;
const noopExecution = new NoopAgentExecutionTelemetry();

const activeExecution = () =>
  preparedTelemetryAllowed ? (preparedOwner?.agentExecution ?? noopExecution) : noopExecution;
const activeModelExecution = () =>
  preparedTelemetryAllowed ? (preparedOwner?.modelExecution ?? noopExecution) : noopExecution;
const dynamicAgentExecution: AgentExecutionTelemetryPort = {
  captureCausation: () => activeExecution().captureCausation(),
  startCompaction: (input) => activeExecution().startCompaction(input),
  startDetachedOperation: (input) => activeExecution().startDetachedOperation(input),
  startStep: (input) => activeExecution().startStep(input),
  startTool: (input) => activeExecution().startTool(input),
  startTurn: (input) => activeExecution().startTurn(input),
  abandonSession: (id) => activeExecution().abandonSession(id),
};
const dynamicModelExecution: ModelExecutionTelemetryPort = {
  startCall: (input) => activeModelExecution().startCall(input),
};
const dynamicStatusSink: ModelStatusSink = {
  publish: (event) =>
    preparedTelemetryAllowed ? preparedOwner?.statusSink?.publish(event) : undefined,
  publishFailure: (event, error) =>
    preparedTelemetryAllowed
      ? preparedOwner?.statusSink?.publishFailure?.(event, error)
      : undefined,
};

export interface CreateModelTelemetryOptions {
  owner?: AgentTelemetryRuntimeOwner;
  sessionId?: string;
}

export interface ModelTelemetryBootstrap {
  agentExecution: AgentExecutionTelemetryPort;
  enabled: boolean;
  modelExecution: ModelExecutionTelemetryPort;
  statusSink?: ModelStatusSink;
  shutdown(): Promise<void>;
}

export function createModelTelemetry(
  options: CreateModelTelemetryOptions = {},
): ModelTelemetryBootstrap {
  // 显式注入优先，Endpoint 永远不能覆盖宿主提供的进程级 Owner。
  const owner = options.owner ?? preparedOwner;
  if (!options.owner) {
    return {
      agentExecution: dynamicAgentExecution,
      enabled: Boolean(owner),
      modelExecution: dynamicModelExecution,
      statusSink: dynamicStatusSink,
      async shutdown() {
        if (options.sessionId) preparedOwner?.abandonSession(options.sessionId);
        await preparedOwner?.flush({ timeoutMs: 1_500 });
      },
    };
  }
  if (!owner) {
    return {
      agentExecution: noopExecution,
      enabled: false,
      modelExecution: noopExecution,
      async shutdown() {},
    };
  }
  return {
    agentExecution: owner.agentExecution,
    enabled: owner.enabled,
    modelExecution: owner.modelExecution,
    statusSink: owner.statusSink,
    async shutdown() {
      if (options.sessionId) owner.abandonSession(options.sessionId);
      // Session 只借用进程 Owner。关闭 Session 可以 flush，但不能关闭 Provider、Exporter、
      // Context Manager 或其他 Session 仍在使用的队列。
      await owner.flush({ timeoutMs: 1_500 });
    },
  };
}

export interface PrepareModelTelemetryOptions {
  buildCommitId?: string;
  cliVersion?: string;
  onWarning?: (message: string, context: Record<string, unknown>) => void;
  productVersion?: string;
  runtimeDistribution?: TelemetryResourceContext["runtimeDistribution"];
  runtimeSurface?: ModelApiRuntimeSurface;
}

export function resolveOtlpTraceEndpoint(env: EnvRecord): string | undefined {
  const traceEndpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  if (traceEndpoint) return validHttpUrl(traceEndpoint);
  const commonEndpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!commonEndpoint) return undefined;
  const valid = validHttpUrl(commonEndpoint);
  if (!valid) return undefined;
  const parsed = new URL(valid);
  parsed.pathname = `${parsed.pathname.replace(/\/$/u, "")}/v1/traces`;
  return parsed.toString();
}

export function resolveOtlpMetricEndpoint(env: EnvRecord): string | undefined {
  const metricEndpoint = env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT?.trim();
  if (metricEndpoint) return validHttpUrl(metricEndpoint);
  const commonEndpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (commonEndpoint) {
    const valid = validHttpUrl(commonEndpoint);
    if (!valid) return undefined;
    const parsed = new URL(valid);
    parsed.pathname = `${parsed.pathname.replace(/\/$/u, "")}/v1/metrics`;
    return parsed.toString();
  }
  // ARMS 的自定义 OTLP HTTP 接入点对 Trace/Metric 共用同一 URL；只有 traces 专用
  // 配置时沿用它，避免打包环境必须额外维护一套密钥和接入点。
  return resolveOtlpTraceEndpoint(env);
}

export function parseOtlpHeaders(value: string | undefined): Record<string, string> | undefined {
  if (!value?.trim()) return undefined;
  const headers: Record<string, string> = {};
  for (const pair of value.split(",")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const key = safeDecode(pair.slice(0, separator).trim());
    const headerValue = safeDecode(pair.slice(separator + 1).trim());
    if (key && headerValue) headers[key] = headerValue;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

/**
 * 在 CLI 的异步启动边界准备身份并动态加载 OTel SDK。同步 App 工厂只借用已准备好的
 * 进程级 Owner；disabled 路径不会 import SDK/Exporter。
 */
export async function prepareModelTelemetryEnv(
  env: EnvRecord,
  options: PrepareModelTelemetryOptions = {},
): Promise<EnvRecord> {
  if (resolveOtlpTraceEndpoint(env)) lastPreparedEnv = env;
  if (!resolveOtlpTraceEndpoint(env) || isExplicitlyDisabled(env.ZCODE_MODEL_TELEMETRY_ENABLED)) {
    preparedTelemetryAllowed = false;
    preparedTelemetryEpoch += 1;
    return env;
  }
  if (shuttingDownOwner) await shuttingDownOwner;
  const existingInstallationId = normalizeTelemetryDeviceMid(env.ZCODE_TELEMETRY_DEVICE_MID);
  const installationId =
    existingInstallationId ?? (await resolveStandaloneDeviceMid(env.ZCODE_HOME?.trim()));
  const preparedEnv = installationId ? { ...env, ZCODE_TELEMETRY_DEVICE_MID: installationId } : env;

  if (preparedOwner) {
    preparedTelemetryAllowed = true;
    return preparedEnv;
  }
  if (!preparingOwner) {
    preparingOwnerEpoch = ++preparedTelemetryEpoch;
    preparingOwner = createPreparedOwner(preparedEnv, options, preparingOwnerEpoch);
  }
  const epoch = preparingOwnerEpoch;
  const owner = await preparingOwner;
  if (epoch !== preparedTelemetryEpoch) return preparedEnv;
  preparedOwner = owner;
  preparedTelemetryAllowed = Boolean(preparedOwner);
  return preparedEnv;
}

/** 活动 Agent 的最终出口门禁；关闭先拒发，再清空并关闭旧 exporter。 */
export async function setPreparedModelTelemetryEnabled(enabled: boolean): Promise<void> {
  if (!enabled) {
    await shutdownPreparedModelTelemetry();
    return;
  }
  if (shuttingDownOwner) await shuttingDownOwner;
  if (preparedOwner) {
    preparedTelemetryAllowed = true;
    return;
  }
  await prepareModelTelemetryEnv({ ...lastPreparedEnv, ZCODE_MODEL_TELEMETRY_ENABLED: "1" });
}

export async function shutdownPreparedModelTelemetry(): Promise<void> {
  preparedTelemetryAllowed = false;
  preparedTelemetryEpoch += 1;
  if (shuttingDownOwner) return shuttingDownOwner;
  shuttingDownOwner = (async () => {
    const owner = preparedOwner ?? (await preparingOwner);
    preparedOwner = undefined;
    preparingOwner = undefined;
    await owner?.shutdown({ timeoutMs: 1_500 });
  })();
  try {
    await shuttingDownOwner;
  } finally {
    shuttingDownOwner = undefined;
  }
}

export function updatePreparedTelemetryIdentity(snapshot: TelemetryIdentitySnapshot): void {
  preparedOwner?.updateIdentity(snapshot);
}

async function createPreparedOwner(
  env: EnvRecord,
  options: PrepareModelTelemetryOptions,
  epoch: number,
): Promise<AgentTelemetryRuntimeOwner | undefined> {
  const endpoint = resolveOtlpTraceEndpoint(env);
  if (!endpoint) return undefined;
  const metricEndpoint = resolveOtlpMetricEndpoint(env);
  const identity = resolveTelemetryIdentity(env);
  const resource: TelemetryResourceContext = {
    buildCommitId: normalizeBuildCommitId(options.buildCommitId ?? env.ZCODE_BUILD_COMMIT_ID),
    cliVersion: normalizeVersion(options.cliVersion),
    deploymentEnvironment:
      env.ZCODE_ENV ??
      env.ZCODE_RUNTIME_ENV ??
      resourceAttributesFromEnv(env)["deployment.environment.name"],
    installationId: normalizeTelemetryDeviceMid(env.ZCODE_TELEMETRY_DEVICE_MID),
    productVersion: normalizeVersion(options.productVersion ?? env.ZCODE_APP_VERSION),
    runtimeDistribution:
      options.runtimeDistribution ??
      resolveRuntimeDistribution(env.ZCODE_TELEMETRY_RUNTIME_DISTRIBUTION),
    runtimeSurface:
      options.runtimeSurface ?? resolveRuntimeSurface(env.ZCODE_TELEMETRY_RUNTIME_SURFACE),
    serviceInstanceId: randomUUID(),
    serviceName: env.OTEL_SERVICE_NAME?.trim() || "zcode-cli-agent",
  };
  try {
    const { createOwnedAgentTelemetryRuntime } = await import("./otlp-exporter.js");
    return createOwnedAgentTelemetryRuntime({
      canExport: () => preparedTelemetryAllowed && preparedTelemetryEpoch === epoch,
      endpoint,
      headers: parseOtlpHeaders(
        env.OTEL_EXPORTER_OTLP_TRACES_HEADERS ?? env.OTEL_EXPORTER_OTLP_HEADERS,
      ),
      identity,
      metricEndpoint,
      metricHeaders: parseOtlpHeaders(
        env.OTEL_EXPORTER_OTLP_METRICS_HEADERS ?? env.OTEL_EXPORTER_OTLP_HEADERS,
      ),
      onWarning: options.onWarning,
      resource,
    });
  } catch (error) {
    options.onWarning?.("Agent telemetry runtime initialization failed", {
      errorType: error instanceof Error ? error.name : typeof error,
    });
    return undefined;
  }
}

function resolveTelemetryIdentity(env: EnvRecord): TelemetryIdentitySnapshot {
  const userSubjectId = normalizeTelemetryId(env.ZCODE_TELEMETRY_USER_SUBJECT_ID);
  const configuredState = env.ZCODE_TELEMETRY_IDENTITY_STATE?.trim();
  const identityState =
    configuredState === "authenticated" ||
    configuredState === "anonymous" ||
    configuredState === "unknown"
      ? configuredState
      : userSubjectId
        ? "authenticated"
        : normalizeTelemetryDeviceMid(env.ZCODE_TELEMETRY_DEVICE_MID)
          ? "anonymous"
          : "unknown";
  return { identityState, ...(userSubjectId ? { userSubjectId } : {}) };
}

export function normalizeTelemetryDeviceMid(value: string | undefined): string | undefined {
  return normalizeTelemetryId(value);
}

function normalizeTelemetryId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && TELEMETRY_ID_PATTERN.test(normalized) ? normalized : undefined;
}

function resolveRuntimeSurface(value: string | undefined): ModelApiRuntimeSurface {
  switch (value?.trim()) {
    case "standalone_cli":
    case "desktop_local_host":
    case "remote_workspace_host":
      return value.trim() as ModelApiRuntimeSurface;
    default:
      return "standalone_cli";
  }
}

function resolveRuntimeDistribution(
  value: string | undefined,
): TelemetryResourceContext["runtimeDistribution"] {
  switch (value?.trim()) {
    case "source":
    case "development_bundle":
    case "packaged":
    case "unknown":
      return value.trim() as TelemetryResourceContext["runtimeDistribution"];
    default:
      return "unknown";
  }
}

function normalizeVersion(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/u.test(normalized)
    ? normalized
    : undefined;
}

function normalizeBuildCommitId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && BUILD_COMMIT_PATTERN.test(normalized) ? normalized.toLowerCase() : undefined;
}

function resourceAttributesFromEnv(env: EnvRecord): Record<string, string> {
  const result: Record<string, string> = {};
  for (const item of env.OTEL_RESOURCE_ATTRIBUTES?.split(",") ?? []) {
    const separator = item.indexOf("=");
    if (separator <= 0) continue;
    result[safeDecode(item.slice(0, separator).trim())] = safeDecode(
      item.slice(separator + 1).trim(),
    );
  }
  return result;
}

function validHttpUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function isExplicitlyDisabled(value: string | undefined): boolean {
  return ["0", "false", "off", "disabled"].includes(value?.trim().toLowerCase() ?? "");
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
