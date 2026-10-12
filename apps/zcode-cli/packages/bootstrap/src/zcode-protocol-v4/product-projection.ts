// Modified by ZCode Feiyu.
// 状态仍由原 owner 独占；按事件职责装配 prototype 方法，确保原子 clone 继承同一实现。
import type {
  ConversationSnapshot,
  MutableConversationSnapshotAccumulator,
  CuaAppIdentity,
} from "@zcode/shared/zcode-protocol-v4";
import type {
  FileToolInputPreviewState,
  HighspeedToolInterval,
  TurnModelBaseline,
} from "./product-projection-stream-recovery-reason-code.js";
import type {
  PendingSessionHookInvocation,
  ConversationEditTarget,
  ContextWindowProjectionState,
} from "./product-projection-hook-invocation-row-content.js";
import type { ConversationNormalizationDiagnostic } from "./event-normalizer.js";
import { createInitialConversationSnapshot } from "./projection-state.js";
import { installV4OwnerMethods } from "./owner-methods.js";
import * as part1 from "./product-projection-get-snapshot.js";
import * as part2 from "./product-projection-seed-subagents.js";
import * as part3 from "./product-projection-resolve-stable-fork-candidate.js";
import * as part4 from "./product-projection-adopt-projection.js";
import * as part5 from "./product-projection-reduce.js";
import * as part6 from "./product-projection-on-session-resumed.js";
import * as part7 from "./product-projection-on-hook-run-lifecycle.js";
import * as part8 from "./product-projection-hook-block-error-delta.js";
import * as part9 from "./product-projection-rewind-anchor-for-rows.js";
import * as part10 from "./product-projection-on-turn-started.js";
import * as part11 from "./product-projection-apply-background-task-notification.js";
import * as part12 from "./product-projection-on-turn-error.js";
import * as part13 from "./product-projection-stream-recovery-api-retry.js";
import * as part14 from "./product-projection-on-assistant-feedback-updated.js";
import * as part15 from "./product-projection-update-tool-indexes-after-deltas.js";
import * as part16 from "./product-projection-on-tool-call-scheduled.js";
import * as part17 from "./product-projection-todo-plan-deltas.js";
import * as part18 from "./product-projection-create-pending-interaction-from-permission-event.js";
import * as part19 from "./product-projection-on-workspace-hook-review-requested.js";
import * as part20 from "./product-projection-on-turn-steer-queued.js";
import * as part21 from "./product-projection-on-turn-steer-drained.js";
import * as part22 from "./product-projection-split-product-turn.js";
import * as part23 from "./product-projection-on-session-mode-changed.js";
import * as part24 from "./product-projection-materialize-subagent-projection.js";
import * as part25 from "./product-projection-on-subagent-spawned.js";
import * as part26 from "./product-projection-on-background-task-lifecycle.js";
import * as part27 from "./product-projection-on-model-selected.js";
import * as part28 from "./product-projection-on-model-complete.js";
import * as part29 from "./product-projection-on-compact-lifecycle.js";
import * as part30 from "./product-projection-on-target-changed.js";
import * as part31 from "./product-projection-on-target-verification.js";
import * as part32 from "./product-projection-goal-verify-lifecycle-key.js";
import * as part33 from "./product-projection-highspeed-timing-for-turn.js";
import * as part34 from "./product-projection-find-subagent-lifecycle-row.js";

export class ProductProjection {
  private snapshot: ConversationSnapshot;

  // reducer 内部的 rowId 查找必须与 rows.window 同步；冷恢复过去每次 find 都扫描全表，
  // tool/turn 终态越多退化越明显。普通归约增量维护，rewind 才重建。
  private rowIndexById = new Map<number, number>();

  private hydrationAccumulator: MutableConversationSnapshotAccumulator | null = null;

  private nextRowId = 1;

  private streamingTextRowId: number | null = null;

  private streamingReasoningRowId: number | null = null;

  // output-token Continue 是同一 product turn 内的请求级恢复，不应泄漏成新的正文行。
  // 这里只保留上一条满足 length/zero-tool/视觉紧邻条件的 text row，任何真实边界都会清空。
  private outputContinuationTextRowId: number | null = null;

  private toolRowIdByCallId = new Map<string, number>();

  private latestListAppsSnapshot = new Map<number, CuaAppIdentity>();

  // snapshot 是权威状态；该 Set 只是 TurnComplete 缺终态兜底的派生索引，避免每轮扫描全表。
  private openForegroundToolCallIds = new Set<string>();

  private fileToolInputPreviewByCallId = new Map<string, FileToolInputPreviewState>();

  private subagentRowIdByAgentId = new Map<string, number>();

  private hookRowIdByInvocationId = new Map<string, number>();

  // resume SessionStart 没有 turnId；先保留在 CLI projection，下一条真实 user-intent
  // TurnStarted 到达后再分配 rowId/turnId。不得构造 session-hooks:* synthetic turn。
  private pendingSessionHookInvocations = new Map<string, PendingSessionHookInvocation>();

  // rewind 后 async Hook 的 terminal 仍可能迟到；保留 invocation 墓碑，避免被删旧分支
  // 因找不到原 row 而被 terminal-only 兼容路径重新 append。
  private rewoundHookInvocationIds = new Set<string>();

  // 冷恢复 transcript 可能含旧版本先发布、后持久化失败的 ghost child。store seed 后
  // 必须持续排除，而不是只覆盖一次 snapshot；否则下一条无关事件会从历史 row 再物化它。
  private invalidSubagentChildSessionIds = new Set<string>();

