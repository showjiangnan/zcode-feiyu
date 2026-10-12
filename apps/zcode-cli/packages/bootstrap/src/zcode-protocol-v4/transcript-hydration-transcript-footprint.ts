// Modified by ZCode Feiyu.
import type { MessageWithParts, SessionEvent } from "@zcode/contracts";
import type {
  HydratedGoalVerificationEntry,
  TranscriptFootprint,
} from "./transcript-hydration-subagent-tool-names.js";
import {
  mergeGoalVerificationEntryFacts,
  turnModelSelectionOfUserMessage,
  hydratedModelKey,
  modelChangeKeyOfPart,
} from "./transcript-hydration-push-goal-verification-fact.js";
import {
  isForkTimelineMessage,
  subagentInfoFromToolPart,
} from "./transcript-hydration-subagent-info-from-tool-part.js";
import {
  isRealUserTurnStarter,
  isProviderContextOnlyAssistant,
} from "./transcript-hydration-subagent-tool-names.js";
import { shouldHideInvalidToolCallFromProduct } from "../tool-call-product-visibility.js";
import { goalVerificationKeyOfPart } from "./transcript-hydration-synthesize-subagent-lifecycle.js";
import {
  compactPayloadFromTimelinePart,
  compactPayloadFromLegacyCompactionPart,
} from "./transcript-hydration-normalize-compact-timeline-status.js";
import { ProductProjection } from "./product-projection.js";

export function transcriptFootprint(
  messages: readonly MessageWithParts[],
  goalVerificationEntries: readonly HydratedGoalVerificationEntry[] = [],
): TranscriptFootprint {
  const compactOperations = new Set<string>();
  const goalVerificationKeys = new Set<string>();
  const modelChangeKeys = new Set<string>();
  for (const fact of mergeGoalVerificationEntryFacts(goalVerificationEntries)) {
    goalVerificationKeys.add(fact.key);
  }
  const footprint: TranscriptFootprint = {
    userTurnCount: 0,
    assistantTexts: [],
    reasoningTexts: [],
    toolCallIds: [],
    compactMarkerCount: 0,
    subagentCount: 0,
    forkTimelineCount: 0,
    goalVerificationCount: 0,
    modelChangeCount: 0,
  };
  // 模型切换 footprint = 相邻真实 user 轮持久化选型快照的变化次数（与投影 marker 的
  // 生成条件同源：本轮实际选型 ≠ 上一轮）。
  let lastModelKey: string | null = null;

  for (const message of messages) {
    if (isForkTimelineMessage(message)) {
      footprint.forkTimelineCount += 1;
    }
    if (isRealUserTurnStarter(message)) {
      footprint.userTurnCount += 1;
      const model = turnModelSelectionOfUserMessage(message);
      if (model) {
        const key = hydratedModelKey(model);
        if (lastModelKey !== null && key !== lastModelKey) {
          footprint.modelChangeCount += 1;
        }
        lastModelKey = key;
      }
    }
    if (message.info.role !== "assistant" || isProviderContextOnlyAssistant(message)) {
      continue;
    }
    for (const part of message.parts) {
      if (part.type === "text" && part.ignored !== true && part.text.length > 0) {
        footprint.assistantTexts.push(part.text);
        continue;
      }
      if (part.type === "reasoning" && part.text.length > 0) {
        footprint.reasoningTexts.push(part.text);
        continue;
      }
      if (part.type === "tool") {
        if (shouldHideInvalidToolCallFromProduct(part.tool, part.metadata)) continue;
        footprint.toolCallIds.push(part.callID);
        const subagentInfo = subagentInfoFromToolPart(part);
        if (subagentInfo && part.state.status !== "pending") {
          footprint.subagentCount += 1;
        }
        continue;
      }
      if (part.type === "subtask") {
        footprint.subagentCount += 1;
        continue;
      }
      if (part.type === "timeline" && part.timelineType === "goal_verification") {
        goalVerificationKeys.add(goalVerificationKeyOfPart(part));
        continue;
      }
      if (part.type === "timeline" && part.timelineType === "model_change") {
        modelChangeKeys.add(modelChangeKeyOfPart(part));
        continue;
      }
      const compact =
        part.type === "timeline"
          ? compactPayloadFromTimelinePart(part)
          : part.type === "compaction"
            ? compactPayloadFromLegacyCompactionPart(part)
            : null;
      if (compact) {
        compactOperations.add(String(compact.payload.operationId));
      }
    }
  }
  footprint.compactMarkerCount = compactOperations.size;
  footprint.goalVerificationCount = goalVerificationKeys.size;
  // 新数据的 timeline part 是显式 boundary authority；旧数据无 part 时才依赖
  // 相邻轮 model 快照变化数。两者表达同一批边界，取 max 避免重复计数。
  footprint.modelChangeCount = Math.max(footprint.modelChangeCount, modelChangeKeys.size);
  return footprint;
}

