export type RunPhase = "idle" | "running" | "completed" | "compacting" | "goalVerifying";
export type QueueState = "empty" | "text" | "goal" | "compact" | "mixed";
export type CompactMemory = "never" | "compactable" | "justCompacted" | "notNeeded";
export type GoalState = "none" | "active" | "verifying" | "verified" | "failed";
export type TurnTarget = "latest" | "old" | "none";
export type CandidateKind = "user" | "system";
// held 状态输入不静默入队，
// 由用户选择「清空 queue 后发送 / 保留 queue 立即发送」。
export type DecisionKind = "allow" | "reject" | "enqueue" | "choice" | "system" | "undefined";
export type NodeKind = "state" | "candidate" | "guard" | "effect" | "case" | "summary";

export interface ProductContext {
  readonly runPhase: RunPhase;
  readonly queue: QueueState;
  readonly compactMemory: CompactMemory;
  readonly canCompactAgain: boolean;
  readonly goal: GoalState;
  readonly selectedTurn: TurnTarget;
  readonly forked: boolean;
}

export interface Candidate {
  readonly id: string;
  readonly kind: CandidateKind;
  readonly label: string;
  readonly target: TurnTarget;
  readonly surface: string;
}

export interface Decision {
  readonly kind: DecisionKind;
  readonly ruleId: string;
  readonly title: string;
  readonly reason: string;
  readonly next?: ProductContext;
  readonly assertion: string;
}

export interface TraceNode {
  readonly id: string;
  readonly kind: NodeKind;
  readonly title: string;
  readonly subtitle: string;
  readonly detail: string;
  readonly context: ProductContext;
  readonly candidate?: Candidate;
  readonly decision?: Decision;
  readonly caseId?: string;
  readonly e2e?: string;
  readonly children: TraceNode[];
}

export interface TraceStats {
  readonly nodes: number;
  readonly cases: number;
  readonly rejects: number;
  readonly undefined: number;
  readonly enqueued: number;
  readonly allowed: number;
  readonly choices: number;
  readonly system: number;
}

export interface ModelProfile {
  readonly id: string;
  readonly label: string;
  readonly context: ProductContext;
}

export const profiles: ModelProfile[] = [
  {
    id: "running",
    label: "running：消息发送中",
    context: {
      runPhase: "running",
      queue: "empty",
      compactMemory: "compactable",
      canCompactAgain: true,
      goal: "active",
      selectedTurn: "latest",
      forked: false,
    },
  },
  {
    id: "completed",
    label: "completed：消息已完成",
    context: {
      runPhase: "completed",
      queue: "empty",
      compactMemory: "compactable",
      canCompactAgain: true,
      goal: "active",
      selectedTurn: "latest",
      forked: false,
    },
  },
  {
    id: "goal-verifying",
    label: "goalVerifying：goal 验证中",
    context: {
      runPhase: "goalVerifying",
      queue: "empty",
      compactMemory: "compactable",
      canCompactAgain: true,
      goal: "verifying",
      selectedTurn: "latest",
      forked: false,
    },
  },
  {
    id: "compacting",
    label: "compacting：正在 compact",
    context: {
      runPhase: "compacting",
      queue: "empty",
      compactMemory: "compactable",
      canCompactAgain: true,
      goal: "active",
      selectedTurn: "latest",
      forked: false,
    },
  },
  {
    id: "just-compacted-noop",
    label: "justCompacted：刚压缩完，不需要继续压缩",
    context: {
      runPhase: "completed",
      queue: "empty",
      compactMemory: "justCompacted",
      canCompactAgain: false,
      goal: "active",
      selectedTurn: "latest",
      forked: false,
    },
  },
  {
    id: "just-compacted-more",
    label: "justCompacted：刚压缩完，但还能继续压缩",
    context: {
      runPhase: "completed",
      queue: "empty",
      compactMemory: "justCompacted",
      canCompactAgain: true,
      goal: "active",
      selectedTurn: "latest",
      forked: false,
    },
  },
];

export const userCandidates: Candidate[] = [
  { id: "sendText", kind: "user", label: "继续发送文字", target: "none", surface: "composer" },
  { id: "slashCompact", kind: "user", label: "输入 /compact", target: "none", surface: "composer" },
  { id: "setGoal", kind: "user", label: "设置 goal", target: "none", surface: "goal control" },
  { id: "compact", kind: "user", label: "点击 compact", target: "none", surface: "toolbar" },
  {
    id: "forkLatest",
    kind: "user",
    label: "fork 最新轮次",
    target: "latest",
    surface: "turn actions",
  },
  { id: "forkOld", kind: "user", label: "fork 老轮次", target: "old", surface: "turn actions" },
  {
    id: "editLatest",
    kind: "user",
    label: "编辑最新 query",
    target: "latest",
    surface: "message actions",
  },
  { id: "editOld", kind: "user", label: "编辑老 query", target: "old", surface: "message actions" },
];

