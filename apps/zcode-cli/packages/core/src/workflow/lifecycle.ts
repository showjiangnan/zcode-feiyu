// Modified by ZCode Feiyu.
// 按职责拆分实现，公开入口保持不变；所有状态仍归同一个 runtime 所有。
export {
  type WorkflowGraphNodeChange,
  type WorkflowSnapshotLifecycleResult,
  type ReconcileWorkflowSnapshotForResumeOptions,
  type CancelWorkflowSnapshotOptions,
  type ReopenWorkflowGraphNodeOptions,
  type ReopenWorkflowGraphNodeResult,
  type ApplyWorkflowGraphSeedOptions,
  type ApplyWorkflowGraphSeedResult,
  type ApplyWorkflowNodePromptUpdatesOptions,
  type ApplyWorkflowNodePromptUpdatesResult,
} from "./lifecycle-types.js";
export {
  reconcileWorkflowSnapshotForResume,
  cancelWorkflowSnapshot,
  reopenWorkflowGraphNode,
} from "./lifecycle-status.js";
export { applyWorkflowGraphSeed, applyWorkflowNodePromptUpdates } from "./lifecycle-graph.js";
