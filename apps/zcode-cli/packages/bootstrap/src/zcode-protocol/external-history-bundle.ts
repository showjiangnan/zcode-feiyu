// Modified by ZCode Feiyu.
import { createHash } from "node:crypto";
import {
  createMessageId,
  createPartId,
  type ExternalImportCommitBundle,
  type SessionId,
  type MessageId,
  type MessagePart,
} from "@zcode/contracts";
import type { ZCodeSessionCreateParams } from "@zcode/shared";

export function buildExternalHistoryBundle(
  session: ExternalImportCommitBundle["session"],
  history: Extract<
    NonNullable<ZCodeSessionCreateParams["importedHistory"]>,
    { source: "external" }
  >,
): ExternalImportCommitBundle {
  const messages: ExternalImportCommitBundle["messages"] = [];
  let parent: MessageId | undefined;
  let at = history.createdAt - 1;
  for (const [index, message] of history.messages.entries()) {
    at = Math.max(at + 1, message.timestamp);
    const id = createMessageId(`${session.id}_external_${index}`);
    const metadata = {
      migrationSource: history.provenance.source,
      externalImport: history.provenance,
      sourceMessageId: message.id,
      sourceModel: message.model,
      sourcePhase: message.phase,
      sourceUsageUnavailable: true,
    };
    const base = { id, sessionID: session.id, agent: "zcode-agent", metadata };
    const info =
      message.role === "user"
        ? {
            ...base,
            role: "user" as const,
            time: { created: at },
          }
        : {
            ...base,
            role: "assistant" as const,
            time: { created: at, completed: at },
            parentID: parent ?? createMessageId(`${session.id}_external_parent`),
            mode: "build",
            path: { cwd: session.directory, root: session.directory },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            finish: "stop",
          };
    if (message.role === "user") parent = id;
    const parts: MessagePart[] = [];
    const common = (suffix: string) => ({
      id: createPartId(`${session.id}_external_${index}_${suffix}`),
      sessionID: session.id as SessionId,
      messageID: id,
    });
    if (message.content)
      parts.push({ ...common("text"), type: "text", text: message.content, metadata });
    for (const [partIndex, block] of message.blocks.entries()) {
      const part = common(String(partIndex));
      if (block.type === "reasoning")
        parts.push({
          ...part,
          type: "reasoning",
          text: block.text,
          time: { start: at, end: at },
          metadata,
        });
      else if (block.type === "file")
        parts.push({
          ...part,
          type: "file",
          mime: block.mime,
          filename: block.filename,
          url: block.url,
        });
      else {
        if (block.status !== "completed")
          for (const [index, attachment] of (block.attachments ?? []).entries())
            parts.push({
              ...common(`attachment_${partIndex}_${index}`),
              type: "file",
              mime: attachment.mime,
              filename: attachment.filename,
              url: attachment.url,
            });
        parts.push({
          ...part,
          type: "tool",
          callID: createHash("sha256").update(`${session.id}:${block.callId}`).digest("hex"),
          tool: block.name.replace(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 64) || "imported_tool",
          metadata: {
            ...metadata,
            historicalOnly: true,
            sourceToolName: block.name,
            sourceToolCallId: block.callId,
          },
          state:
            block.status === "completed"
              ? {
                  status: "completed",
                  attachments: block.attachments?.map((attachment, index) => ({
                    ...common(`attachment_${partIndex}_${index}`),
                    type: "file" as const,
                    mime: attachment.mime,
                    filename: attachment.filename,
                    url: attachment.url,
                  })),
                  input: block.input,
                  output: block.output,
                  title: block.name,
                  metadata: { historicalOnly: true },
                  time: { start: at, end: at },
                }
              : {
                  status: "error",
                  input: block.input,
                  error: block.output || "Source tool was interrupted",
                  time: { start: at, end: at },
                  metadata: { historicalOnly: true },
                },
        });
      }
    }
    messages.push({ info, parts });
  }
  return {
    session,
    messages,
    provenance: {
      id: `external/import:${session.id}`,
      sessionID: session.id,
      type: "external/import",
      touchSession: false,
      time: { created: history.createdAt, updated: history.updatedAt },
      data: history.provenance,
    },
  };
}
