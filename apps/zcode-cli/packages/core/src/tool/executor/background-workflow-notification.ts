// Modified by ZCode Feiyu.
import {
  type BackgroundResultOriginMeta,
  type DynamicWorkflowRunError,
  type DynamicWorkflowRunStopReason,
  type WorkflowNotificationMeta,
} from "@zcode/contracts";

import type { ExecutableToolCall } from "../types.js";
import type { ToolExecutorDeps } from "./types.js";
import { isRecord } from "./utils.js";
import { formatTaskNotification } from "../../runtime-task/notification.js";
import { describeWorkflowScriptPath } from "../handlers/workflow-script-path.js";
import { isDynamicWorkflowRunDispatchToolName } from "./background-task-registry.js";

import {
  buildWorkflowReportsManifestSection,
  buildWorkflowReportsNotificationSection,
  serializeWorkflowArtifact,
} from "./workflow-artifact.js";
import {
  buildWorkflowArtifactsManifestSection,
  buildWorkflowArtifactsNotificationSection,
  toPublishedArtifactSummaries,
  WORKFLOW_ARTIFACTS_NOTIFICATION_MAX_LINES,
} from "./workflow-published-artifacts.js";

import {
  type BackgroundTaskSnapshot,
  type BashTaskNotificationStatus,
  type WorkflowTerminalRunStatus,
} from "./background-task-types.js";
import {
  normalizeBackgroundTaskNotificationStatus,
  stringField,
} from "./background-notification-helpers.js";
// 按职责拆分；保留原始规则、执行顺序与状态所有者。

export function buildWorkflowTaskSummary(input: {
  lost?: boolean;
  status: BashTaskNotificationStatus;
  runStatus?: WorkflowTerminalRunStatus;
  stopReason?: DynamicWorkflowRunStopReason | undefined;
  subject: string;
}): string {
  const prefix = `Workflow "${input.subject}"`;
  if (input.lost) return `${prefix} failed because its in-process state was lost.`;
  // 一句话就要把「怎么结束的」说清：模型读 summary 比读 XML 字段更早。dwf 的三终态词优先；
  // legacy `Workflow` 不带 runStatus，落回追踪器的通用词。
  if (input.runStatus === "errored") return `${prefix} errored: the script failed.`;
  if (input.runStatus === "stopped" || input.status === "killed") {
    switch (input.stopReason) {
      case "user":
        return `${prefix} was stopped by the user.`;
      case "model":
        return `${prefix} was stopped by you (TaskStop).`;
      case "provider":
        return `${prefix} was stopped on a provider error.`;
      case "interrupted":
        return `${prefix} was stopped: the process that owned it exited.`;
      case "superseded":
        return `${prefix} was stopped and superseded by an amended run.`;
      default:
        return `${prefix} was stopped.`;
    }
  }
  return input.status === "completed" ? `${prefix} completed.` : `${prefix} failed.`;
}

/**
 * dwf 快照上的三终态事实。只有 dwf 那支快照带
 * `runStatus` / `stopReason` / `failure`（端口契约 `DynamicWorkflowRunSnapshot`）；老端口或
 * stub 不发它们时按追踪器的通用词折算：`failed` → errored、`cancelled` → stopped（reason 缺席，
 * 由调用方拿 registry 兜底）。非终态回 undefined。
 */
export function workflowSnapshotTerminal(
  status: string,
  snapshot: BackgroundTaskSnapshot | undefined,
):
  | {
      runStatus: WorkflowTerminalRunStatus;
      stopReason?: DynamicWorkflowRunStopReason;
      failure?: DynamicWorkflowRunError;
    }
  | undefined {
  const record = snapshot === undefined ? undefined : (snapshot as Record<string, unknown>);
  const declared = record?.runStatus;
  const runStatus: WorkflowTerminalRunStatus | undefined =
    declared === "completed" || declared === "errored" || declared === "stopped"
      ? declared
      : status === "completed"
        ? "completed"
        : status === "failed"
          ? "errored"
          : status === "cancelled"
            ? "stopped"
            : undefined;
  if (runStatus === undefined) return undefined;
  const reason = record?.stopReason;
  const stopReason =
    runStatus === "stopped" &&
    (reason === "user" ||
      reason === "model" ||
      reason === "provider" ||
      reason === "interrupted" ||
      reason === "superseded")
      ? reason
      : undefined;
  const failure = isRecord(record?.failure)
    ? (record?.failure as unknown as DynamicWorkflowRunError)
    : undefined;
  return {
    runStatus,
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(failure === undefined ? {} : { failure }),
  };
}