  // rowId → 权威 messageId 侧表。forkAssistant/editUserQuery 的命令载荷用 rowId
  // 定位，但旧 fork/rewind operations 用 messageId（history target）——桥接层经本表翻译。
  // 不进 row schema（客户端只发 rowId，messageId 是服务端内部锚点，避免污染冻结的行结构）。
  private messageIdByRowId = new Map<number, string>();

  // Continue 复用 rowId 后，动作锚点推进到最后一条 assistant message；旧 partial messageId
  // 仍需能命中同一 row，供 compact coverage、rewind 和整轮文件事实恢复使用。
  private outputContinuationRowIdByMessageId = new Map<string, number>();

  private entityIdByRowId = new Map<number, string>();

  // canonical command target 只按稳定实体身份寻址；rowId 仅是本次 materialization 的
  // transient lookup，刷新/replay 后变化也不会改变 target identity。
  private editTargetByEntityId = new Map<string, ConversationEditTarget>();

  private currentEditableEntityId: string | null = null;

  private stableCompactCoverageBoundaryRowId: number | null = null;

  private turnHeaderRowIdByTurnId = new Map<string, number>();

  private compactMarkerRowIdByOperationId = new Map<string, number>();

  // goal verify boundary 身份 = targetId_goalIteration
  // （verificationId 仅 attempt alias——同 iteration 重试携带新 verificationId，
  // 旧实现按 verificationId keying 会长出第二个 marker）。
  private goalVerifyMarkerRowIdByLifecycleKey = new Map<string, number>();

  // queue drain 在同一 runtimeTurn 内切出新的
  // product turn。runtimeTurnId → 当前 productTurnId 映射；后续事件行经 turnIdOf
  // 归入最新 productTurn。steer（guide）不切轮，内联当前轮。
  private productTurnIdByRuntimeTurnId = new Map<string, string>();

  private runtimeTurnIdByProductTurnId = new Map<string, string>();

  private productTurnSplitOrdinalByRuntimeTurnId = new Map<string, number>();

  private currentProductTurnStartedAtMs: number | null = null;

  // Highspeed 分享需要的真实耗时由 CLI 事件聚合，避免 renderer 离场后丢失拆分数据。
  private highspeedModelDurationByTurnId = new Map<string, number>();

  private highspeedToolIntervalsByTurnId = new Map<string, Map<string, HighspeedToolInterval>>();

  // 投递语义侧表：TurnSteerQueued 时按事件 payload（或 followupMode 兜底）记录，
  // drain 时决定切轮 vs 内联；账本落地后以账本为准。
  private deliveryByPendingInputId = new Map<string, "guide" | "queue">();

  private currentTurnId: string | null = null;

  // 当前 runtime turn 是否由 model-only TurnStarted 建立（manual /compact、
  // goal continuation 等维护 turn）。SessionStart 摘要的 pending 归位不得以维护
  // turn 为收口目标，必须等下一条 user-visible 真实 turn。
  private currentTurnStartedModelOnly = false;

  // contextWindow=null 时协议不暴露分母与已用量，但 reducer 仍需保留最新 context 用量，
  // 以便 registry 后续恢复已知容量时原子重建 usage，而不是错误归零。
  private contextWindowState: ContextWindowProjectionState = {
    maxTokens: null,
    touchedByEvent: false,
    usedTokens: 0,
  };

  // modelChange marker 在「下一个 turn 开始时」生成。
  // silentInitial 保持普通 Main 首轮静默；sourceLess 表示显式 ∅→X；known 保存上一轮
  // 实际使用的 provider/model。thought 只随基线记录，不触发模型身份变化。
  private lastTurnModel: TurnModelBaseline = { kind: "silentInitial" };

  // 种子守卫：事件（权威日志）触碰过的 config 区块不再接受种子覆盖。
  private configModelTouchedByEvent = false;

  // 旧 ModelSelected 不含能力集合；独立守卫允许 runtime seed 补齐旧日志，
  // 又避免后续种子覆盖新事件已原子发布的模型能力。
  private configThoughtLevelsTouchedByEvent = false;

  private configModeTouchedByEvent = false;

  private configOrchestrationTouchedByEvent = false;

  // assistant 守恒：非运行期拒收的正文流计数（gateway 据此置 stale）。
  private droppedContentStreamEventCount = 0;

  // 读取期 legacy fallback 必须可观测；否则 normalizer 缺字段后仍会退化为“可见但不可寻址”。
  private normalizationDiagnostics: ConversationNormalizationDiagnostic[] = [];

  constructor(sessionId: string, logEpoch: string) {
    this.snapshot = createInitialConversationSnapshot(sessionId, logEpoch);
  }

  declare getSnapshot: typeof part1.getSnapshot;

  /** assistant 守恒：被拒收的正文流事件数（>0 = 投影可能缺段，需重 hydration）。 */
  declare getDroppedContentStreamEventCount: typeof part1.getDroppedContentStreamEventCount;

  declare getNormalizationDiagnostics: typeof part1.getNormalizationDiagnostics;

  /** 仅供 publisher 的有界增量估算；返回 null 表示必须走候选快照精确校验。 */
  declare establishedStreamingAppend: typeof part1.establishedStreamingAppend;