const systemCandidates: Candidate[] = [
  {
    id: "assistantComplete",
    kind: "system",
    label: "assistant 完成当前 run",
    target: "none",
    surface: "runtime event",
  },
  {
    id: "compactComplete",
    kind: "system",
    label: "compact 完成",
    target: "none",
    surface: "runtime event",
  },
  {
    id: "compactNoop",
    kind: "system",
    label: "compact 判断不需要继续",
    target: "none",
    surface: "runtime event",
  },
  {
    id: "goalVerifyStart",
    kind: "system",
    label: "开始 goal 验证",
    target: "none",
    surface: "goal runtime",
  },
  {
    id: "goalVerifyPass",
    kind: "system",
    label: "goal 验证通过",
    target: "none",
    surface: "goal runtime",
  },
  {
    id: "goalVerifyFail",
    kind: "system",
    label: "goal 验证失败",
    target: "none",
    surface: "goal runtime",
  },
];

let nextNodeId = 0;
let nextCaseId = 0;

export function resetIds(): void {
  nextNodeId = 0;
  nextCaseId = 0;
}

export function contextLabel(context: ProductContext): string {
  return [
    `phase=${context.runPhase}`,
    `queue=${context.queue}`,
    `compact=${context.compactMemory}`,
    context.canCompactAgain ? "canCompactAgain" : "cannotCompactAgain",
    `goal=${context.goal}`,
    `turn=${context.selectedTurn}`,
    context.forked ? "forked" : "notForked",
  ].join(" / ");
}

export function contextKey(context: ProductContext): string {
  return [
    context.runPhase,
    context.queue,
    context.compactMemory,
    String(context.canCompactAgain),
    context.goal,
    context.selectedTurn,
    String(context.forked),
  ].join("|");
}

export function enumerateCandidates(context: ProductContext): Candidate[] {
  const events = systemCandidates.filter((candidate) =>
    isSystemCandidateApplicable(context, candidate),
  );
  return [...userCandidates, ...events];
}

export function buildTraceTree(context: ProductContext, maxRounds: number): TraceNode {
  resetIds();
  return buildStateNode(context, 1, maxRounds, new Map());
}

export function collectStats(root: TraceNode): TraceStats {
  const stats = {
    nodes: 0,
    cases: 0,
    rejects: 0,
    undefined: 0,
    enqueued: 0,
    allowed: 0,
    choices: 0,
    system: 0,
  };

  visit(root, (node) => {
    stats.nodes += 1;
    if (node.kind === "case") {
      stats.cases += 1;
    }
    if (node.decision?.kind === "reject") {
      stats.rejects += 1;
    }
    if (node.decision?.kind === "undefined") {
      stats.undefined += 1;
    }
    if (node.decision?.kind === "enqueue") {
      stats.enqueued += 1;
    }
    if (node.decision?.kind === "allow") {
      stats.allowed += 1;
    }
    if (node.decision?.kind === "choice") {
      stats.choices += 1;
    }
    if (node.decision?.kind === "system") {
      stats.system += 1;
    }
  });

  return stats;
}

export function flatten(root: TraceNode): TraceNode[] {
  const nodes: TraceNode[] = [];
  visit(root, (node) => nodes.push(node));
  return nodes;
}

export function decisionLabel(decision: Decision): string {
  if (decision.kind === "reject") {
    return `reject · ${decision.title}`;
  }
  if (decision.kind === "enqueue") {
    return `enqueue · ${decision.title}`;
  }
  if (decision.kind === "allow") {
    return `allow · ${decision.title}`;
  }
  if (decision.kind === "choice") {
    return `choice · ${decision.title}`;
  }
  if (decision.kind === "system") {
    return `system · ${decision.title}`;
  }
  return `undefined · ${decision.title}`;
}

function visit(node: TraceNode, fn: (node: TraceNode) => void): void {
  fn(node);
  for (const child of node.children) {
    visit(child, fn);
  }
}

