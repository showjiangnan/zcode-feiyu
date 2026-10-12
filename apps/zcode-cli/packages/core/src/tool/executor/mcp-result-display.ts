// Modified by ZCode Feiyu.
import {
  MCP_TOOL_DISPLAY_MAX_DESCRIPTION_CHARS,
  MCP_TOOL_DISPLAY_MAX_NAME_CHARS,
  type ToolResultDisplayPayload,
} from "@zcode/contracts";

import { isRecord } from "./utils.js";
import { parseOfficialMcpToolError, type OfficialMcpToolErrorCode } from "@zcode/shared";
import {
  MCP_APPS_CONTENT_MAX_BYTES,
  MCP_APPS_STRUCTURED_CONTENT_MAX_BYTES,
  MCP_APPS_WIDGET_META_MAX_BYTES,
  type McpToolDisplayUi,
  type McpToolUiDescriptor,
} from "@zcode/shared/mcp-apps";

// 按职责拆分；保留原始规则、执行顺序与状态所有者。

export interface McpToolDisplayMetadata {
  serverName: string;
  toolName: string;
  description?: string;
  official?: boolean;
  pluginId?: string;
  ui?: McpToolUiDescriptor;
}

export function createMcpToolDisplay(
  metadata: McpToolDisplayMetadata | undefined,
  output?: unknown,
): ToolResultDisplayPayload | undefined {
  if (!metadata) return undefined;
  const serverName = boundMcpDisplayText(metadata.serverName, MCP_TOOL_DISPLAY_MAX_NAME_CHARS);
  const toolName = boundMcpDisplayText(metadata.toolName, MCP_TOOL_DISPLAY_MAX_NAME_CHARS);
  if (!serverName || !toolName) return undefined;
  const description = metadata.description
    ? boundMcpDisplayText(metadata.description, MCP_TOOL_DISPLAY_MAX_DESCRIPTION_CHARS)
    : undefined;
  const unavailable = metadata.official ? readOfficialMcpUnavailable(output) : undefined;
  const ui = createMcpToolDisplayUi(metadata, output);
  return {
    kind: "mcp_tool",
    serverName,
    toolName,
    ...(description ? { description } : {}),
    ...(unavailable ? { unavailable } : {}),
    ...(ui ? { ui } : {}),
  };
}

/**
 * MCP App 元数据投影。任何 MCP server 的工具只要声明了 ui 资源就存在（归属看 serverName）；
 * pluginId 只做展示 / 键位，非插件 server 用 serverName 顶替。structuredContent / _meta 以 JSON 文本
 * 进入持久化 metadata，超限截断并置 truncated，UI 据此提示"结构化结果被截断"。
 */
export function createMcpToolDisplayUi(
  metadata: McpToolDisplayMetadata,
  output: unknown,
): McpToolDisplayUi | undefined {
  if (!metadata.ui) return undefined;
  const pluginId = boundMcpDisplayText(
    metadata.pluginId ?? metadata.serverName,
    MCP_TOOL_DISPLAY_MAX_NAME_CHARS,
  );
  if (!pluginId) return undefined;
  const record = isRecord(output) ? output : undefined;
  // 三个 JSON 字段都按 UTF-8 字节封顶；超限整个省略（不产生半截 JSON），记 truncatedBytes。
  const structured = boundJsonText(
    record?.structuredContent,
    MCP_APPS_STRUCTURED_CONTENT_MAX_BYTES,
  );
  const meta = boundJsonText(record?._meta, MCP_APPS_WIDGET_META_MAX_BYTES);
  const content = boundJsonText(
    Array.isArray(record?.content) ? record.content : undefined,
    MCP_APPS_CONTENT_MAX_BYTES,
  );
  const dropped = [structured, meta, content].filter(
    (item): item is { truncated: true; bytes: number } => item?.truncated === true,
  );
  const truncatedBytes = dropped.reduce((sum, item) => sum + item.bytes, 0);
  return {
    pluginId,
    resourceUri: metadata.ui.resourceUri,
    ...(metadata.ui.preferredDisplayMode
      ? { preferredDisplayMode: metadata.ui.preferredDisplayMode }
      : {}),
    ...(metadata.ui.prefersBorder !== undefined
      ? { prefersBorder: metadata.ui.prefersBorder }
      : {}),
    ...(metadata.ui.csp ? { csp: metadata.ui.csp } : {}),
    ...(structured && !structured.truncated ? { structuredContent: structured.text } : {}),
    ...(meta && !meta.truncated ? { widgetMeta: meta.text } : {}),
    ...(content && !content.truncated ? { content: content.text } : {}),
    ...(dropped.length > 0 ? { truncated: true, truncatedBytes } : {}),
    // H06：MCP isError 的调用在 v4 行上仍是 success（模型视角已完成），页面与面板要靠这个字段区分。
    ...(record?.isError === true ? { isError: true as const } : {}),
    ...(metadata.ui.surface ? { surface: metadata.ui.surface } : {}),
    // 4b-1：只投影 true；false / 缺省都不占字段。
    ...(metadata.ui.showInline === true ? { showInline: true as const } : {}),
  };
}

/** JSON 文本按 UTF-8 字节封顶：≤ 上限返回文本，超限只返回字节数（不截断字符串）。 */
export function boundJsonText(
  value: unknown,
  maxBytes: number,
): { text: string; truncated: false } | { truncated: true; bytes: number } | undefined {
  if (value === undefined || value === null) return undefined;
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    return undefined;
  }
  if (typeof text !== "string") return undefined;
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return { text, truncated: false };
  return { truncated: true, bytes };
}

/**
 * 官方 Server MCP 在配额耗尽 / 无 Coding Plan 时把结构化标识渲染进 tool error content 的
 * JSON 文本（服务端 `ToolError.Error()`）。这里只读该标识，不解析普通错误文案。
 *
 * 仅在 `metadata.official` 为真时才会走到，而该标记只对 **http** 官方 MCP 置位——那种形态的
 * 响应来自已校验 origin 的 ZCode 后端。stdio 官方 MCP 与第三方 MCP 塞同样的 payload 一律忽略：
 * 它们的结果由插件进程自己产出，可以伪造一条 Coding Plan 提示误导用户去购买。
 */
export function readOfficialMcpUnavailable(
  output: unknown,
): { code: OfficialMcpToolErrorCode } | undefined {
  if (!isRecord(output) || output.isError !== true || !Array.isArray(output.content)) {
    return undefined;
  }
  for (const block of output.content) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;
    const parsed = parseOfficialMcpToolError(block.text);
    if (parsed) return { code: parsed.code };
  }
  return undefined;
}

export function boundMcpDisplayText(value: string, maxChars: number): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const bounded = trimmed.slice(0, maxChars);
  // MCP discovery 是外部输入，直接 slice 可能在 UTF-16 surrogate pair
  // 中间截断，生成无法稳定跨事件、持久化和 replayable snapshot 的字符串。
  // 若边界落在高位 surrogate 后，丢弃这个半字符，保证 display 始终可安全序列化。
  const lastCodeUnit = bounded.charCodeAt(bounded.length - 1);
  return lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff ? bounded.slice(0, -1) : bounded;
}