  /**
   * config 种子注入。
   *
   * 初始快照 config 曾写死空 provider/model +
   * mode="build"，而 ModelSelected 只在 switchModelConfig 后补发、SessionCreated 刻意
   * 不产 delta——runtime 真值（启动默认模型/项目持久化 mode/历史会话上次选型）从头到尾
   * 进不了投影。后果：① 新会话模型选择器显示空；② 项目持久化 mode=yolo 时 UI 显示
   * build，点 yolo 命中 handler 同值 no-op（判的是 runtime 真值），UI 永远无法收敛——
   * 打破了「revision 不变 ⇔ 无状态变化」的 CAS 不变量。
   *
   * 为什么这么修：种子直改 snapshot.config，不产 delta、不递增 revision/seq——
   * draft「无可见 delta」裁决不被破坏；事件触碰过的区块跳过（重放序
   * 在种子之后时日志值优先）。幂等：可在 ensurePublisher / hydration 后重复调用。
   */
  declare seedConfig: typeof part1.seedConfig;

  /**
   * 导入分享上下文的来源只读种子。
   *
   * shared_context 是 provider-only message，不应物化为用户气泡；来源标记通过
   * snapshot additive 字段下发，供 Desktop 在打开新会话后显示持久提示。该字段
   * 不属于 conversation rows，也不递增 revision/seq，避免伪造一轮对话。
   */
  declare seedSharedContextImport: typeof part1.seedSharedContextImport;

  declare seedUsage: typeof part1.seedUsage;

  /**
   * 冷恢复的 subagent store 校验种子。transcript 可以恢复可见 row，但只有 session
   * store 能证明 child 已持久化为 subagent_child；因此在 candidate publisher 发布前
   * 用该种子整体替换 manifest，旧版本遗留的幽灵 child 不得进入 UI 权威态。
   */
  declare seedSubagents: typeof part2.seedSubagents;

  /**
   * rowId → 权威 messageId。桥接层执行 forkAssistant/editUserQuery 时把命令载荷的
   * 内部 rowId 翻译成 core 需要的 messageId。未知 rowId（非 assistant/user 行、
   * 或迟到）返回 null，桥接层据此回 rejected。
   */
  declare getMessageIdForRow: typeof part2.getMessageIdForRow;

  declare getEntityIdForRow: typeof part2.getEntityIdForRow;

  declare resolveEditTarget: typeof part2.resolveEditTarget;

  declare resolveEditTargetByEntityId: typeof part2.resolveEditTargetByEntityId;

  /**
   * V3 行动作的唯一解析器。展示 rowId 与稳定 entityId 必须同时命中当前 projection；
   * action 可用性直接读取同一次 materialization 生成的 row.actions，handler/preview
   * 不得再各自按位置、phase 或文本重算。
   */
  declare resolveRowActionTarget: typeof part2.resolveRowActionTarget;

  /**
   * 文件摘要撤销以 turn rowId 为入口，服务端解析同一 product turn 内所有
   * messageId，覆盖多段 assistant / 多个 checkpoint；UI 不暴露内部 messageId。
   */
  declare getMessageIdsForTurnRow: typeof part2.getMessageIdsForTurnRow;

  /**
   * core 侧强校验：
   * rowId 是否为其所属 productTurn 的最后一段 assistantText。UI（平铺后）已只在
   * 最后段暴露 fork 入口，这里是防御闸——直接命令面/旧客户端不得 fork 中间段。
   */
  declare isLatestAssistantSegmentRow: typeof part2.isLatestAssistantSegmentRow;

  /**
   * running fork 的同步投影闸门：这里只解析 row/product-turn 与 message 边界；完整
   * orderedMessageIds 由 host 再用 session store 权威顺序补齐并持久化 anchor。
   */
  declare resolveStableForkCandidate: typeof part3.resolveStableForkCandidate;

  /** latestAssistantRetryOnly：retry 只能指向全时间线最新且有 realUser cause 的 assistantText。 */
  declare isLatestRetryAssistantRow: typeof part3.isLatestRetryAssistantRow;

  /** latestQueryEditOnly：只有当前投影里的最后一条 realUser userInput row 可 edit。 */
  declare isLatestEditableUserRow: typeof part3.isLatestEditableUserRow;

  /** rowId → product turnId（命令层 running edit 在无 assistant anchor 时回查 store 用）。 */
  declare getTurnIdForRow: typeof part3.getTurnIdForRow;

  /** 应用一个权威事件，返回该事件产生的 delta 序列（可能为空）。 */
  declare applyEvent: typeof part3.applyEvent;

  /**
   * 冷恢复批量路径只允许在尚未发布的候选 projection 上使用。begin 后 rows.window
   * 原地推进，避免每个事件复制增长数组；publisher 在完整校验通过前不会 adopt 候选。
   */
  declare beginHydrationReplay: typeof part3.beginHydrationReplay;

  declare applyHydrationEvent: typeof part3.applyHydrationEvent;

  /**
   * 把批量期间延迟的 command actions 收敛到当前快照。actions 是同一 reducer 的派生
   * materialization，不单独递增 revision；触发它变化的结构/guard 事件已经记账。
   */
  declare completeHydrationReplay: typeof part3.completeHydrationReplay;

  declare private applyEventInternal: typeof part3.applyEventInternal;

