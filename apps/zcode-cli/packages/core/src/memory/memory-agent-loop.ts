// Modified by ZCode Feiyu contributors (2026).
import type {
  ModelInputMessage,
  ModelMessageContent,
  Model,
  ModelReasoningContentBlock,
  ModelRequest,
  ModelToolCall,
  ModelToolContract,
} from "@zcode/contracts";
import { modelContentForToolResult, isErrorForToolResult } from "../runtime/helpers/tool-result.js";
import { projectMessagesForModelMediaPolicy } from "../runtime/helpers/media-budget.js";
import type { ExecutableToolCall, ToolExecutionResult } from "../tool/types.js";
import { resolveSafeMemoryFilePath } from "./memory-file-path.js";
import { auxiliaryModelOptions } from "../model/auxiliary-model-options.js";
import { compactMemoryAgentContext } from "./agent-context.js";
import { createMemoryRequestAccounting } from "./request-accounting.js";

interface MemoryAgentLoopResult {
  completed: boolean;
  finalText: string;
  messages: ModelInputMessage[];
  toolErrors: number;
  totalTokens: number;
  tokenUsageEstimated: boolean;
  turns: number;
}

interface MemoryAgentToolPolicyInput {
  rootDir: string;
  toolCall: ModelToolCall;
  tools: readonly ModelToolContract[];
  workingDirectory: string;
  workspaceRoot: string;
  scope: "extraction" | "review";
}

type MemoryAgentToolPolicyDecision = { allowed: true } | { allowed: false; reason: string };

const MEMORY_AGENT_READ_ONLY_TOOLS = new Set(["Read", "Grep", "Glob"]);
const MEMORY_AGENT_VISIBLE_TOOLS = new Set(["Read", "Grep", "Glob", "Write", "Edit"]);

export function selectMemoryAgentTools(
  tools: readonly ModelToolContract[],
  scope: "extraction" | "review" = "extraction",
): ModelToolContract[] {
  return tools.filter(
    (tool) =>
      MEMORY_AGENT_VISIBLE_TOOLS.has(tool.name) &&
      (scope !== "review" || !["Grep", "Glob"].includes(tool.name)) &&
      tool.sideEffectScope !== "network",
  );
}

export async function runMemoryAgentLoop(input: {
  abortSignal?: AbortSignal;
  executeTool: (
    toolCall: ExecutableToolCall,
    options: { abortSignal?: AbortSignal },
  ) => Promise<ToolExecutionResult>;
  messages: readonly ModelInputMessage[];
  model: Model;
  onUsage?: (totalTokens: number, estimated: boolean) => void | Promise<void>;
  onRequest?: () => void | Promise<void>;
  rootDir: string;
  scope?: "extraction" | "review";
  tools: readonly ModelToolContract[];
  workingDirectory: string;
  workspaceRoot: string;
}): Promise<MemoryAgentLoopResult> {
  const messages = input.messages.map(cloneModelMessage);
  let turns = 0;
  let totalTokens = 0;
  let tokenUsageEstimated = false;
  let toolErrors = 0;
  let completed = false;
  let finalText = "";

  const generate = async (request: ModelRequest) => {
    const accounting = createMemoryRequestAccounting({
      request,
      model: input.model,
      onRequest: input.onRequest,
      onUsage: async (tokens, estimated) => {
        totalTokens += tokens;
        tokenUsageEstimated ||= estimated;
        await input.onUsage?.(tokens, estimated);
      },
    });
    request.modelRequestAdmission = accounting.admission;
    try {
      const response = await input.model.generateText(request);
      await accounting.finish(response.usage);
      input.abortSignal?.throwIfAborted();
      return response;
    } catch (error) {
      await accounting.finish();
      throw error;
    }
  };
  for (; ; turns += 1) {
    input.abortSignal?.throwIfAborted();
    const tools = selectMemoryAgentTools(input.tools, input.scope);
    await compactMemoryAgentContext({
      messages,
      model: input.model,
      tools,
      generate,
      abortSignal: input.abortSignal,
    });
    // 每次请求都处理新增工具媒体；原上下文及单次能力边界不随消费额度移除而放宽。
    const mediaProjection = projectMessagesForModelMediaPolicy(
      messages.map(cloneModelMessage),
      input.model.properties.inputFormat,
    );
    const response = await generate({
      abortSignal: input.abortSignal,
      messages: mediaProjection.messages,
      options: auxiliaryModelOptions(input.model),
      tools,
    });

    const toolCalls = response.toolCalls ?? [];
    messages.push(createAssistantMessage(response.text, response.reasoning, toolCalls));
    if (toolCalls.length === 0) {
      completed = true;
      finalText = response.text;
      turns += 1;
      break;
    }

    const executeCall = async (toolCall: ModelToolCall): Promise<ModelInputMessage> => {
      const decision = evaluateMemoryAgentToolPolicy({
        rootDir: input.rootDir,
        toolCall,
        tools: input.tools,
        workingDirectory: input.workingDirectory,
        workspaceRoot: input.workspaceRoot,
        scope: input.scope ?? "extraction",
      });
      if (!decision.allowed) {
        toolErrors += 1;
        return {
          content: decision.reason,
          isError: true,
          role: "tool",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
        };
      }

      const result = await input.executeTool(
        { id: toolCall.id, input: toolCall.input, name: toolCall.name },
        { abortSignal: input.abortSignal },
      );
      const isError = isErrorForToolResult(result);
      if (isError) toolErrors += 1;
      return {
        content: modelContentForToolResult(result),
        isError,
        role: "tool",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
      };
    };
    const toolMessages = toolCalls.some((call) => call.name === "Write" || call.name === "Edit")
      ? await executeMemoryToolsSequentially(toolCalls, executeCall)
      : await Promise.all(toolCalls.map(executeCall));
    messages.push(...toolMessages);
  }

  return { completed, finalText, messages, toolErrors, totalTokens, tokenUsageEstimated, turns };
}

