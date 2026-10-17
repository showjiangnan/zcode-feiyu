// Modified by ZCode Feiyu.
import type { SuggestedPromptState } from "@zcode/shared";

interface SuggestedPromptPorts {
  available(): boolean;
  idle(): boolean;
  persist(enabled: boolean): Promise<void>;
  publish(state: SuggestedPromptState): Promise<void>;
  generate(turnId: string, signal: AbortSignal): Promise<string | null>;
  onError(error: unknown): void;
}

/** 每个 Runtime 一个 owner；读取、开启和重连不会生成，只有成功边界能排入候选。 */
export class SuggestedPromptController {
  private state: SuggestedPromptState;
  private generation = 0;
  private pendingTurnId?: string;
  private attemptedTurnId?: string;
  private abort?: AbortController;
  private stopping = false;
  private readonly tasks = new Set<Promise<void>>();
  private publication = Promise.resolve();
  private mutation = Promise.resolve();

  constructor(
    enabled: boolean,
    private readonly ports: SuggestedPromptPorts,
  ) {
    this.state = { enabled, available: ports.available(), revision: 0, phase: "off" };
    this.state.phase = this.waitingPhase();
  }

  getState(): SuggestedPromptState {
    return { ...this.state, available: this.ports.available() };
  }

  setEnabled(enabled: boolean): Promise<void> {
    const operation = this.mutation.then(async () => {
      if (this.state.enabled === enabled) return;
      // 同意与执行门禁独立：草稿确认后全局撤权不能阻塞首输入；执行仍需 available。
      // 保存失败保持原事实；未持久化 draft 由 port 在首输入时补写。
      if (!enabled) {
        // 关闭先中止候选和请求，再等待磁盘；慢写入期间也不能接纳新的预测。
        this.stopping = true;
        this.invalidate();
      }
      try {
        await this.ports.persist(enabled);
        this.state = { ...this.state, enabled };
        this.invalidate(true);
        await this.publication;
      } finally {
        this.stopping = false;
      }
    });
    this.mutation = operation.catch(() => {});
    return operation;
  }

  invalidate(forcePublish = false): void {
    this.generation += 1;
    this.abort?.abort();
    this.pendingTurnId = undefined;
    this.replace({ phase: this.waitingPhase() }, forcePublish);
  }

  completed(turnId: string): void {
    if (
      this.stopping ||
      !this.state.enabled ||
      !this.ports.available() ||
      turnId === this.attemptedTurnId
    )
      return;
    this.pendingTurnId = turnId;
    this.tryStart();
  }

  tryStart(): void {
    const turnId = this.pendingTurnId;
    if (
      this.stopping ||
      !turnId ||
      !this.state.enabled ||
      !this.ports.available() ||
      !this.ports.idle()
    )
      return;
    this.pendingTurnId = undefined;
    this.attemptedTurnId = turnId;
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;
    const generation = ++this.generation;
    this.replace({ phase: "generating", sourceTurnId: turnId });
    // async IO 前固定去重边界；同步抛错同样成为本轮终态，不能由重挂载无限重试。
    const task = Promise.resolve()
      .then(() => this.ports.generate(turnId, abort.signal))
      .then(
        (suggestion) => {
          if (!this.isCurrent(generation, abort)) return;
          this.replace({
            phase: suggestion ? "ready" : "waiting",
            sourceTurnId: turnId,
            ...(suggestion ? { suggestion } : {}),
          });
        },
        (error: unknown) => {
          if (!this.isCurrent(generation, abort)) return;
          this.ports.onError(error);
          this.replace({ phase: "failed", sourceTurnId: turnId });
        },
      )
      .finally(() => {
        this.tasks.delete(task);
      });
    this.tasks.add(task);
  }

  async settle(): Promise<void> {
    await Promise.all(this.tasks);
    await this.publication;
  }

  private isCurrent(generation: number, abort: AbortController): boolean {
    if (generation !== this.generation || abort.signal.aborted) return false;
    if (!this.state.enabled || !this.ports.available() || !this.ports.idle()) {
      this.invalidate();
      return false;
    }
    return true;
  }

  private waitingPhase(): "off" | "waiting" {
    return this.state.enabled && this.ports.available() ? "waiting" : "off";
  }

  private replace(
    next: Pick<SuggestedPromptState, "phase" | "sourceTurnId" | "suggestion">,
    forcePublish = false,
  ): void {
    if (
      !forcePublish &&
      this.state.phase === next.phase &&
      this.state.sourceTurnId === next.sourceTurnId &&
      this.state.suggestion === next.suggestion &&
      this.state.available === this.ports.available()
    )
      return;
    this.state = {
      enabled: this.state.enabled,
      available: this.ports.available(),
      revision: this.state.revision + 1,
      ...next,
    };
    const state = this.getState();
    this.publication = this.publication
      .then(() => this.ports.publish(state))
      .catch(this.ports.onError);
  }
}