  /**
   * 在独立候选投影上归约事件，校验通过后才原子提交。
   *
   * projection 超过 logical frame assembly 上限时，如果先修改当前实例再等
   * wire encoder 报错，权威内存态会永久停在“无法发 snapshot”的状态。候选实例同时
   * 隔离 snapshot 与 reducer 的各类 side-map；拒绝时当前实例完全不变，客户端仍可从
   * 最后一个可传输 snapshot 恢复。
   *
   * `accept` 同时拿到这条事件**实际产出**的 delta：有些事件类别可以只按 delta 的字节数给出
   * 一个可靠上界，不必把整份候选快照再序列化一遍（publisher 的 ingest 快路径）。传的是实际
   * 产出而不是预演，正是因为预演算不准——投影在 reducer 之上还叠了 subagent 镜像与命令
   * actions 的 materialization，少算一条就把 16MiB 闸门算松了。
   */
  declare applyEventAtomically: typeof part3.applyEventAtomically;

  private cloneProjection(): ProductProjection {
    const clone = Object.create(ProductProjection.prototype) as ProductProjection;
    clone.snapshot = this.snapshot;
    clone.rowIndexById = new Map(this.rowIndexById);
    clone.hydrationAccumulator = null;
    clone.nextRowId = this.nextRowId;
    clone.streamingTextRowId = this.streamingTextRowId;
    clone.streamingReasoningRowId = this.streamingReasoningRowId;
    clone.outputContinuationTextRowId = this.outputContinuationTextRowId;
    clone.toolRowIdByCallId = new Map(this.toolRowIdByCallId);
    // 实时发布逐事件走原子 clone；遗漏该侧表会让成功的 list_apps 快照在提交时丢失。
    clone.latestListAppsSnapshot = new Map(this.latestListAppsSnapshot);
    clone.openForegroundToolCallIds = new Set(this.openForegroundToolCallIds);
    clone.fileToolInputPreviewByCallId = new Map(
      [...this.fileToolInputPreviewByCallId].map(([toolCallId, state]) => [
        toolCallId,
        { ...state },
      ]),
    );
    clone.subagentRowIdByAgentId = new Map(this.subagentRowIdByAgentId);
    clone.hookRowIdByInvocationId = new Map(this.hookRowIdByInvocationId);
    clone.pendingSessionHookInvocations = new Map(
      [...this.pendingSessionHookInvocations].map(([invocationId, pending]) => [
        invocationId,
        {
          firstEvent: pending.firstEvent,
          content: {
            ...pending.content,
            executions: pending.content.executions.map((execution) => ({ ...execution })),
          },
        },
      ]),
    );
    clone.rewoundHookInvocationIds = new Set(this.rewoundHookInvocationIds);
    clone.invalidSubagentChildSessionIds = new Set(this.invalidSubagentChildSessionIds);
    clone.messageIdByRowId = new Map(this.messageIdByRowId);
    clone.outputContinuationRowIdByMessageId = new Map(this.outputContinuationRowIdByMessageId);
    clone.entityIdByRowId = new Map(this.entityIdByRowId);
    clone.editTargetByEntityId = new Map(this.editTargetByEntityId);
    clone.currentEditableEntityId = this.currentEditableEntityId;
    clone.stableCompactCoverageBoundaryRowId = this.stableCompactCoverageBoundaryRowId;
    clone.turnHeaderRowIdByTurnId = new Map(this.turnHeaderRowIdByTurnId);
    clone.compactMarkerRowIdByOperationId = new Map(this.compactMarkerRowIdByOperationId);
    clone.goalVerifyMarkerRowIdByLifecycleKey = new Map(this.goalVerifyMarkerRowIdByLifecycleKey);
    clone.productTurnIdByRuntimeTurnId = new Map(this.productTurnIdByRuntimeTurnId);
    clone.runtimeTurnIdByProductTurnId = new Map(this.runtimeTurnIdByProductTurnId);
    clone.productTurnSplitOrdinalByRuntimeTurnId = new Map(
      this.productTurnSplitOrdinalByRuntimeTurnId,
    );
    clone.currentProductTurnStartedAtMs = this.currentProductTurnStartedAtMs;
    clone.highspeedModelDurationByTurnId = new Map(this.highspeedModelDurationByTurnId);
    clone.highspeedToolIntervalsByTurnId = new Map(
      [...this.highspeedToolIntervalsByTurnId].map(([turnId, intervals]) => [
        turnId,
        new Map([...intervals].map(([toolCallId, interval]) => [toolCallId, { ...interval }])),
      ]),
    );
    clone.deliveryByPendingInputId = new Map(this.deliveryByPendingInputId);
    clone.currentTurnId = this.currentTurnId;
    clone.currentTurnStartedModelOnly = this.currentTurnStartedModelOnly;
    clone.contextWindowState = { ...this.contextWindowState };
    clone.lastTurnModel = { ...this.lastTurnModel };
    clone.configModelTouchedByEvent = this.configModelTouchedByEvent;
    clone.configThoughtLevelsTouchedByEvent = this.configThoughtLevelsTouchedByEvent;
    clone.configModeTouchedByEvent = this.configModeTouchedByEvent;
    clone.configOrchestrationTouchedByEvent = this.configOrchestrationTouchedByEvent;
    clone.droppedContentStreamEventCount = this.droppedContentStreamEventCount;
    clone.normalizationDiagnostics = [...this.normalizationDiagnostics];
    return clone;
  }

  declare private adoptProjection: typeof part4.adoptProjection;

