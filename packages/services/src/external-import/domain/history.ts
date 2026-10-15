// Modified by ZCode Feiyu.
import type { ExternalHistoryMessage } from "@zcode/shared";

export type RecordValue = Record<string, unknown>;
export function object(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : {};
}
export function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
export function timestamp(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value))
    return value < 1e11 ? value * 1000 : value;
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}
export function printable(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? "");
}
export class HistoryBuilder {
  constructor(readonly fallbackTime = 0) {}
  messages: ExternalHistoryMessage[] = [];
  warnings = new Set<string>();
  workspacePath = "";
  sessionId = "";
  title = "";
  running = false;
  child = false;
  model: string | undefined;
  readonly fallbackMessages: ExternalHistoryMessage[] = [];
  readonly sourceParents = new Map<string, { parent: string | null; ids: Set<string> }>();
  private currentRecord: string | undefined;
  private lastRecord: string | undefined;
  private readonly ids = new Map<string, ExternalHistoryMessage>();
  readonly calls = new Map<
    string,
    Extract<ExternalHistoryMessage["blocks"][number], { type: "tool" }>
  >();
  add(message: ExternalHistoryMessage): void {
    if (!message.content && message.blocks.length === 0) return;
    if (this.currentRecord) this.sourceParents.get(this.currentRecord)?.ids.add(message.id);
    const existing = this.ids.get(message.id);
    if (existing) {
      // 同一来源消息的镜像/重写只更新原位置，不重复添加时间线。
      Object.assign(existing, message);
    } else {
      this.ids.set(message.id, message);
      this.messages.push(message);
    }
  }
  call(id: string, name: string, input: unknown, at: number, separateMessage = true) {
    const block: Extract<ExternalHistoryMessage["blocks"][number], { type: "tool" }> = {
      type: "tool" as const,
      callId: id,
      name,
      input: object(input),
      output: "",
      status: "interrupted" as const,
    };
    this.calls.set(id, block);
    if (separateMessage)
      this.add({
        id: `tool:${id}`,
        role: "assistant",
        content: "",
        timestamp: at,
        model: this.model,
        blocks: [block],
      });
    return block;
  }
  output(
    id: string,
    value: unknown,
    failed = false,
    attachments?: Extract<ExternalHistoryMessage["blocks"][number], { type: "file" }>[],
  ): void {
    const block = this.calls.get(id);
    if (block) {
      block.output = printable(value);
      if (attachments?.length) block.attachments = attachments;
      block.status = failed ? "error" : "completed";
    } else {
      this.warnings.add("unmatched_tool_result");
      this.add({
        id: `orphan:${id}`,
        role: "assistant",
        content: `[Unmatched tool result: ${id}]\n${printable(value)}`,
        timestamp: this.messages.at(-1)?.timestamp ?? 0,
        blocks: [],
      });
    }
  }
  rollback(turns: number): void {
    let remaining = Math.max(0, Math.trunc(turns));
    let index = this.messages.length;
    while (index > 0 && remaining > 0) {
      index--;
      if (this.messages[index]?.role === "user") remaining--;
    }
    this.messages.splice(index);
    this.reindex();
    this.warnings.add("source_rollback_applied");
  }
  reset(): void {
    this.messages.length = 0;
    this.ids.clear();
    this.calls.clear();
    this.fallbackMessages.length = 0;
  }
  private reindex(): void {
    this.ids.clear();
    this.calls.clear();
    for (const message of this.messages) {
      this.ids.set(message.id, message);
      for (const block of message.blocks)
        if (block.type === "tool") this.calls.set(block.callId, block);
    }
  }
  beginRecord(id: string, parent: string | null): void {
    this.currentRecord = id;
    this.lastRecord = id;
    if (!this.sourceParents.has(id)) this.sourceParents.set(id, { parent, ids: new Set() });
  }
  endRecord(): void {
    this.currentRecord = undefined;
  }
  finalize(): void {
    if (!this.messages.length && this.fallbackMessages.length)
      for (const message of this.fallbackMessages) this.add(message);
    if (!this.lastRecord || !this.sourceParents.size) return;
    const accepted = new Set<string>();
    const visited = new Set<string>();
    let id: string | null = this.lastRecord;
    while (id) {
      if (visited.has(id)) {
        this.warnings.add("source_parent_cycle");
        break;
      }
      visited.add(id);
      const node = this.sourceParents.get(id);
      if (!node) {
        this.warnings.add("source_parent_missing");
        break;
      }
      for (const value of node.ids) accepted.add(value);
      id = node.parent;
    }
    this.messages = this.messages.filter((message) => accepted.has(message.id));
    this.reindex();
  }
}