export function workflowTaskSubject(
  toolCall: ExecutableToolCall,
  taskId: string,
  snapshot: BackgroundTaskSnapshot | undefined,
  output: Record<string, unknown> | undefined,
): string {
  const input = isRecord(toolCall.input) ? toolCall.input : {};
  return (
    stringField(input, "description") ??
    (snapshot && "description" in snapshot ? runtimeString(snapshot.description) : undefined) ??
    (snapshot && "name" in snapshot ? runtimeString(snapshot.name) : undefined) ??
    stringField(output, "name") ??
    stringField(input, "name") ??
    stringField(input, "scriptPath") ??
    taskId
  );
}

export function runtimeString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** manifest 载荷（`WorkflowNotificationMeta`）里各字段的界。发射侧就地截断——载荷随 turnHeader
 *  row 走协议 + snapshot，shared 的 `workflowNotificationMetaSchema` 用同一组 `.max()` 把关，
 *  超界会让整行落库时 zod 拒收。所以截断是**构造前**的纪律，不是可有可无的收尾。 */
export const WORKFLOW_NOTIFICATION_SUMMARY_MAX_CHARS = 500;

export const WORKFLOW_NOTIFICATION_RESULT_MAX_CHARS = 4_000;

export const WORKFLOW_NOTIFICATION_ERROR_MAX_CHARS = 2_000;

/**
 * workflow run 终态通知的 workflow originMeta（含 manifest 载荷）。CreateWorkflow / ResumeWorkflowRun
 * 两个入口同构，都经这里铸造：title 与 summary 同源（`workflowTaskSubject`），载荷只在**终态且
 * 快照在场**时携带（非终态 / lost 无快照 → 整字段缺席，GUI 退回裸标题行）。
 */
export function buildWorkflowNotificationOriginMeta(
  toolCall: ExecutableToolCall,
  taskId: string,
  status: string,
  snapshot: BackgroundTaskSnapshot | undefined,
  output: Record<string, unknown> | undefined,
): BackgroundResultOriginMeta {
  const subject = workflowTaskSubject(toolCall, taskId, snapshot, output);
  const workflowNotification = buildWorkflowTerminalNotification(status, subject, snapshot);
  return {
    backgroundSource: "workflow",
    title: subject,
    workId: taskId,
    ...(workflowNotification ? { workflowNotification } : {}),
  };
}

/**
 * 快照级事实 → terminal 判别分支的 manifest 载荷。
 *
 * 只在三个终态（completed / failed / cancelled）且快照在场时铸造。`lost`（快照缺失）与非终态
 * 一律回 `undefined`——载荷缺席即 GUI 退回现状标题行，而不是谎报一个空壳。**usage/tokens 发射
 * 时不可知**（只在内存态投影里），所以只带 durationMs，tokens 留给 GUI 渲染期按 runId 联查。
 */
