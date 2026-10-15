// Modified by ZCode Feiyu.
import type { ExternalHistoryMessage } from "@zcode/shared";
import { readHistoricalToolOutput } from "./toolMedia.js";
import { HistoryBuilder, object, text, timestamp, printable } from "./history.js";

export function consumeResponseRecord(
  builder: HistoryBuilder,
  record: Record<string, unknown>,
  line: number,
): void {
  const payload = object(record.payload);
  const at = timestamp(record.timestamp, builder.fallbackTime + line);
  if (record.type === "session_meta") {
    builder.workspacePath = text(payload.cwd);
    builder.sessionId = text(payload.id) || text(payload.session_id);
    const source = object(payload.source);
    const threadSource = object(payload.thread_source);
    builder.child = Boolean(
      source.subagent ||
      threadSource.subagent ||
      source.type === "subagent" ||
      threadSource.type === "subagent" ||
      text(payload.source) === "subagent" ||
      text(payload.thread_source) === "subagent",
    );
    if (payload.history_base) builder.warnings.add("source_history_base_requires_available_parent");
    return;
  }
  if (record.type === "turn_context") {
    builder.model = text(payload.model) || builder.model;
    return;
  }
  if (record.type === "event_msg") {
    if (payload.type === "user_message" || payload.type === "agent_message") {
      const content = text(payload.message) || text(payload.text);
      if (content)
        builder.fallbackMessages.push({
          id: `event:${line}`,
          role: payload.type === "user_message" ? "user" : "assistant",
          content,
          timestamp: at,
          blocks: [],
        });
    }
    if (payload.type === "task_started") builder.running = true;
    if (payload.type === "task_complete" || payload.type === "turn_aborted")
      builder.running = false;
    if (payload.type === "thread_rolled_back") {
      const count = Number(payload.num_turns ?? 0);
      if (Number.isSafeInteger(count) && count >= 0) builder.rollback(count);
      else builder.warnings.add("source_rollback_invalid");
    }
    return;
  }
  if (record.type === "compacted") {
    builder.warnings.add("source_compaction_recorded");
    if (Array.isArray(payload.replacement_history)) {
      builder.reset();
      for (const [index, item] of payload.replacement_history.entries())
        consumeResponseRecord(
          builder,
          { type: "response_item", timestamp: record.timestamp, payload: item },
          line + index,
        );
    }
    return;
  }
  if (record.type !== "response_item") return;
  if (!record.timestamp) builder.warnings.add("source_timestamp_unavailable");
  const id = text(payload.id) || `record:${builder.sessionId}:${record.ordinal ?? line}`;
  if (payload.type === "message" && (payload.role === "user" || payload.role === "assistant")) {
    const blocks: ExternalHistoryMessage["blocks"] = [];
    const parts: string[] = [];
    for (const value of Array.isArray(payload.content) ? payload.content : []) {
      const part = object(value);
      if (part.type === "input_text" || part.type === "output_text" || part.type === "text")
        parts.push(text(part.text));
      else if (part.type === "input_image" || part.type === "image") {
        const url = text(part.image_url) || text(object(part.image_url).url) || text(part.url);
        blocks.push({ type: "file", mime: "image/png", filename: "image.png", url });
      } else if (part.type === "input_file" || part.type === "file") {
        blocks.push({
          type: "file",
          mime: text(part.mime_type) || "application/octet-stream",
          filename: text(part.filename) || "document",
          url: text(part.file_data) || text(part.file_url) || text(part.url),
        });
      } else builder.warnings.add(`unsupported_content:${text(part.type) || "unknown"}`);
    }
    builder.add({
      id,
      role: payload.role,
      content: parts.join("\n"),
      timestamp: at,
      phase: text(payload.phase) || undefined,
      model: builder.model,
      blocks,
    });
  } else if (payload.type === "function_call" || payload.type === "custom_tool_call") {
    let input: unknown = payload.arguments ?? payload.input;
    if (typeof input === "string") {
      try {
        input = JSON.parse(input);
      } catch {
        input = { raw: input };
      }
    }
    const name = [text(payload.namespace), text(payload.name)].filter(Boolean).join(".");
    builder.call(text(payload.call_id) || id, name, input, at);
  } else if (
    payload.type === "function_call_output" ||
    payload.type === "custom_tool_call_output"
  ) {
    const result = readHistoricalToolOutput(payload.output);
    builder.output(
      text(payload.call_id),
      result.output,
      payload.is_error === true || payload.status === "failed",
      result.attachments,
    );
  } else if (payload.type === "reasoning") {
    const summary = (Array.isArray(payload.summary) ? payload.summary : [])
      .map((value) => text(object(value).text))
      .filter(Boolean)
      .join("\n");
    if (summary)
      builder.add({
        id,
        role: "assistant",
        content: "",
        timestamp: at,
        blocks: [{ type: "reasoning", text: summary }],
      });
    if (payload.encrypted_content) builder.warnings.add("encrypted_reasoning_not_imported");
  } else if (payload.type) builder.warnings.add(`unsupported_response:${printable(payload.type)}`);
}