function buildStateNode(
  context: ProductContext,
  round: number,
  maxRounds: number,
  seen: Map<string, number>,
): TraceNode {
  const node = makeNode({
    kind: "state",
    title: `S${round}: ${context.runPhase}`,
    subtitle: contextLabel(context),
    detail: "可见产品上下文。下一层会对所有候选动作做笛卡尔积枚举，再用产品 guard 剪枝。",
    context,
    children: [],
  });

  if (round > maxRounds) {
    return makeCaseNode(
      node,
      "到达轮次上限",
      "这条 trace 已到达当前枚举深度，需要人工 review 是否继续展开。",
    );
  }

  const loopKey = `${round}:${contextKey(context)}`;
  const visited = seen.get(loopKey) ?? 0;
  if (visited > 1) {
    return makeCaseNode(node, "重复上下文", "模型再次到达相同上下文；这里应判断是否合并为等价类。");
  }
  const nextSeen = new Map(seen);
  nextSeen.set(loopKey, visited + 1);

  node.children.push(
    ...enumerateCandidates(context).map((candidate) =>
      buildCandidateNode(context, candidate, round, maxRounds, nextSeen),
    ),
  );
  return node;
}

function buildCandidateNode(
  context: ProductContext,
  candidate: Candidate,
  round: number,
  maxRounds: number,
  seen: Map<string, number>,
): TraceNode {
  const decision = evaluate(context, candidate);
  const candidateNode = makeNode({
    kind: "candidate",
    title: candidate.label,
    subtitle: `${candidate.kind} / ${candidate.surface}`,
    detail: `候选组合：${contextLabel(context)} × ${candidate.label}`,
    context,
    candidate,
    children: [],
  });
  const guardNode = makeNode({
    kind: "guard",
    title: decisionLabel(decision),
    subtitle: decision.ruleId,
    detail: decision.reason,
    context,
    candidate,
    decision,
    children: [],
  });
  const effectNode = makeNode({
    kind: "effect",
    title: effectTitle(decision),
    subtitle: decision.assertion,
    detail: decision.next
      ? contextLabel(decision.next)
      : "无下一状态：路径在这里被剪枝或等待产品定义。",
    context: decision.next ?? context,
    candidate,
    decision,
    children: [],
  });

  // choice 不展开下一状态：clear/keep 两个 disposition 都终到 completedCanSend 路径。
  if (
    decision.next &&
    decision.kind !== "reject" &&
    decision.kind !== "undefined" &&
    decision.kind !== "choice"
  ) {
    effectNode.children.push(buildStateNode(decision.next, round + 1, maxRounds, seen));
  } else {
    effectNode.children.push(
      makeCaseNode(effectNode, decision.title, decision.assertion, candidate, decision),
    );
  }

  guardNode.children.push(effectNode);
  candidateNode.children.push(guardNode);
  return candidateNode;
}

function makeCaseNode(
  base: TraceNode,
  title: string,
  detail: string,
  candidate?: Candidate,
  decision?: Decision,
): TraceNode {
  nextCaseId += 1;
  const caseId = `CASE-${String(nextCaseId).padStart(5, "0")}`;
  return makeNode({
    kind: "case",
    title: caseId,
    subtitle: title,
    detail,
    context: base.context,
    candidate,
    decision,
    caseId,
    e2e: buildE2eAssertion(base.context, candidate, decision),
    children: [],
  });
}

function makeNode(input: Omit<TraceNode, "id">): TraceNode {
  nextNodeId += 1;
  return {
    ...input,
    id: `n-${nextNodeId}`,
  };
}

function effectTitle(decision: Decision): string {
  if (decision.kind === "reject") {
    return "剪枝：显示明确拒绝";
  }
  if (decision.kind === "enqueue") {
    return "副作用：进入消息队列";
  }
  if (decision.kind === "allow") {
    return "副作用：动作生效";
  }
  if (decision.kind === "system") {
    return "系统事件：推进阶段";
  }
  if (decision.kind === "choice") {
    return "阻塞：等待用户裁决 queue disposition";
  }
  return "未定义：需要产品 review";
}

// 导出为可执行裁决表（02-projection「规则模块下沉」）：
// CLI 投影的 guard 派生必须与本函数逐条一致，由 bootstrap 的
// formal-proof-consistency 黄金测试机械背书。
export function evaluate(context: ProductContext, candidate: Candidate): Decision {
  if (candidate.kind === "system") {
    return evaluateSystem(context, candidate);
  }

  if (context.runPhase === "running") {
    return evaluateRunning(context, candidate);
  }
  if (context.runPhase === "compacting") {
    return evaluateCompacting(context, candidate);
  }
  if (context.runPhase === "goalVerifying") {
    return evaluateGoalVerifying(context, candidate);
  }
  if (context.runPhase === "completed") {
    return evaluateCompleted(context, candidate);
  }
  return evaluateIdle(context, candidate);
}

