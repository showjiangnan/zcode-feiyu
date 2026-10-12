// Modified by ZCode Feiyu.
import type { WorkspaceId } from "@zcode/contracts";
import type { TraceContext } from "../deps.js";
import { SessionEventType, traceContextToLogContext } from "../deps.js";
import { buildExecutionStateEntry, readRuntimeExecutionState } from "../execution-state.js";
import { projectIdFromDirectory, slugify, titleFromInput } from "../helpers/index.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { persistRuntimeOrchestrationState } from "../orchestration.js";
import { writeDynamicWorkflowActivationEntryIfActivated } from "./dynamic-workflow-activation.js";
import { persistFirstInputTitle } from "./session-first-input-title.js";
import { persistSessionShellEnvironmentSnapshot } from "./session-shell-environment.js";
import { persistRuntimeModelSelection } from "./turn-model.js";

/**
 * 会话是否已进入持久化 store（首条输入 / 外部活动 / 直接启动的启动轮 / 冷恢复任一路径落过行）。
 * 协议层的 session record 以它为 draft 判定的事实源（bootstrap `onSessionEvent` 每条事件对齐一次），
 * 不再靠各命令 handler 各自翻 `record.persistence`。
 */
export function isSessionPersisted(this: AgentRuntimeInternal): boolean {
  return this.sessionPersisted;
}

export const pendingSessionPersistence = new WeakMap<AgentRuntimeInternal, Promise<void>>();

export async function ensureSessionPersisted(
  this: AgentRuntimeInternal,
  input: string,
  traceContext: TraceContext,
): Promise<void> {
  if (!this.sessionStore) return;
  if (this.sessionPersisted) {
    // 创建来源会先持久空 session；首输入仍沿同一命名路径，不能把“有行”等同于“已有首输入”。
    await persistFirstInputTitle(this, input, traceContext);
    return;
  }
  const pending = pendingSessionPersistence.get(this);
  if (pending) return pending;
  // App sampling 可与首轮任务并发；同一任务创建必须合并，避免重复插入及模型配置覆盖。
  const created = persistSession
    .call(this, input, traceContext)
    .finally(() => pendingSessionPersistence.delete(this));
  pendingSessionPersistence.set(this, created);
  return created;
}

export async function persistSession(
  this: AgentRuntimeInternal,
  input: string,
  traceContext: TraceContext,
): Promise<void> {
  if (!this.sessionStore || this.sessionPersisted) return;

  const startedAt = Date.now();
  let phase = "session_store.create";
  this.logger?.info("Session persistence started", {
    ...traceContextToLogContext(traceContext),
    event: "session.persistence.started",
    module: "core.runtime",
    sessionId: this.sessionId,
    status: "started",
  });

  try {
    const directory = this.workingDirectory;
    // bootstrap 会用 path.resolve 规范化执行 cwd；过去又把同一个值写入
    // session.path/directory，导致本地 workspacePath 的末尾 `/` 丢失。冷恢复随后按精确
    // workspaceKey 查 provider registry 时就会落到另一个身份。持久化必须保留协议入口路径。
    const persistedWorkspacePath = this.config.workspacePath ?? directory;
    const title = titleFromInput(input);
    const workspaceIdentity = this.config.memory?.workspaceIdentity?.trim();
    await this.sessionStore.createSession({
      id: this.sessionId,
      projectID: projectIdFromDirectory(directory),
      // Memory workspaceIdentity 是上游提供的不透明隔离键。这里只做类型品牌化，
      // 不能调用会改写字符串的 ID 生成器，否则恢复后的 Memory root 会发生漂移。
      workspaceID: this.config.workspaceIdentity ?? (workspaceIdentity as WorkspaceId | undefined),
      parentID: this.config.parentSessionId,
      traceID: traceContext.traceId,
      taskType: this.config.taskType,
      slug: slugify(this.sessionId),
      directory: persistedWorkspacePath,
      path: persistedWorkspacePath,
      title,
      titleSource: "first_input",
      version: this.appVersion,
      permission: {
        mode: this.config.mode ?? "build",
      },
    });
    // 初始模型过去只写进首条 user message，没有写稳定的 session selection。
    // 冷恢复从末尾 assistant 反推时只能得到 provider/model，必选 reasoning 会丢失，
    // Subagent 因此在 hydration 前就无法重新创建 Model。会话创建时同步固定完整选型，
    // 后续显式切模仍复用同一个稳定 entry 覆盖。
    phase = "session_model_selection";
    const initialSelection = this.getSessionModelSelection();
    if (initialSelection) await persistRuntimeModelSelection(this, initialSelection);
    phase = "session_shell_snapshot";
    await persistSessionShellEnvironmentSnapshot(this, traceContext);
    phase = "session_execution_state";
    if (this.config.imageGeneration) {
      const timestamp = Date.now();
      await this.sessionStore.saveSessionEntry?.({
        id: `${this.sessionId}:runtime:image_generation`,
        sessionID: this.sessionId,
        type: "runtime/image_generation",
        touchSession: false,
        time: { created: timestamp, updated: timestamp },
        data: this.config.imageGeneration,
      });
    }
    await this.sessionStore.saveSessionEntry?.(
      buildExecutionStateEntry(this.sessionId, readRuntimeExecutionState(this)),
    );
    // `/workflow` 作为首轮时激活先于落盘（launch.md「On demand: activation」），entry 在这里补写。
    await writeDynamicWorkflowActivationEntryIfActivated(this);
    this.sessionPersisted = true;
    // 预热会话上已确认的编排模式在此补写，避免首个模型边界前取消/崩溃后回到 standard。
    phase = "session_orchestration_state";
    await persistRuntimeOrchestrationState(this);
    this.logger?.debug("Session persisted", {
      ...traceContextToLogContext(traceContext),
      event: "session.persisted",
      module: "core.runtime",
      status: "completed",
    });
    // 之前只把 first_input title 写进 sessionStore 但不 appendEvent，
    // 导致下游 (z-code services 层的 task index sqlite syncer) 等不到 session.titleUpdated，
    // 侧边栏一直显示 "New session" 直到后台 LLM 生成 title。这里补一条 source="first_input"
    // 事件，让 desktop/web/mobile 三端的 syncer 走同一条收敛路径。
    phase = "session_title_event";
    await this.appendEvent(
      this.createEvent(
        SessionEventType.SessionTitleUpdated,
        {
          previousTitle: "",
          source: "first_input",
          title,
        },
        traceContext,
      ),
      traceContext,
    );
    this.logger?.info("Session persistence completed", {
      ...traceContextToLogContext(traceContext),
      durationMs: Date.now() - startedAt,
      event: "session.persistence.completed",
      module: "core.runtime",
      sessionId: this.sessionId,
      status: "completed",
    });
  } catch (error) {
    this.logger?.warn("Session persistence failed", {
      ...traceContextToLogContext(traceContext),
      durationMs: Date.now() - startedAt,
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "session.persistence.failed",
      module: "core.runtime",
      phase,
      sessionId: this.sessionId,
      status: "failed",
    });
    throw error;
  }
}