  /**
   * 基于本事件归约后的 prospective rows 原子生成 edit/retry actions。
   * action=true 必须蕴含命令层同 revision 下能解析出持久 message target；最新目标
   * 改变时同时 upsert 旧、新两行，客户端不需要按数组位置补推断。
   */
  declare private materializeCommandRowActions: typeof part4.materializeCommandRowActions;

  // revision 递进：本事件含任一结构性 delta → revision +1，
  // 且携带规则要求 deltas 中必含 state.updated.revision。
  declare private attachRevision: typeof part4.attachRevision;

  declare private reduce: typeof part5.reduce;

  /** A persisted started-only Hook cannot still be running after a real runtime resume. */
  declare private onSessionResumed: typeof part6.onSessionResumed;

  declare private onHookRunLifecycle: typeof part7.onHookRunLifecycle;

  /**
   * UserPromptSubmit 的 executed block 是当前输入的可见错误，但不是 task 失败。
   * 将它投影到 transient lastError，让 ChatErrorBanner 直接展示原因；下一轮 TurnStarted
   * 会按既有生命周期清理它。admission-only block 和工具边界 block 仍只保留在 Hook 摘要。
   */
  declare private hookBlockErrorDelta: typeof part8.hookBlockErrorDelta;

  declare private flushPendingSessionHookInvocations: typeof part8.flushPendingSessionHookInvocations;

  declare private hookExecutionState: typeof part8.hookExecutionState;

  declare private hookExecutionOutcome: typeof part8.hookExecutionOutcome;

  declare private hookInvocationState: typeof part8.hookInvocationState;

  declare private hookInvocationLane: typeof part8.hookInvocationLane;

  /**
   * rewind/edit/retry 的 live 投影截断（editUserQuery/retryTurn 的
   * `row.removed(target 起)`）。RewindTriggered 带 targetMessageId → 反查 rowId →
   * 从该行所属 turn 的首行（turnHeader）起整段移除，让 live 订阅者即时看到截断，
   * 后续 editRerun 新 turn 走既有事件路径追加。冷订阅/刷新的 truncated transcript
   * 由 transcript 合成 hydration 兜底重建。
   * messageId 反查不到（user 行暂无 messageId、或迟到）时返回空，不误删。
   */
  declare private onRewindTriggered: typeof part8.onRewindTriggered;

  /** messageId → rowId 反查（messageIdByRowId 的逆向线性扫描；行数有界，无需额外索引）。 */
  declare private rowIdForMessageId: typeof part8.rowIdForMessageId;

  /**
   * 任意 rowId → 其所属 turn 的 rewind 锚点 messageId。新 live/cold user row 都应
   * 直接携持久 user messageId；同 turn assistant 只保留为旧事件兼容 fallback。
   * `canEdit` 不允许依赖该 fallback，必须由 user row 自身的 exact target 驱动。
   */
  declare getTurnRewindAnchor: typeof part8.getTurnRewindAnchor;

  declare private rewindAnchorForRows: typeof part9.rewindAnchorForRows;

  /**
   * real-user row 的展示身份与命令身份必须原子登记。
   * TurnSteerDrained 曾只写 messageId/entityId，漏写 edit target，
   * 导致 UI action 与 editUserQuery resolver 对同一行得出相反结论。
   */
  declare private registerCanonicalUserRowTarget: typeof part9.registerCanonicalUserRowTarget;

  // ── 生命周期 ──

  declare private onSessionCreated: typeof part9.onSessionCreated;

  // renameSession / 自动标题：SessionTitleUpdated(title, source) → 更新 meta。
  // custom（用户重命名）优先级最高，已 custom 后不再被 generated 覆盖（与 core titleSource 一致）。
  declare private onSessionTitleUpdated: typeof part9.onSessionTitleUpdated;

  declare private onTurnStarted: typeof part10.onTurnStarted;

  declare private applyBackgroundTaskNotification: typeof part11.applyBackgroundTaskNotification;

  declare private onTurnComplete: typeof part11.onTurnComplete;

  /**
   * draft 只有一种离场方式：第一轮收口。phase `draft` 的定义是「纯内存、从未有过真实内容、CLI 重启即
   * 消失」；一条 controlOnly 轮一旦收口，会话已有一段持久化的可见历史，再叫 draft 就与
   * 冷恢复矛盾——store 种子会给它一个终态 phase，而活投影却停在 draft。中枢直接启动
   * 的会话只有一条 controlOnly 启动轮，活投影 phase 恒为 draft，sessions-index 摘要因此被 task-index
   * syncer 当 draft 丢弃，侧栏要等重启才出现。所以 controlOnly 收口只在**会话仍是 draft**时推进 phase
   * （成功 → completedSuccess，取消 → completedInterrupted，失败 → error）；非 draft 会话上的控制轮
   * 照旧不碰 session control（goal 的可见 query 轮不得伪造 running / 工时，见 onTurnStarted）。
   */
  declare private leaveDraftAfterControlOnlyTurn: typeof part11.leaveDraftAfterControlOnlyTurn;

  declare private onTurnError: typeof part12.onTurnError;

  // ── 流式输出 ──

  declare private onModelNetworkStatus: typeof part12.onModelNetworkStatus;

  declare private onStreamRecoveryStarted: typeof part12.onStreamRecoveryStarted;

  declare private onStreamRecoveryTailDiscarded: typeof part12.onStreamRecoveryTailDiscarded;

  declare private onStreamRecoveryRetryStarted: typeof part12.onStreamRecoveryRetryStarted;

