// Modified by ZCode Feiyu.
import type { ExternalHistoryMessage } from "@zcode/shared";
import { readHistoricalToolOutput } from "./toolMedia.js";
import { HistoryBuilder, object, text, timestamp } from "./history.js";

function consumeRecord(
  builder: HistoryBuilder,
  record: Record<string, unknown>,
  line: number,
): void {
  if (record.isSidechain === true) builder.child = true;
  const message = object(record.message);
  const at = timestamp(record.timestamp, builder.fallbackTime + line);
  const cwd = text(record.cwd);
  if (cwd && !builder.workspacePath) builder.workspacePath = cwd;
  builder.sessionId ||= text(record.sessionId);
  if (record.type === "custom-title") builder.title = text(record.customTitle);
  if (record.type !== "user" && record.type !== "assistant") return;
  if (!record.timestamp) builder.warnings.add("source_timestamp_unavailable");
  if (record.isMeta === true || message.isMeta === true || message.model === "<synthetic>") return;
  builder.model = text(message.model) || builder.model;
  const role = record.type;
  const content: string[] = [];
  const blocks: ExternalHistoryMessage["blocks"] = [];
  const values =
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : Array.isArray(message.content)
        ? message.content
        : [];
  for (const value of values) {
    const part = object(value);
    if (part.type === "text") content.push(text(part.text));
    else if (part.type === "thinking") {
      const thinking = text(part.thinking);
      if (thinking) blocks.push({ type: "reasoning", text: thinking });
    } else if (part.type === "tool_use") {
      blocks.push(
        builder.call(text(part.id) || `call:${line}`, text(part.name), part.input, at, false),
      );
    } else if (part.type === "tool_result") {
      const output = Array.isArray(part.content)
        ? part.content.map((item) => text(object(item).text)).join("\n")
        : part.content;
      const media = readHistoricalToolOutput(part.content);
      builder.output(
        text(part.tool_use_id),
        media.attachments.length ? media.output : output,
        part.is_error === true,
        media.attachments,
      );
    } else if (part.type === "image" || part.type === "document") {
      const source = object(part.source);
      const mime = text(source.media_type) || "application/octet-stream";
      const url =
        source.type === "base64"
          ? `data:${mime};base64,${text(source.data)}`
          : text(source.url) || text(source.path);
      blocks.push({
        type: "file",
        mime,
        filename: text(part.title) || (part.type === "image" ? "image" : "document"),
        url,
      });
    } else builder.warnings.add(`unsupported_content:${text(part.type) || "unknown"}`);
  }
  builder.add({
    id: text(record.uuid) || text(message.id) || `record:${line}`,
    role,
    content: content.join("\n"),
    timestamp: at,
    model: builder.model,
    blocks,
  });
  if (role === "assistant") builder.running = message.stop_reason === "tool_use";
}

export function consumeProjectRecord(
  builder: HistoryBuilder,
  record: Record<string, unknown>,
  line: number,
): void {
  const id = text(record.uuid);
  if (id && "parentUuid" in record && (record.type === "user" || record.type === "assistant"))
    builder.beginRecord(id, text(record.parentUuid) || null);
  try {
    consumeRecord(builder, record, line);
  } finally {
    builder.endRecord();
  }
}