function evaluateRunning(context: ProductContext, candidate: Candidate): Decision {
  if (candidate.id === "sendText") {
    return enqueue(
      context,
      candidate,
      "queueTextWhileRunning",
      "running 时继续发文字进入消息队列。",
    );
  }
  if (candidate.id === "setGoal") {
    return enqueue(
      context,
      candidate,
      "queueGoalWhileRunning",
      "running 时设置 goal 进入消息队列。",
    );
  }
  if (candidate.id === "slashCompact" || candidate.id === "compact") {
    return enqueue(
      context,
      candidate,
      "runningCompactQueues",
      "running 时 compact 作为维护意图进入 FIFO。",
    );
  }
  if (candidate.id === "forkLatest" || candidate.id === "forkOld") {
    return reject(context, "runningCannotFork", "运行中不能 fork", "最新轮次和老轮次都不能 fork。");
  }
  if (candidate.id === "editLatest" || candidate.id === "editOld") {
    return reject(
      context,
      "runningCannotEditQuery",
      "运行中不能编辑 query",
      "发送过程中最新 query 和历史 query 都不能编辑。",
    );
  }
  return undefinedDecision(context, candidate, "runningUnhandled");
}

function evaluateCompacting(context: ProductContext, candidate: Candidate): Decision {
  if (candidate.id === "compact" || candidate.id === "slashCompact") {
    return reject(
      context,
      "compactingCannotCompact",
      "正在 compact，不能再次 compact",
      "必须去重或禁用入口。",
    );
  }
  // 重裁决（compactingAcceptsFutureInput）：
  // compact 是维护步骤，用户输入是未来意图 → 入队，不打断 compact。
  if (candidate.id === "sendText" || candidate.id === "setGoal") {
    return enqueue(
      context,
      candidate,
      "compactingAcceptsFutureInput",
      "compacting 时输入追加 queue，不打断 compact。",
    );
  }
  if (candidate.id === "forkLatest" || candidate.id === "forkOld") {
    return reject(
      context,
      "compactingCannotFork",
      "正在 compact，不能 fork",
      "避免 fork 到半压缩上下文。",
    );
  }
  return undefinedDecision(context, candidate, "compactingUnhandled");
}

function evaluateGoalVerifying(context: ProductContext, candidate: Candidate): Decision {
  if (candidate.id === "compact" || candidate.id === "slashCompact") {
    return enqueue(
      context,
      candidate,
      "goalVerifierAcceptsFutureInput",
      "goal verifier 中 compact 追加 queue，不打断验证。",
    );
  }
  if (candidate.id === "sendText" || candidate.id === "setGoal") {
    return enqueue(
      context,
      candidate,
      "goalVerifierAcceptsFutureInput",
      "goal verifier 中输入追加 queue，不打断验证。",
    );
  }
  if (candidate.id === "forkLatest" || candidate.id === "forkOld") {
    return reject(
      context,
      "goalVerifyingCannotFork",
      "goal 验证中不能 fork",
      "验证阶段 fork 会破坏结果归属。",
    );
  }
  return undefinedDecision(context, candidate, "goalVerifyingUnhandled");
}

