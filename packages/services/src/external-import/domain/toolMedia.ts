// Modified by ZCode Feiyu.
import type { ExternalHistoryMessage } from "@zcode/shared";
import { object, printable, text } from "./history.js";
export function readHistoricalToolOutput(value: unknown): {
  output: unknown;
  attachments: Extract<ExternalHistoryMessage["blocks"][number], { type: "file" }>[];
} {
  let content = value;
  if (typeof value === "string" && value.trimStart().startsWith("[")) {
    try {
      content = JSON.parse(value);
    } catch {
      return { output: value, attachments: [] };
    }
  }
  const attachments: Extract<ExternalHistoryMessage["blocks"][number], { type: "file" }>[] = [];
  if (!Array.isArray(content)) return { output: value, attachments };
  const output = content
    .map((item) => {
      const part = object(item);
      const source = object(part.source);
      if (part.type === "image" || part.type === "input_image") {
        const mime = text(part.mimeType) || text(source.media_type) || "image/png";
        const url =
          text(part.image_url) ||
          text(object(part.image_url).url) ||
          text(part.url) ||
          (part.data || source.data
            ? `data:${mime};base64,${text(part.data) || text(source.data)}`
            : "");
        if (url) {
          const filename = text(part.filename) || `tool-image-${attachments.length + 1}`;
          attachments.push({ type: "file", mime, filename, url });
          return `[Tool image: ${filename}]`;
        }
      }
      return part.type === "text" ? text(part.text) : printable(item);
    })
    .join("\n");
  return { output: attachments.length ? output : value, attachments };
}