  declare private streamRecoveryApiRetry: typeof part13.streamRecoveryApiRetry;

  declare private setApiRetry: typeof part13.setApiRetry;

  declare private acceptsActiveModelEvent: typeof part13.acceptsActiveModelEvent;

  declare private onModelStreaming: typeof part13.onModelStreaming;

  declare private openTextRow: typeof part13.openTextRow;

  declare private closeTextRow: typeof part13.closeTextRow;

  declare private onAssistantFeedbackUpdated: typeof part14.onAssistantFeedbackUpdated;

  declare private onHighspeedMetricsUpdated: typeof part14.onHighspeedMetricsUpdated;

  declare private onTurnExecutionModelFallback: typeof part14.onTurnExecutionModelFallback;

  declare private openReasoningRow: typeof part14.openReasoningRow;

  declare private closeReasoningRow: typeof part14.closeReasoningRow;

  declare private closeStreamingRows: typeof part14.closeStreamingRows;

  // turn 终态收口所有 foreground 未终态 tool row（迟到终态不复活由 isRunning 闸保证）；
  // `only` 让 stream recovery 只收口未定稿的那一部分。
  declare private closeOpenToolRows: typeof part14.closeOpenToolRows;

  declare private isOpenForegroundToolRow: typeof part14.isOpenForegroundToolRow;

  declare private updateToolIndexesAfterDeltas: typeof part15.updateToolIndexesAfterDeltas;

  declare private pruneRemovedSubagentIndexes: typeof part15.pruneRemovedSubagentIndexes;

  // ── tool call 状态机 ──

  declare private openToolRow: typeof part15.openToolRow;

  declare private appendStreamingToolInput: typeof part15.appendStreamingToolInput;

  declare private flushStreamingToolInput: typeof part15.flushStreamingToolInput;

  declare private takePendingStreamingToolInput: typeof part15.takePendingStreamingToolInput;

  declare private finalizeStreamingToolInput: typeof part15.finalizeStreamingToolInput;

  declare private onToolCallScheduled: typeof part16.onToolCallScheduled;

  declare private onToolCallActivity: typeof part16.onToolCallActivity;

  /**
   * MCP `notifications/progress`（A8）→ 行上的 progress。只在 running 时写：
   * 终态之后迟到的进度通知不能把 success/error 行重新点亮；bash 的 stdout 字节进度不在这里消费。
   */
  declare private onToolCallProgress: typeof part16.onToolCallProgress;

  declare private onToolCallResult: typeof part16.onToolCallResult;

  /**
   * TodoWrite 同时投影 live plan 与当前 goal iteration。
   * V4 之前只保留 tool row，右上角摘要无法在 live/cold 恢复后重建每轮 action/status。
   * 轮次只由 verifier boundary 推进；TodoWrite 只更新当前打开轮次，不能自行加一轮。
   */
  declare private todoPlanDeltas: typeof part17.todoPlanDeltas;

  declare private onToolCallError: typeof part17.onToolCallError;

  // ── 权限交互（阻塞交互 → 状态）──

  declare private onPermissionRequested: typeof part17.onPermissionRequested;

  declare private createPendingInteractionFromPermissionEvent: typeof part18.createPendingInteractionFromPermissionEvent;

  declare private onPermissionResolved: typeof part18.onPermissionResolved;

  declare private onPermissionDenied: typeof part18.onPermissionDenied;

  declare private onWorkspaceHookReviewRequested: typeof part19.onWorkspaceHookReviewRequested;

  declare private onWorkspaceHookReviewSettled: typeof part19.onWorkspaceHookReviewSettled;

  declare private onWorkspaceHookReviewSuperseded: typeof part19.onWorkspaceHookReviewSuperseded;

  declare private removeWorkspaceHookReview: typeof part19.removeWorkspaceHookReview;

  /**
   * 软门禁:处理 WorkspaceHookAdmissionUpdated 事件。
   *
   * pendingCount > 0 → 写入 snapshot.workspaceHookAdmission(提示条出现);
   * pendingCount === 0 → 置 null(提示条消失)。
   */
  declare private onWorkspaceHookAdmissionUpdated: typeof part19.onWorkspaceHookAdmissionUpdated;

  declare private onUserInputAutoResolutionUpdated: typeof part19.onUserInputAutoResolutionUpdated;

  declare private settlePermission: typeof part19.settlePermission;

  // ── turn-steer 队列──

  declare private onTurnSteerQueued: typeof part20.onTurnSteerQueued;

  declare private onTurnSteerDispatchChanged: typeof part20.onTurnSteerDispatchChanged;

  declare private onTurnSteerDeliveryChanged: typeof part20.onTurnSteerDeliveryChanged;

  declare private onTurnSteerDrained: typeof part21.onTurnSteerDrained;

  /**
   * queue drain 边界 = product turn 边界（同一 runtimeTurn 内）。
   * 收口上一段 productTurn 的 header（工时按边界拆分，加和 = 总工时），
   * 映射 runtimeTurnId → 新 productTurnId，开新 turnHeader。
   */
  declare private splitProductTurn: typeof part22.splitProductTurn;

  // 工时按边界拆分：drain 切过轮的 runtimeTurn，最后一段 productTurn 的工时
  // = 最后一次边界到完成，不再用整段 runtime duration（否则两段加和超真实时长）。
  declare private activeMsForCompletion: typeof part22.activeMsForCompletion;

  declare private onTurnSteerDiscarded: typeof part22.onTurnSteerDiscarded;