export function buildWorkflowTerminalNotification(
  status: string,
  summary: string,
  snapshot: BackgroundTaskSnapshot | undefined,
): WorkflowNotificationMeta | undefined {
  const terminalStatus = workflowTerminalNotificationStatus(status);
  if (terminalStatus === undefined || snapshot === undefined) return undefined;

  const terminal = workflowSnapshotTerminal(status, snapshot);
  const meta: Extract<WorkflowNotificationMeta, { kind: "terminal" }> = {
    kind: "terminal",
    status: terminal?.runStatus ?? terminalStatus,
    ...(terminal?.stopReason === undefined ? {} : { stopReason: terminal.stopReason }),
    summary: summary.slice(0, WORKFLOW_NOTIFICATION_SUMMARY_MAX_CHARS),
  };

  // 产物：脚本的任意顶层返回值，统一序列化。截断诚实——`resultTruncated` 在场即预览是局部的，
  // 全量经 run id / GetWorkflowRun 可取。resultForm 与 serializeWorkflowArtifact 的分叉对齐：
  // string 原样（prose），其余 JSON.stringify（json）。
  const outputValue = snapshot && "output" in snapshot ? snapshot.output : undefined;
  const serialized = serializeWorkflowArtifact(outputValue);
  if (serialized !== undefined) {
    if (serialized.length > WORKFLOW_NOTIFICATION_RESULT_MAX_CHARS) {
      meta.result = serialized.slice(0, WORKFLOW_NOTIFICATION_RESULT_MAX_CHARS);
      meta.resultTruncated = true;
    } else {
      meta.result = serialized;
    }
    meta.resultForm = typeof outputValue === "string" ? "prose" : "json";
  }

  const error = snapshot && "error" in snapshot ? runtimeString(snapshot.error) : undefined;
  if (error !== undefined) meta.error = error.slice(0, WORKFLOW_NOTIFICATION_ERROR_MAX_CHARS);

  // 渐进产物三个终态一律携带：一个死在第 12 个 ask 上的 run 仍做完了 11 个 ask 的活。
  const reports = buildWorkflowReportsManifestSection(
    workflowSnapshotReports(snapshot),
    workflowSnapshotReportCount(snapshot),
  );
  if (reports !== undefined) meta.reports = reports;

  // 用户面产物的 chips 载荷。这是通知行 chips 的
  // **唯一**数据源：hydration 冷恢复把它按 shared 的 zod 原样读回，缺一个键就等于 chips 永久
  // 消失。三个终态一律携带，理由同 reports。
  const artifactsSection = buildWorkflowArtifactsManifestSection(
    workflowSnapshotArtifacts(snapshot),
  );
  if (artifactsSection !== undefined) {
    meta.artifacts = artifactsSection.artifacts;
    if (artifactsSection.artifactsTruncated) meta.artifactsTruncated = true;
  }

  const durationMs = workflowNotificationDurationMs(snapshot);
  if (durationMs !== undefined) meta.durationMs = durationMs;

  return meta;
}

/**
 * 追踪器终态 status → manifest 的三个终态字面（`failed` → errored、`cancelled` → stopped）；非终态（running / lost 等）回 undefined（不携带
 * 载荷）。快照自带 `runStatus` 时以它为准（见 workflowSnapshotTerminal）。
 */
export function workflowTerminalNotificationStatus(
  status: string,
): "completed" | "errored" | "stopped" | undefined {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "errored";
    case "cancelled":
      return "stopped";
    default:
      return undefined;
  }
}

/**
 * 通知里的墙钟时长（完成卡的「时间」格，见
 * docs/dynamic-workflow/transcript-and-notifications.md「How long it took」）。
 *
 * 两个来源，取**大**者：
 *   - 本世：`completedAt - startedAt`，结算它的这个进程自己看到的那一段；
 *   - 整条 lineage 的活动时长：`activeDurationMs`，由端口从 journal 求和（resume 的每一世 +
 *     沿 `resumedFrom` 的每个前驱），缺席即读不出。
 *
 * 缺陷原因（2026-09-21）：只报本世会把「跑了四小时、修订过一次」的 run 报成 12 秒——修订与
 * resume 各自重开一次进程内时钟，而那一世大半是缓存重放。取大而不是直接取 lineage，是为了守住
 * 「永不少报本进程亲眼所见」：老 run 的事件早于本记账、journal 读面不在场时 `activeDurationMs`
 * 缺席，退回本世；而 lineage 值正常总比本世大（它含本世）。
 *
 * 两个来源都读不出时整字段缺席（卡上写 `—`），不写 0。
 */