function evaluateCompleted(context: ProductContext, candidate: Candidate): Decision {
  if (candidate.id === "forkLatest" || candidate.id === "forkOld") {
    return allow(context, "completedCanFork", "完成后可以 fork", {
      ...context,
      forked: true,
      selectedTurn: candidate.target,
    });
  }
  if (candidate.id === "compact" || candidate.id === "slashCompact") {
    if (context.queue !== "empty") {
      return enqueue(
        context,
        candidate,
        "heldCompactQueues",
        "held queue 下 compact 追加队尾，不绕过未来意图。",
      );
    }
    if (context.compactMemory === "justCompacted" && !context.canCompactAgain) {
      return reject(
        context,
        "justCompactedNoNeed",
        "刚压缩完，不需要压缩",
        "compact 可以被点击，但模型返回 noop 提示。",
      );
    }
    return allow(context, "completedCanCompact", "完成后可以 compact", {
      ...context,
      runPhase: "compacting",
      compactMemory: "compactable",
    });
  }
  // held 判定：completed 下仍滞留的 queue 只可能是 autoDrain=false 的 held queue
  // （autoDrain=true 时 assistantComplete 即消费，completed+queue>0 不持久存在）。
  // 重裁决（heldQueueInputRequiresChoice，替代原 heldQueueCapturesNewInput）：
  // held 下输入不静默入队，由用户选择 clear/keep queue 后发送。
  if (candidate.id === "sendText") {
    if (context.queue !== "empty") {
      return choice(
        context,
        "heldQueueInputRequiresChoice",
        "held queue 下发送需用户裁决",
        "呈现「清空 queue 后发送 / 保留 queue 立即发送」，disposition 随 command 上行。",
      );
    }
    return allow(context, "completedCanSend", "完成后继续发送", {
      ...context,
      runPhase: "running",
      queue: "empty",
    });
  }
  if (candidate.id === "setGoal") {
    if (context.queue !== "empty") {
      return choice(
        context,
        "heldQueueInputRequiresChoice",
        "held queue 下设置 goal 需用户裁决",
        "同 sendText：composer 输入统一走 choice。",
      );
    }
    return allow(context, "completedCanSetGoal", "完成后可以设置 goal", {
      ...context,
      goal: "active",
    });
  }
  return undefinedDecision(context, candidate, "completedUnhandled");
}

function evaluateIdle(context: ProductContext, candidate: Candidate): Decision {
  if (candidate.id === "sendText") {
    return allow(context, "idleCanSend", "idle 时发送消息", {
      ...context,
      runPhase: "running",
      queue: "empty",
    });
  }
  if (candidate.id === "setGoal") {
    return allow(context, "idleCanSetGoal", "idle 时设置 goal", {
      ...context,
      goal: "active",
    });
  }
  if (candidate.id === "compact" || candidate.id === "slashCompact") {
    return reject(
      context,
      "idleCannotCompact",
      "没有可压缩上下文",
      "没有完成消息时 compact 应禁用或提示。",
    );
  }
  if (candidate.id === "forkLatest" || candidate.id === "forkOld") {
    return reject(context, "idleCannotFork", "没有可 fork 轮次", "没有完成轮次时 fork 应禁用。");
  }
  if (candidate.id === "editLatest" || candidate.id === "editOld") {
    return reject(
      context,
      "idleCannotEdit",
      "没有可编辑 query",
      "没有 query 时编辑入口不应该出现。",
    );
  }
  return undefinedDecision(context, candidate, "idleUnhandled");
}

function evaluateSystem(context: ProductContext, candidate: Candidate): Decision {
  if (candidate.id === "assistantComplete") {
    return systemTransition(
      context,
      "assistantComplete",
      "assistant 完成",
      drainQueueAfterRun(context),
    );
  }
  if (candidate.id === "compactComplete") {
    return systemTransition(context, "compactComplete", "compact 完成", {
      ...context,
      runPhase: "completed",
      compactMemory: "justCompacted",
      canCompactAgain: true,
    });
  }
  if (candidate.id === "compactNoop") {
    return systemTransition(context, "compactNoop", "compact 判断无需继续", {
      ...context,
      runPhase: "completed",
      compactMemory: "justCompacted",
      canCompactAgain: false,
    });
  }
  if (candidate.id === "goalVerifyStart") {
    return systemTransition(context, "goalVerifyStart", "进入 goal 验证", {
      ...context,
      runPhase: "goalVerifying",
      goal: "verifying",
    });
  }
  if (candidate.id === "goalVerifyPass") {
    return systemTransition(context, "goalVerifyPass", "goal 验证通过", {
      ...context,
      runPhase: "completed",
      goal: "verified",
    });
  }
  return systemTransition(context, "goalVerifyFail", "goal 验证失败", {
    ...context,
    runPhase: "completed",
    goal: "failed",
  });
}

function isSystemCandidateApplicable(context: ProductContext, candidate: Candidate): boolean {
  if (candidate.id === "assistantComplete") {
    return context.runPhase === "running";
  }
  if (candidate.id === "compactComplete" || candidate.id === "compactNoop") {
    return context.runPhase === "compacting";
  }
  if (candidate.id === "goalVerifyStart") {
    return context.runPhase === "completed" && context.goal === "active";
  }
  if (candidate.id === "goalVerifyPass" || candidate.id === "goalVerifyFail") {
    return context.runPhase === "goalVerifying";
  }
  return false;
}

