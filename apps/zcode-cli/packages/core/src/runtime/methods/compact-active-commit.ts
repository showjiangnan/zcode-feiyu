// Modified by ZCode Feiyu.
import { collectRuntimeAgentListing } from "../helpers/agent-listing.js";
import {
  CompactTimelineStatus,
  SessionEventType,
  createMessageId,
  buildCompactSummaryMessage,
  buildManualCompactBoundary,
  createCompactBoundaryId,
  getUsageTotalTokens,
} from "../deps.js";

import {
  buildPostCompactReadStateReminderEntries,
  countCompactPreservedRuntimeMessages,
  buildPostCompactRuntimeEntries,
  estimateRuntimeEntryTokens,
  readApprovedPlanFileReferenceEntry,
} from "../helpers/index.js";
import type { RuntimeModelTextResult } from "../types.js";

import type { AgentRuntimeInternal } from "../internal.js";

import { legacySyntheticRuntimeMetadata } from "../../agent/message-history.js";
import { selectPersistedCompactTail } from "../helpers/compact-preservation.js";
import {
  formatCompactSummaryOrThrow,
  persistCompactTimelineEvent,
} from "./compact-active-helpers.js";

import {
  filterOutputTokenContinuationEntries,
  preserveCanonicalContextPrefix,
} from "./turn-output-token-continuation.js";
import type { CompactCommitContext, CompactActiveResult } from "./compact-active-types.js";
export async function commitCompactSummary(
  this: AgentRuntimeInternal,
  result: RuntimeModelTextResult,
  context: CompactCommitContext,
): Promise<CompactActiveResult> {
  const {
    activeEntries,
    attempt,
    compactModel,
    compactReason,
    compactTimeline,
    customInstructions,
    events,
    lastSummarizedMessageId,
    maxAttempts,
    modelTraceContext,
    options,
    phase,
    preCompactTokenCount,
    selectionState,
    trigger,
    turnTraceContext,
    useMidConversationSystem,
  } = context;
  const summary = formatCompactSummaryOrThrow(this, result);
  const persistedSummary = summary;
  const planFileReferenceEntry = this.fileSystemPort
    ? await readApprovedPlanFileReferenceEntry({
        abortSignal: options.abortSignal,
        fileSystemPort: this.fileSystemPort,
        sessionId: this.sessionId,
        traceContext: modelTraceContext,
        workspaceRoot: this.workspaceRoot,
      })
    : undefined;
  const agentListingEntry = collectRuntimeAgentListing(
    this,
    selectionState.preservedEntries,
    options.agentListingTools ?? this.getTools(options.model ?? compactModel),
  );
  const postCompactReminderEntries = [
    ...(agentListingEntry ? [agentListingEntry] : []),
    ...(planFileReferenceEntry ? [planFileReferenceEntry] : []),
    ...buildPostCompactReadStateReminderEntries({
      preservedEntries: selectionState.preservedEntries,
      readFileState: this.readFileState,
    }),
  ];

  const modelCompleteEvent = this.createEvent(
    SessionEventType.ModelComplete,
    {
      content: summary,
      stopReason: result.finishReason,
      usage: result.usage,
      querySource: "compact",
      toolCallCount: 0,
    },
    modelTraceContext,
  );
  await this.appendEvent(modelCompleteEvent, modelTraceContext);
  events.push(modelCompleteEvent);

  const summaryMessageId = createMessageId();
  const summaryMessageContent = buildCompactSummaryMessage(persistedSummary, {
    suppressFollowup: true,
  });
  // Continue 没有对应 Session message；无 store 的统计也不能把它计入保留记录。
  const recordablePreservedEntries = filterOutputTokenContinuationEntries(
    selectionState.preservedEntries,
  );
  const preservation = this.sessionStore
    ? await selectPersistedCompactTail({
        sessionStore: this.sessionStore,
        sessionId: this.sessionId,
        groupsPreserved: selectionState.currentSelection.groupsPreserved,
        summaryMessageId,
      })
    : { keptMessageCount: countCompactPreservedRuntimeMessages(recordablePreservedEntries) };
  const postCompactEntries = buildPostCompactRuntimeEntries(
    activeEntries,
    {
      message: {
        role: "user",
        content: summaryMessageContent,
      },
      metadata: legacySyntheticRuntimeMetadata(),
    },
    {
      postCompactReminderEntries,
      preservedEntries: selectionState.preservedEntries,
    },
  );
  const truePostCompactTokenCount = estimateRuntimeEntryTokens(postCompactEntries, {
    useMidConversationSystem,
  });
  const providerPostCompactTokenCount = getUsageTotalTokens(result.usage);
  const compactBoundary = buildManualCompactBoundary({
    boundaryId: createCompactBoundaryId(),
    autoCompactThreshold: options.autoCompactThreshold,
    compactReason,
    customInstructions,
    lastSummarizedMessageId,
    phase,
    postCompactTokenCount: providerPostCompactTokenCount,
    preCompactTokenCount,
    summarizedMessageCount: selectionState.entriesToSummarize.length,
    summaryMessageId,
    traceContext: turnTraceContext,
    trigger,
    ...(selectionState.currentSelection.groupsPreserved > 0
      ? {
          keptMessageCount: preservation.keptMessageCount,
        }
      : {}),
    preservedSegment: preservation.preservedSegment,
    truePostCompactTokenCount,
    willRetriggerNextTurn:
      options.autoCompactThreshold !== undefined
        ? truePostCompactTokenCount >= options.autoCompactThreshold
        : undefined,
  });

  await this.persistCompactSummary(
    summaryMessageId,
    summaryMessageContent,
    persistedSummary,
    compactBoundary,
    modelTraceContext,
    {
      model: compactModel,
      operationId: compactTimeline.operationId,
      postCompactReminderEntries,
    },
  );

  const compactBoundaryEvent = this.createEvent(
    SessionEventType.CompactBoundary,
    compactBoundary,
    turnTraceContext,
  );
  await this.appendEvent(compactBoundaryEvent, turnTraceContext);
  events.push(compactBoundaryEvent);

  const compactCompletedPayload = this.buildCompactTimelinePayload(compactTimeline, {
    ...(maxAttempts > 1 ? { attempt, maxAttempts } : {}),
    boundaryId: compactBoundary.boundaryId,
    endedAt: Date.now(),
    postCompactTokenCount: providerPostCompactTokenCount,
    replace: true,
    status: CompactTimelineStatus.Completed,
    summaryMessageId,
    tailStartMessageId: lastSummarizedMessageId,
    truePostCompactTokenCount,
  });
  await persistCompactTimelineEvent(
    this,
    SessionEventType.CompactCompleted,
    compactCompletedPayload,
    turnTraceContext,
    events,
  );

  this.latestConversationMessageId = summaryMessageId;
  const recordablePostCompactEntries = filterOutputTokenContinuationEntries(postCompactEntries);
  this.messageHistory.replaceMessages(
    options.activeEntries
      ? preserveCanonicalContextPrefix(
          this.messageHistory.borrowReadOnlyRuntimeEntries(),
          recordablePostCompactEntries,
        )
      : recordablePostCompactEntries,
  );
  this.readFileState.clear();

  return {
    displayText: "Compacted",
    entries: postCompactEntries,
    outcome: "compacted",
    tokenCount: providerPostCompactTokenCount,
  };
}