  declare private onSessionInputPromoted: typeof part22.onSessionInputPromoted;

  /** v4 queue 重排：按 orderedPendingInputIds 重排 queue rows（未列出的项保持相对顺序追加）。 */
  declare private onTurnSteerReordered: typeof part22.onTurnSteerReordered;

  // setAutoDrain：queue.autoDrain 授权位翻转。autoDrain 影响 held 派生
  // （heldQueueInputRequiresChoice）与 A 区可用性 → 走 queuePatch 统一重算。
  declare private onQueueAutoDrainChanged: typeof part22.onQueueAutoDrainChanged;

  // setFollowupMode：config.followupMode 翻转。followupMode 是 running 时
  // enqueue vs guide 的路由授权位（computeInputRouting）→ 改 config 后同步重算 A 区。
  declare private onFollowupModeChanged: typeof part22.onFollowupModeChanged;

  /**
   * switchCollaborationMode：SessionModeChanged → config.mode。
   * 事件来源覆盖命令面（source=command）与 plan 工具路径（enterPlanMode/exitPlanMode，
   * source=tool）——两条路径共用这条投影，UI 的模式选择器因此也能跟随工具驱动的模式切换。
   */
  declare private onSessionModeChanged: typeof part23.onSessionModeChanged;

  declare private onSessionOrchestrationChanged: typeof part23.onSessionOrchestrationChanged;

  declare private onTeamBoardChanged: typeof part23.onTeamBoardChanged;

  /**
   * Subagent row 与摘要投影在同一个 event transaction 内 materialize。
   * 旧 UI 在 spawn 后另查 session/subagents；7 个并发 child 中查询若恰好落在
   * 最后一个 session 持久化前，就会永久缓存 6，直到切换 Session 才重查。现在 renderer
   * 只消费这里随 row 一起提交的完整态，不再存在事件/查询双时钟。
   */
  declare private shouldMaterializeSubagentProjection: typeof part23.shouldMaterializeSubagentProjection;

  declare private materializeSubagentProjection: typeof part24.materializeSubagentProjection;

  declare private prospectiveSubagentRow: typeof part24.prospectiveSubagentRow;

  // ── subagent 行镜像──
  // schema/UI 已有 subagent row，但旧 reducer 未消费 Subagent* 事件；
  // cold hydration 即使合成事件也无法恢复下钻行。这里让 live/cold 共用同一状态机。

  declare private onSubagentSpawned: typeof part25.onSubagentSpawned;

  declare private resumedSubagentBackgroundWorkDelta: typeof part25.resumedSubagentBackgroundWorkDelta;

  declare private onSubagentMessage: typeof part25.onSubagentMessage;

  declare private onSubagentStopped: typeof part25.onSubagentStopped;

  // cancelBackgroundWork：后台任务生命周期（BackgroundTaskStarted/Updated/Completed）
  // → 维护 snapshot.backgroundWorks（后台工作面读它渲染 + cancel 入口）。
  // taskId≡workId 无需翻译；status 归一到 summary 的 4 值封闭枚举。
  declare private onBackgroundTaskLifecycle: typeof part26.onBackgroundTaskLifecycle;

  // ── dwf 实时运行态：DynamicWorkflowRunProgress → workflowRuns 状态键 ──
  // 一条引擎 RunEvent 一条会话事件，归约成键级整体替换的权威态。走 reducer 而不是侧通道，
  // 所以持久、可回放、冷恢复免费（先例：subagents 键）。
  //
  // 归约本体在 @zcode/shared 的 workflow-runs-reducer（与状态 schema 同居）：TUI 镜像要用
  // 同一份归约，两处各写一份就是两个时钟（docs/dynamic-workflow/launch.md「The inline card」）。
  // 留在这里的只有投影的非纯部分——从事件信封取载荷、把新旧状态之差发成键级增量。
  declare private onDynamicWorkflowRunProgress: typeof part26.onDynamicWorkflowRunProgress;

  declare private removeQueueItems: typeof part26.removeQueueItems;

  // ── config / usage ──

  declare private onModelSelected: typeof part27.onModelSelected;

  declare private onModelComplete: typeof part28.onModelComplete;

  // ── compact marker（compact 命令效果）──
  // 同一 operationId 全生命周期占同一 marker row：running → success/failed/noop/cancelled。
  // 归属：marker 落在事件到达时的行尾，客户端零归属逻辑。

  declare private onCompactLifecycle: typeof part29.onCompactLifecycle;

  // ── goal 状态机──

  declare private onTargetChanged: typeof part30.onTargetChanged;

  declare private onTargetVerification: typeof part31.onTargetVerification;

  /** goal verify boundary 身份：targetId_goalIteration。 */
  declare private goalVerifyLifecycleKey: typeof part32.goalVerifyLifecycleKey;

  // 落位：优先 anchorAssistantMessageId（解析到已渲染
  // 行的所属轮——fork copy 后是 remap 过的 child local id）；次选 anchorTurnId
  // （必须是已知轮，未知 id 不得当 turnId 用——否则会长出幽灵 turn 分组，
  // fork 前的父 runtime turnId 就是典型）；最后按事件归属。
  declare private goalVerifyTurnId: typeof part32.goalVerifyTurnId;

  // ── fork marker（forkAssistant 命令效果）──

  declare private onSessionForked: typeof part32.onSessionForked;

  // ── 内部工具 ──