async function executeMemoryToolsSequentially(
  toolCalls: readonly ModelToolCall[],
  executeCall: (toolCall: ModelToolCall) => Promise<ModelInputMessage>,
): Promise<ModelInputMessage[]> {
  const messages: ModelInputMessage[] = [];
  for (const toolCall of toolCalls) messages.push(await executeCall(toolCall));
  return messages;
}

function evaluateMemoryAgentToolPolicy(
  input: MemoryAgentToolPolicyInput,
): MemoryAgentToolPolicyDecision {
  const contract = input.tools.find((tool) => tool.name === input.toolCall.name);
  // catalog miss 被合并进 Memory 权限拒绝会让未注册工具没有先走
  // No such tool 错误处理。此分支只闭合原 call id，不进入工具执行面。
  if (!contract) return denyUnavailableMemoryAgentTool(input.toolCall.name);

  if (
    input.toolCall.name === "Agent" ||
    input.toolCall.name.startsWith("mcp__") ||
    contract.sideEffectScope === "network"
  )
    return denyMemoryAgentTool(input.rootDir);

  if (input.toolCall.name === "Write" || input.toolCall.name === "Edit") {
    return isContainedMarkdownMutation(input)
      ? { allowed: true }
      : denyMemoryAgentTool(input.rootDir);
  }

  if (MEMORY_AGENT_READ_ONLY_TOOLS.has(input.toolCall.name)) {
    if (input.toolCall.name === "Read") {
      const filePath = stringProperty(input.toolCall.input, "file_path");
      if (!filePath?.endsWith(".md")) return denyMemoryAgentTool(input.rootDir);
      try {
        if (
          !resolveSafeMemoryFilePath({
            filePath,
            rootDir: input.rootDir,
            workingDirectory: input.workingDirectory,
            workspaceRoot: input.workspaceRoot,
          })
        )
          return denyMemoryAgentTool(input.rootDir);
      } catch {
        return denyMemoryAgentTool(input.rootDir);
      }
    } else {
      if (input.scope === "review") return denyMemoryAgentTool(input.rootDir);
      const searchPath = stringProperty(input.toolCall.input, "path");
      if (!searchPath || !isContainedMemorySearchPath(searchPath, input)) {
        return denyMemoryAgentTool(input.rootDir);
      }
    }
    return { allowed: true };
  }

  return denyMemoryAgentTool(input.rootDir);
}

function isContainedMemorySearchPath(
  path: string,
  input: Pick<MemoryAgentToolPolicyInput, "rootDir" | "workingDirectory" | "workspaceRoot">,
): boolean {
  if (path === input.rootDir) return true;
  try {
    return (
      resolveSafeMemoryFilePath({
        filePath: path,
        rootDir: input.rootDir,
        workingDirectory: input.workingDirectory,
        workspaceRoot: input.workspaceRoot,
      }) !== undefined
    );
  } catch {
    return false;
  }
}

function isContainedMarkdownMutation(input: MemoryAgentToolPolicyInput): boolean {
  const filePath = stringProperty(input.toolCall.input, "file_path");
  if (!filePath?.endsWith(".md")) return false;
  try {
    return (
      resolveSafeMemoryFilePath({
        filePath,
        rootDir: input.rootDir,
        workingDirectory: input.workingDirectory,
        workspaceRoot: input.workspaceRoot,
      }) !== undefined
    );
  } catch {
    return false;
  }
}

function createAssistantMessage(
  text: string,
  reasoning: readonly ModelReasoningContentBlock[] | undefined,
  toolCalls: readonly ModelToolCall[],
): ModelInputMessage {
  return {
    content: assistantContent(text, reasoning),
    role: "assistant",
    toolCalls: toolCalls.map((call) => ({ ...call })),
  };
}

function assistantContent(
  text: string,
  reasoning: readonly ModelReasoningContentBlock[] | undefined,
): ModelMessageContent {
  if (!reasoning?.length) return text;
  return [
    ...reasoning.map((block) => ({
      ...block,
      providerOptions: block.providerOptions ? { ...block.providerOptions } : undefined,
    })),
    ...(text ? [{ text, type: "text" as const }] : []),
  ];
}

function cloneModelMessage(message: ModelInputMessage): ModelInputMessage {
  return {
    ...message,
    cacheControl: message.cacheControl ? { ...message.cacheControl } : undefined,
    content: Array.isArray(message.content)
      ? message.content.map((block) => ({ ...block }))
      : message.content,
    toolCalls: message.toolCalls?.map((call) => ({ ...call })),
  };
}

function stringProperty(value: unknown, property: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const propertyValue = (value as Record<string, unknown>)[property];
  return typeof propertyValue === "string" ? propertyValue : undefined;
}

function denyMemoryAgentTool(rootDir: string): MemoryAgentToolPolicyDecision {
  return {
    allowed: false,
    reason: `only Read, Grep, Glob, and Edit/Write within ${rootDir} are allowed`,
  };
}

function denyUnavailableMemoryAgentTool(toolName: string): MemoryAgentToolPolicyDecision {
  return {
    allowed: false,
    reason: `<tool_use_error>Error: No such tool available: ${toolName}</tool_use_error>`,
  };
}