export function workflowNotificationDurationMs(
  snapshot: BackgroundTaskSnapshot,
): number | undefined {
  const startedAt =
    "startedAt" in snapshot && snapshot.startedAt instanceof Date
      ? snapshot.startedAt.getTime()
      : undefined;
  const completedAt =
    "completedAt" in snapshot && snapshot.completedAt instanceof Date
      ? snapshot.completedAt.getTime()
      : undefined;
  const ownLifeMs =
    startedAt === undefined || completedAt === undefined
      ? undefined
      : nonNegativeFinite(completedAt - startedAt);
  const lineageMs =
    "activeDurationMs" in snapshot ? nonNegativeFinite(snapshot.activeDurationMs) : undefined;
  if (ownLifeMs === undefined) return lineageMs;
  return lineageMs === undefined ? ownLifeMs : Math.max(ownLifeMs, lineageMs);
}

/** 非负有限数才算一个时长；其余（NaN / Infinity / 负数 / 非数）一律读作「说不出」。 */
export function nonNegativeFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * 快照上的 dwf 渐进产物。`BackgroundTaskSnapshot` 是个联合类型（bash / subagent / legacy
 * workflow / dwf 各一支），只有 dwf 那支有 `reports`，所以按 `in` 收窄而不是断言。
 * 形状照样防御性检查：这条路径的输入来自端口实现，而快照是跨包契约。
 */
/**
 * 快照上的 dwf 脚本文件（绝对路径）。收窄方式与 {@link workflowSnapshotReports} 同款
 * （`in` 而不是断言：`BackgroundTaskSnapshot` 是四支联合，只有 dwf 那支有这个键），形状再过
 * 一遍 typeof——快照是跨包契约，老端口 / stub 完全可能不带它。
 */
export function workflowSnapshotScriptPath(
  snapshot: BackgroundTaskSnapshot | undefined,
): string | undefined {
  if (snapshot === undefined || !("scriptPath" in snapshot)) return undefined;
  return typeof snapshot.scriptPath === "string" && snapshot.scriptPath.length > 0
    ? snapshot.scriptPath
    : undefined;
}

export function workflowSnapshotReports(
  snapshot: BackgroundTaskSnapshot | undefined,
): readonly unknown[] | undefined {
  if (snapshot === undefined || !("reports" in snapshot)) return undefined;
  return Array.isArray(snapshot.reports) ? snapshot.reports : undefined;
}

/** 快照上的 report 真实总数（`reports` 只带前 256 条）；缺席即老快照，读侧退回条目数。 */
export function workflowSnapshotReportCount(
  snapshot: BackgroundTaskSnapshot | undefined,
): number | undefined {
  if (snapshot === undefined || !("reportCount" in snapshot)) return undefined;
  return typeof snapshot.reportCount === "number" ? snapshot.reportCount : undefined;
}

/**
 * 快照上的 dwf **用户面产物**（`artifact.*` 发布的产出，不是 `output` 那个返回值）。收窄方式
 * 与 {@link workflowSnapshotReports} 同款（`in` 而不是断言：`BackgroundTaskSnapshot` 是四支
 * 联合，只有 dwf 那支有这个键），形状再过一遍防御性解析——快照是跨包契约。
 */
export function workflowSnapshotArtifacts(
  snapshot: BackgroundTaskSnapshot | undefined,
): ReturnType<typeof toPublishedArtifactSummaries> {
  if (snapshot === undefined || !("artifacts" in snapshot)) return undefined;
  return toPublishedArtifactSummaries(snapshot.artifacts);
}