  // goal 传 undefined = 不动 goal；传 null/对象 = 随本 patch 一并替换（availability 同源派生）。
  // queue 传 undefined = 不动 queue；held 派生（heldQueueInputRequiresChoice）依赖
  // queue.items.length + autoDrain，所以任何 control/goal/queue 变化都从同一处重算 A 区。
  declare private controlPatch: typeof part32.controlPatch;

  // goal 单独变化时的 patch（availability 与 goal 同源，phase/activeWorks 不变）。
  declare private goalPatch: typeof part32.goalPatch;

  // queue 单独变化时的 patch：queue 长度/autoDrain 影响 held 派生 → 同步重算 A 区。
  declare private queuePatch: typeof part32.queuePatch;

  declare private deriveContext: typeof part32.deriveContext;

  declare private upsertTurnHeader: typeof part32.upsertTurnHeader;

  declare private recordHighspeedToolStarted: typeof part32.recordHighspeedToolStarted;

  declare private recordHighspeedToolEnded: typeof part32.recordHighspeedToolEnded;

  declare private highspeedTimingForTurn: typeof part33.highspeedTimingForTurn;

  declare private openGuidedWorkSegment: typeof part33.openGuidedWorkSegment;

  declare private completeWorkSegments: typeof part33.completeWorkSegments;

  declare private turnHeaderForEvent: typeof part33.turnHeaderForEvent;

  declare private markStableForkAssistant: typeof part33.markStableForkAssistant;

  declare private isRunning: typeof part33.isRunning;

  declare private isMirroredSubagentToolEvent: typeof part33.isMirroredSubagentToolEvent;

  declare private openAssistantSegments: typeof part33.openAssistantSegments;

  declare private openSegmentIdentity: typeof part33.openSegmentIdentity;

  declare private rowBase: typeof part33.rowBase;

  declare private turnIdOf: typeof part33.turnIdOf;

  declare private ms: typeof part33.ms;

  declare private findRow: typeof part33.findRow;

  declare private updateRowIndexAfterImmutableApply: typeof part33.updateRowIndexAfterImmutableApply;

  declare private findToolRow: typeof part33.findToolRow;

  declare private findSubagentRow: typeof part33.findSubagentRow;

  declare private findSubagentLifecycleRow: typeof part34.findSubagentLifecycleRow;

  declare private subagentAgentId: typeof part34.subagentAgentId;

  declare private stringPayload: typeof part34.stringPayload;

  declare private mapSubagentStatus: typeof part34.mapSubagentStatus;
}

installV4OwnerMethods(ProductProjection.prototype, part1);
installV4OwnerMethods(ProductProjection.prototype, part2);
installV4OwnerMethods(ProductProjection.prototype, part3);
installV4OwnerMethods(ProductProjection.prototype, part4);
installV4OwnerMethods(ProductProjection.prototype, part5);
installV4OwnerMethods(ProductProjection.prototype, part6);
installV4OwnerMethods(ProductProjection.prototype, part7);
installV4OwnerMethods(ProductProjection.prototype, part8);
installV4OwnerMethods(ProductProjection.prototype, part9);
installV4OwnerMethods(ProductProjection.prototype, part10);
installV4OwnerMethods(ProductProjection.prototype, part11);
installV4OwnerMethods(ProductProjection.prototype, part12);
installV4OwnerMethods(ProductProjection.prototype, part13);
installV4OwnerMethods(ProductProjection.prototype, part14);
installV4OwnerMethods(ProductProjection.prototype, part15);
installV4OwnerMethods(ProductProjection.prototype, part16);
installV4OwnerMethods(ProductProjection.prototype, part17);
installV4OwnerMethods(ProductProjection.prototype, part18);
installV4OwnerMethods(ProductProjection.prototype, part19);
installV4OwnerMethods(ProductProjection.prototype, part20);
installV4OwnerMethods(ProductProjection.prototype, part21);
installV4OwnerMethods(ProductProjection.prototype, part22);
installV4OwnerMethods(ProductProjection.prototype, part23);
installV4OwnerMethods(ProductProjection.prototype, part24);
installV4OwnerMethods(ProductProjection.prototype, part25);
installV4OwnerMethods(ProductProjection.prototype, part26);
installV4OwnerMethods(ProductProjection.prototype, part27);
installV4OwnerMethods(ProductProjection.prototype, part28);
installV4OwnerMethods(ProductProjection.prototype, part29);
installV4OwnerMethods(ProductProjection.prototype, part30);
installV4OwnerMethods(ProductProjection.prototype, part31);
installV4OwnerMethods(ProductProjection.prototype, part32);
installV4OwnerMethods(ProductProjection.prototype, part33);
installV4OwnerMethods(ProductProjection.prototype, part34);

export type { SessionConfigSeed } from "./product-projection-hook-invocation-row-content.js";
export type { SessionUsageSeed } from "./product-projection-hook-invocation-row-content.js";
export type { SessionSubagentsSeed } from "./product-projection-hook-invocation-row-content.js";
export type { StableForkCandidate } from "./product-projection-hook-invocation-row-content.js";
export type { StableForkCandidateResolution } from "./product-projection-hook-invocation-row-content.js";
export type { ConversationEditTarget } from "./product-projection-hook-invocation-row-content.js";
export type { ConversationRowTargetAction } from "./product-projection-hook-invocation-row-content.js";
export type { ConversationRowTargetResolution } from "./product-projection-hook-invocation-row-content.js";
