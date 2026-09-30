// Modified by ZCode Feiyu contributors (2026).
import { countContextPrefixMessages } from "../deps.js";
import type { Model } from "../deps.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { resolveEnabledProjectMemoryRoot } from "../helpers/project-memory.js";
import { buildContextHistoryEntries } from "./context-history-entries.js";

/** 当前已安装的上下文前缀是否含记忆（使用说明或索引/相关主题）。 */
function contextPrefixIncludesMemory(runtime: AgentRuntimeInternal): boolean {
  return (
    runtime.latestContextBuildResult?.sections.some(
      (section) => section.source === "memory" || section.source === "project_memory_context",
    ) ?? false
  );
}

/**
 * 记忆许可在回合进行中被关闭并已确认后，移除前缀里的记忆，返回本回合应使用的请求条目。
 *
 * 修复原因：记忆索引与相关主题只在回合起点写入 canonical history 与本回合请求条目，
 * 关闭许可只清了 runtime 字段，确认之后同一回合的下一次模型请求仍会带着旧记忆发出（复审 DEF-04）。
 * 依据：CONT-FR-01 要求关闭后运行时不再读取或使用项目记忆；已发出的请求无法撤回，
 * 但确认之后的新请求必须由当前许可决定。许可仍有效或前缀本就不含记忆时返回 undefined，调用方保持原条目。
 */
export function dropRevokedMemoryFromTurnPrefix(
  runtime: AgentRuntimeInternal,
  turnRequestEntries: readonly RuntimeMessageEntry[],
  model?: Model,
): readonly RuntimeMessageEntry[] | undefined {
  if (resolveEnabledProjectMemoryRoot(runtime.config, runtime.workspaceRoot) !== undefined)
    return undefined;
  const rebuilt = contextPrefixIncludesMemory(runtime)
    ? rebuildContextPrefix(runtime, { model, turnRequestEntries })
    : (() => {
        // 关闭 ACK 已刷新 canonical 前缀时，活动回合仍可能持有旧快照；按来源边界换成当前前缀。
        const canonical = runtime.messageHistory.borrowReadOnlyRuntimeEntries();
        const count = countContextPrefixMessages(canonical);
        const priorCount = countContextPrefixMessages(turnRequestEntries);
        const prefix = canonical.slice(0, count);
        return count === priorCount &&
          prefix.every((entry, index) => entry === turnRequestEntries[index])
          ? turnRequestEntries
          : [...prefix, ...turnRequestEntries.slice(priorCount)];
      })();
  // 回合内召回追加在对话尾部，重建前缀不会删除它；压缩也可能把该附件带入 canonical。
  // 按可信来源清除受控注入，不根据正文匹配，避免删除用户真实讨论记忆的消息。
  const withoutRecall = (entries: readonly RuntimeMessageEntry[]) =>
    entries.filter((entry) => entry.metadata?.source !== "memory_recall");
  const canonical = runtime.messageHistory.borrowReadOnlyRuntimeEntries();
  const cleanCanonical = withoutRecall(canonical);
  if (cleanCanonical.length !== canonical.length)
    runtime.messageHistory.replaceMessages(cleanCanonical);
  const clean = withoutRecall(rebuilt);
  return rebuilt !== turnRequestEntries || clean.length !== rebuilt.length ? clean : undefined;
}

export function rebuildContextPrefix(
  runtime: AgentRuntimeInternal,
  options: {
    memoryRelevantContent?: string;
    model?: Model;
    turnRequestEntries?: readonly RuntimeMessageEntry[];
  } = {},
): readonly RuntimeMessageEntry[] {
  if (!runtime.contextBuilder || !runtime.contextInitialized) {
    // 首轮 context 初始化前，model/outputStyle/language 变更只能刷新同步预览，
    // 不能把 config-only fallback envInfo 写入 config.envInfo。否则真实 context source
    // 会以为 envInfo 已由外部显式提供，跳过平台和 git 探测。
    if (runtime.contextBuilder) {
      runtime.contextBuilder = runtime.createContextBuilderFromSnapshot(
        runtime.createConfigOnlyContextSnapshot(runtime.workingDirectory),
        runtime.memoryRoot,
        {
          memoryIndexContent: runtime.memoryIndexContent,
          memoryRelevantContent: options.memoryRelevantContent,
          model: options.model,
          persistEnvInfo: false,
        },
      );
    }
    return options.turnRequestEntries ?? runtime.messageHistory.borrowReadOnlyRuntimeEntries();
  }

  const contextSnapshot =
    runtime.contextSourceSnapshot ??
    runtime.createConfigOnlyContextSnapshot(runtime.workingDirectory);
  runtime.contextBuilder = runtime.createContextBuilderFromSnapshot(
    contextSnapshot,
    runtime.memoryRoot,
    {
      memoryIndexContent: runtime.memoryIndexContent,
      memoryRelevantContent: options.memoryRelevantContent,
      model: options.model,
    },
  );
  const effectiveContextResult = runtime.contextBuilder.build();
  const contextEntries = buildContextHistoryEntries(effectiveContextResult);
  const canonicalEntries = runtime.messageHistory.borrowReadOnlyRuntimeEntries();
  const canonicalConversationEntries = canonicalEntries.slice(
    countContextPrefixMessages(canonicalEntries),
  );

  runtime.latestContextBuildResult = effectiveContextResult;
  runtime.messageHistory.replaceMessages([...contextEntries, ...canonicalConversationEntries]);

  const turnEntries = options.turnRequestEntries;
  if (!turnEntries) return runtime.messageHistory.borrowReadOnlyRuntimeEntries();
  return [...contextEntries, ...turnEntries.slice(countContextPrefixMessages(turnEntries))];
}