function allow(
  context: ProductContext,
  ruleId: string,
  title: string,
  next: ProductContext,
): Decision {
  return {
    kind: "allow",
    ruleId,
    title,
    reason: title,
    next,
    assertion: "动作应生效，并且 UI、消息归属、按钮状态与下一上下文一致。",
  };
}

function enqueue(
  context: ProductContext,
  candidate: Candidate,
  ruleId: string,
  reason: string,
): Decision {
  const queued =
    candidate.id === "setGoal"
      ? "goal"
      : candidate.id === "compact" || candidate.id === "slashCompact"
        ? "compact"
        : "text";
  return {
    kind: "enqueue",
    ruleId,
    title: queued === "goal" ? "goal 入队" : queued === "compact" ? "compact 入队" : "文字消息入队",
    reason,
    next: {
      ...context,
      queue: mergeQueue(context.queue, queued),
    },
    assertion:
      queued === "goal"
        ? "队列里必须保留 goal 意图。"
        : queued === "compact"
          ? "队列里必须保留 compact 维护意图，且不能生成 user row。"
          : "队列里必须保留用户文字消息。",
  };
}

function choice(context: ProductContext, ruleId: string, title: string, reason: string): Decision {
  return {
    kind: "choice",
    ruleId,
    title,
    reason,
    // 无 next：状态直到用户提交 disposition 才推进（clear/keep 都终到 startNow）。
    next: context,
    assertion: "必须呈现明确选择，用户裁决前不得入队、不得发送。",
  };
}

function reject(context: ProductContext, ruleId: string, title: string, reason: string): Decision {
  return {
    kind: "reject",
    ruleId,
    title,
    reason,
    assertion: "这条路径必须显示明确反馈，并且不能产生被禁止的副作用。",
    next: context,
  };
}

function systemTransition(
  context: ProductContext,
  ruleId: string,
  title: string,
  next: ProductContext,
): Decision {
  return {
    kind: "system",
    ruleId,
    title,
    reason: "系统异步事件推进产品状态。",
    next,
    assertion: "系统事件必须按当前 session/run 归属落盘，不能污染其它 trace。",
  };
}

function undefinedDecision(
  context: ProductContext,
  candidate: Candidate,
  ruleId: string,
): Decision {
  return {
    kind: "undefined",
    ruleId,
    title: "产品预期未定义",
    reason: `模型还不知道 ${context.runPhase} + ${candidate.label} 应该 allow、reject 还是 enqueue。`,
    assertion: "需要人工 review：补产品规则、剪枝为 invalid、或标记可忽略。",
  };
}

function mergeQueue(queue: QueueState, item: "text" | "goal" | "compact"): QueueState {
  if (queue === "empty") {
    return item;
  }
  if (queue === item) {
    return queue;
  }
  return "mixed";
}

function drainQueueAfterRun(context: ProductContext): ProductContext {
  if (context.queue === "text") {
    return { ...context, runPhase: "running", queue: "empty" };
  }
  if (context.queue === "goal") {
    return { ...context, runPhase: "completed", queue: "empty", goal: "active" };
  }
  if (context.queue === "compact") {
    return { ...context, runPhase: "compacting", queue: "empty" };
  }
  if (context.queue === "mixed") {
    return { ...context, runPhase: "running", queue: "goal" };
  }
  return {
    ...context,
    runPhase: "completed",
    compactMemory: context.compactMemory === "never" ? "compactable" : context.compactMemory,
  };
}

function buildE2eAssertion(
  context: ProductContext,
  candidate?: Candidate,
  decision?: Decision,
): string {
  if (!candidate || !decision) {
    return "记录当前 trace，并判断是否需要继续展开。";
  }
  if (decision.kind === "reject") {
    return `Given ${contextLabel(context)}, when ${candidate.label}, then show "${decision.title}" and no forbidden side effect occurs.`;
  }
  if (decision.kind === "enqueue") {
    return `Given ${contextLabel(context)}, when ${candidate.label}, then queue state becomes ${decision.next?.queue ?? "unknown"}.`;
  }
  if (decision.kind === "allow") {
    return `Given ${contextLabel(context)}, when ${candidate.label}, then transition to ${decision.next ? contextLabel(decision.next) : "next context"}.`;
  }
  if (decision.kind === "system") {
    return `Given ${contextLabel(context)}, when system emits ${candidate.label}, then reconcile to ${decision.next ? contextLabel(decision.next) : "next context"}.`;
  }
  return `Given ${contextLabel(context)}, when ${candidate.label}, product expectation is undefined and must be reviewed.`;
}