export function formatWorkflowTaskNotification(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  taskId: string,
  status: string,
  snapshot: BackgroundTaskSnapshot | undefined,
  launchOutput?: Record<string, unknown>,
): string {
  const output =
    snapshot && "output" in snapshot && isRecord(snapshot.output) ? snapshot.output : launchOutput;
  const subject = workflowTaskSubject(toolCall, taskId, snapshot, output);
  const notificationStatus = normalizeBackgroundTaskNotificationStatus(status);
  // dwf 的三终态词与停止原因从快照读：run service 把
  // journal 里的 `stopReason` 投影到 `snapshot.stopReason`，所以「谁停的」不再只活在 registry。
  // registry 的 stopInitiator 只作兼容兜底（老端口 / stub 不发 stopReason 时）。
  const terminal = workflowSnapshotTerminal(status, snapshot);
  const stopReason =
    terminal?.stopReason ??
    (status === "cancelled" ? deps.runtimeTaskRegistry?.get(taskId)?.stopInitiator : undefined);
  const summary = buildWorkflowTaskSummary({
    lost: status === "lost",
    status: notificationStatus,
    runStatus: terminal?.runStatus,
    stopReason,
    subject,
  });
  // dwf 与 legacy `Workflow` 在**结果**这一项上分道：
  //   - dwf 的产物是脚本的任意顶层返回值，取 `snapshot.output` 原值并统一序列化，且**绝不**
  //     回退到 launch output——后者的 `response` 是「run 已在后台启动」的陈旧散文，
  //     回退过去比缺席更糟（桌面实测 bug 的第二种表现）。
  //   - legacy `Workflow` 的 `output.response` 真实存在，launchOutput 回退是它自己的契约，
  //     逐字节保留。
  // subject 仍走上面那个 record 门控的 output（展示名不涉及产物形状）。
  // dwf 分派名扩到 ResumeWorkflowRun：恢复的 run 与新启动的 run 在通知形状上同构。
  const result = isDynamicWorkflowRunDispatchToolName(toolCall.name)
    ? serializeWorkflowArtifact(snapshot && "output" in snapshot ? snapshot.output : undefined)
    : stringField(output, "response");
  // 渐进产物（`report(item)`）只属于 dwf：legacy `Workflow` 没有这个概念，它的通知逐字节不变。
  // **三个终态一律携带**（completed / failed / cancelled）：一个死在第 12 个 ask 上的 run
  // 仍然做完了 11 个 ask 的活，只报一句「失败」等于把它全扔了——那正是 report 存在的理由。
  // 条目来自 journal 的 kind="report" 行（run service 放在快照上），不是 memory-only 的投影。
  const isDynamicWorkflow = isDynamicWorkflowRunDispatchToolName(toolCall.name);
  const reports = isDynamicWorkflow
    ? buildWorkflowReportsNotificationSection(
        workflowSnapshotReports(snapshot),
        workflowSnapshotReportCount(snapshot),
      )
    : undefined;
  // 用户面产物同样只属于 dwf（legacy `Workflow` 没有这个概念，通知逐字节不变）。三个终态
  // 一律携带：一个失败的 run 已经发布的产物仍然摆在用户面前，通知不提它，模型就会重述一遍。
  const artifacts = isDynamicWorkflow
    ? buildWorkflowArtifactsNotificationSection(
        workflowSnapshotArtifacts(snapshot),
        WORKFLOW_ARTIFACTS_NOTIFICATION_MAX_LINES,
      )
    : undefined;
  // 脚本文件同样只属于 dwf：呈现指引据它把
  // 下一步说成「就地编辑那个文件」。journal 存的是绝对路径，模型面给工作区相对写法——
  // 它接下来要 Edit 这个文件，而那正是它在别处读写文件时用的那一种路径。
  const scriptPath = isDynamicWorkflow ? workflowSnapshotScriptPath(snapshot) : undefined;
  return formatTaskNotification({
    description: subject,
    // 交付物呈现指引同样只属于 dwf。
    ...(isDynamicWorkflow ? { deliveryGuidance: true } : {}),
    ...(scriptPath === undefined
      ? {}
      : { scriptPath: describeWorkflowScriptPath(scriptPath, deps.getWorkingDirectory()) }),
    error: snapshot && "error" in snapshot ? runtimeString(snapshot.error) : undefined,
    ...(reports === undefined ? {} : { reports }),
    ...(artifacts === undefined ? {} : { artifacts }),
    result,
    status: notificationStatus,
    ...(terminal?.runStatus === undefined ? {} : { runStatus: terminal.runStatus }),
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(terminal?.failure === undefined ? {} : { failure: terminal.failure }),
    summary,
    taskId,
    taskType: "local_workflow",
    toolUseId: toolCall.id,
  });
}
