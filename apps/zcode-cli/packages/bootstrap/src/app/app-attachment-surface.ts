// Modified by ZCode Feiyu.
import type { MessageId } from "@zcode/contracts";
import {
  ZCODE_ATTACHMENT_FAULT_CODES,
  ZCodeAttachmentFaultError,
} from "@zcode/shared/zcode-protocol-v4";
import { isAbsolute } from "node:path";

import { readPromptAttachmentArtifact } from "./prompt-attachment-artifact.js";

import type { ZCodeApp } from "./types.js";
import type { AppReturnSurfaceInput } from "./app-return-surface-types.js";
// 复用原装配实例；工具、权限与工作流入口保持原执行顺序。
export function createAppAttachmentSurface(
  input: AppReturnSurfaceInput,
): Pick<
  ZCodeApp,
  | "writePromptAttachment"
  | "readPromptAttachment"
  | "statPromptAttachment"
  | "resolvePromptAttachmentPreviewSource"
> {
  const { sessionId, traceContext, sessionStore, artifactStore, fileSystemPort } = input;

  const resolvePromptAttachment = async (input: {
    ref: string;
    mime: string;
    messageId?: string;
    attachmentIndex?: number;
  }): Promise<{ ref: string; mediaType: string; artifactUri?: string }> => {
    let ref = input.ref;
    let mediaType = input.mime;
    let artifactUri: string | undefined;
    if (input.messageId && input.attachmentIndex !== undefined) {
      // 预览单个附件曾通过 messages() 解码整段会话；长会话会同步扫描
      // 所有 parts，且无关坏行也会让目标预览失败。按 session/message 定点读取即可。
      const persistedMessage = await sessionStore.messageWithParts({
        sessionID: sessionId,
        messageID: input.messageId as MessageId,
      });
      const persistedAttachment = persistedMessage?.parts.filter((part) => part.type === "file")[
        input.attachmentIndex
      ];
      if (persistedAttachment?.type === "file") {
        mediaType = persistedAttachment.mime;
        // live row 的 ref 仍是原始路径；如果直接读取，源文件删除或覆盖后
        // 热态预览会和冷恢复 artifact 不一致。同一 message/index 必须优先取不可变副本。
        artifactUri =
          persistedAttachment.metadata?.artifactUri ??
          (persistedAttachment.url.startsWith("zcode-artifact://")
            ? persistedAttachment.url
            : undefined);
        ref =
          artifactUri ??
          (!persistedAttachment.url.startsWith("data:") ? persistedAttachment.url : input.ref);
      }
      // message row 会先于后续 FilePart 逐条落库；目标 part 尚未可见时仍应
      // 使用已经由当前 projection 授权的 input.ref，不能制造短暂的预览失败窗口。
    }
    return { ref, mediaType, ...(artifactUri ? { artifactUri } : {}) };
  };
  return {
    // wire/staging 全程是 decoded chunk；只有完整 checksum commit 后才在
    // CLI 进程内恢复既有 data-URL artifact 形态，保持 provider 读取链兼容。
    writePromptAttachment: async (input) => {
      const artifact = await artifactStore.writeToolResultArtifact({
        content: `data:${input.mime};base64,${Buffer.from(input.bytes).toString("base64")}`,
        contentType: "text/plain",
        retention: "session",
        sessionId,
        toolCallId: `prompt-attachment-upload-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
        toolName: "prompt-attachment:upload",
        trace: traceContext,
      });
      if (
        input.mime.startsWith("image/") ||
        input.mime.startsWith("video/") ||
        input.mime.split(";", 1)[0]?.trim().toLowerCase() === "application/pdf"
      ) {
        // 派生媒体只是可重建缓存；真实 IO 失败不破坏 durable data URL，最终请求投影会再次 ensure。
        void artifactStore
          .primeMediaAttachmentPath?.({
            bytes: input.bytes,
            mediaType: input.mime,
            uri: artifact.uri,
          })
          .catch(() => undefined);
      }
      return { ref: artifact.uri };
    },

    readPromptAttachment: async (input) => {
      const { ref, mediaType } = await resolvePromptAttachment(input);
      // 读取必须留在 session runtime 内：artifact 走 session store，路径走当前
      // FileSystemPort，SSH/WSL/Docker 才会命中正确的远端文件系统。
      if (ref.startsWith("zcode-artifact://")) {
        return readPromptAttachmentArtifact(artifactStore, {
          ref,
          mediaType,
          maxBytes: input.maxBytes,
          trace: traceContext,
        });
      }
      const read = await fileSystemPort.readBinaryFile({
        path: ref,
        maxBytes: input.maxBytes,
        trace: traceContext,
      });
      return { bytes: read.content, mediaType };
    },

    statPromptAttachment: async (input) => {
      const { ref, mediaType, artifactUri } = await resolvePromptAttachment(input);
      if (artifactUri) {
        if (!artifactStore.statToolResultArtifact) {
          throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.statUnsupported);
        }
        const result = await artifactStore.statToolResultArtifact({
          uri: artifactUri,
          trace: traceContext,
        });
        return {
          totalBytes: result.bytes,
          mediaType: result.contentType || mediaType,
          ...(result.mtimeMs === undefined ? {} : { mtimeMs: result.mtimeMs }),
        };
      }
      const result = await fileSystemPort.stat({ path: ref, trace: traceContext });
      if (result.kind !== "file") {
        // 目录/符号链接/已消失都意味着「这个附件不再是可分享的文件」，用稳定码上抛，
        // 让 share 预检按确定分类处理，而不是靠错误文本猜。
        throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.statNotFile);
      }
      return {
        totalBytes: result.sizeBytes,
        mediaType,
        ...(result.mtimeMs === undefined ? {} : { mtimeMs: result.mtimeMs }),
      };
    },

    resolvePromptAttachmentPreviewSource: async (input) => {
      const resolved = await resolvePromptAttachment(input);
      if (!resolved.mediaType.startsWith("video/")) return { kind: "chunked" };
      if (resolved.artifactUri) {
        if (!artifactStore.ensureMediaAttachmentPath) return { kind: "chunked" };
        try {
          const materialized = await artifactStore.ensureMediaAttachmentPath({
            uri: resolved.artifactUri,
            mediaType: resolved.mediaType,
          });
          if (materialized.status === "ready" && materialized.path.trim()) {
            return {
              kind: "local_path",
              path: materialized.path,
              mediaType: resolved.mediaType,
            };
          }
        } catch {
          // artifact 仍是不可变事实；派生文件失败只允许 gateway 回到 artifact chunk。
        }
        return { kind: "chunked" };
      }
      if (isAbsolute(resolved.ref)) {
        return {
          kind: "local_path",
          path: resolved.ref,
          mediaType: resolved.mediaType,
        };
      }
      return { kind: "chunked" };
    },
  };
}