export function projectionFootprint(
  events: readonly SessionEvent[],
  sessionId: string,
): TranscriptFootprint {
  const projection = new ProductProjection(sessionId, "hydrate-footprint");
  for (const event of events) {
    projection.applyEvent(event);
  }
  const rows = projection.getSnapshot().rows.window;
  return {
    userTurnCount: rows.filter((row) => row.kind === "userInput").length,
    assistantTexts: rows
      .filter((row) => row.kind === "assistantText")
      .map((row) => (row.kind === "assistantText" ? row.text : "")),
    reasoningTexts: rows
      .filter((row) => row.kind === "reasoning")
      .map((row) => (row.kind === "reasoning" ? row.text : "")),
    toolCallIds: rows
      .filter((row) => row.kind === "toolCall")
      .map((row) => (row.kind === "toolCall" ? row.toolCallId : "")),
    compactMarkerCount: rows.filter(
      (row) => row.kind === "timelineMarker" && row.marker.type === "compact",
    ).length,
    subagentCount: rows.filter((row) => row.kind === "subagent").length,
    forkTimelineCount: rows.filter(
      (row) =>
        row.kind === "timelineMarker" &&
        (row.marker.type === "forkNotice" || row.marker.type === "forkCreated"),
    ).length,
    goalVerificationCount: rows.filter(
      (row) => row.kind === "timelineMarker" && row.marker.type === "goalVerify",
    ).length,
    modelChangeCount: rows.filter(
      (row) => row.kind === "timelineMarker" && row.marker.type === "modelChange",
    ).length,
  };
}

export function valuesCover(expected: readonly string[], actual: readonly string[]): boolean {
  const remaining = [...actual];
  for (const value of expected) {
    const index = remaining.indexOf(value);
    if (index < 0) return false;
    remaining.splice(index, 1);
  }
  return true;
}

export function footprintCovered(
  expected: TranscriptFootprint,
  actual: TranscriptFootprint,
): boolean {
  return (
    actual.userTurnCount >= expected.userTurnCount &&
    actual.compactMarkerCount >= expected.compactMarkerCount &&
    actual.subagentCount >= expected.subagentCount &&
    actual.forkTimelineCount >= expected.forkTimelineCount &&
    actual.goalVerificationCount >= expected.goalVerificationCount &&
    actual.modelChangeCount >= expected.modelChangeCount &&
    valuesCover(expected.assistantTexts, actual.assistantTexts) &&
    valuesCover(expected.reasoningTexts, actual.reasoningTexts) &&
    valuesCover(expected.toolCallIds, actual.toolCallIds)
  );
}

/**
 * 判断事件日志是否足以覆盖 transcript 的可见产品态。
 * 修复原因：旧判据只数 user turn，事件日志即使缺 tool/reasoning/compact/subagent
 * 也会被误判为完整，导致冷恢复 snapshot 没有对应 rows。
 */
export function eventsCoverTranscript(
  events: readonly SessionEvent[],
  messages: readonly MessageWithParts[],
  options: {
    goalVerificationEntries?: readonly HydratedGoalVerificationEntry[];
  } = {},
): boolean {
  const expected = transcriptFootprint(messages, options.goalVerificationEntries ?? []);
  if (
    expected.userTurnCount === 0 &&
    expected.assistantTexts.length === 0 &&
    expected.reasoningTexts.length === 0 &&
    expected.toolCallIds.length === 0 &&
    expected.compactMarkerCount === 0 &&
    expected.subagentCount === 0 &&
    expected.forkTimelineCount === 0 &&
    expected.goalVerificationCount === 0 &&
    expected.modelChangeCount === 0
  ) {
    return true;
  }
  const sessionId = String(messages[0]?.info.sessionID ?? events[0]?.sessionId ?? "unknown");
  return footprintCovered(expected, projectionFootprint(events, sessionId));
}
