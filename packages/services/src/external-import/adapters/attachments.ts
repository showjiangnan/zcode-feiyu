// Modified by ZCode Feiyu.
import { readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExternalHistoryMessage } from "@zcode/shared";
import { atomicPrivateFile } from "./privateState.js";
import { isCredentialFileName } from "./resourceFiles.js";
import { containedPath, digest } from "./sourceFiles.js";

export async function materializeAttachments(
  messages: ExternalHistoryMessage[],
  options: {
    directory: string;
    sourceRoot: string;
    workspacePath: string;
    warnings: string[];
    signal: AbortSignal;
  },
): Promise<void> {
  for (const message of messages)
    for (const block of message.blocks.flatMap((item) =>
      item.type === "tool" ? (item.attachments ?? []) : [item],
    )) {
      options.signal.throwIfAborted();
      if (block.type !== "file") continue;
      try {
        let bytes: Buffer;
        if (block.url.startsWith("data:")) {
          const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/u.exec(block.url);
          if (!match) throw new Error("unsupported_inline_attachment");
          bytes = Buffer.from(match[2]!, "base64");
          block.mime = match[1]!;
        } else {
          if (/^https?:/iu.test(block.url)) throw new Error("remote_attachment_not_downloaded");
          const path = block.url.startsWith("file:")
            ? fileURLToPath(block.url)
            : isAbsolute(block.url)
              ? block.url
              : resolve(options.workspacePath, block.url);
          let verified: string;
          try {
            verified = await containedPath(options.sourceRoot, path);
          } catch {
            verified = await containedPath(options.workspacePath, path);
          }
          if (isCredentialFileName(basename(verified))) throw new Error("requires_reauthorization");
          bytes = await readFile(await realpath(verified));
        }
        const name = basename(block.filename).replace(/[^\p{L}\p{N}._-]/gu, "_") || "attachment";
        const path = join(
          options.directory,
          "attachments",
          `${digest(bytes.toString("base64"))}-${name}`,
        );
        await atomicPrivateFile(path, bytes);
        block.filename = name;
        block.url = pathToFileURL(path).href;
      } catch (error) {
        options.warnings.push(error instanceof Error ? error.message : "attachment_missing");
        // 失效附件不能混入下一轮模型输入；在历史正文保留准确的缺失说明。
        message.content += `\n[Attachment unavailable: ${block.filename}]`;
        message.blocks = message.blocks.filter((item) => item !== block);
        for (const item of message.blocks)
          if (item.type === "tool" && item.attachments)
            item.attachments = item.attachments.filter((attachment) => attachment !== block);
      }
    }
}
