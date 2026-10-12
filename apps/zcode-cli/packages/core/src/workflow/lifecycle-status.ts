// Modified by ZCode Feiyu.
import {
  deriveWorkflowSessionLinks,
  type WorkflowActivitySnapshot,
  type WorkflowGraphNode,
  type WorkflowNodeStatus,
  type WorkflowPhaseSnapshot,
  type WorkflowRunSnapshot,
} from "@zcode/contracts";
import {
  type ReconcileWorkflowSnapshotForResumeOptions,
  type WorkflowSnapshotLifecycleResult,
  type WorkflowGraphNodeChange,
  type CancelWorkflowSnapshotOptions,
  type ReopenWorkflowGraphNodeOptions,
  type ReopenWorkflowGraphNodeResult,
} from "./lifecycle-types.js";

export const DEFAULT_RESUME_RESET_REASON =
  "Reset during workflow resume because the previous process stopped before completion.";

export const DEFAULT_CANCEL_REASON = "Workflow cancelled.";

export const DEFAULT_REOPEN_REASON = "Reopened by workflow critic.";

export const CANCELLABLE_STATUSES = new Set<WorkflowNodeStatus>(["active", "pending"]);

export const REOPENABLE_STATUSES = new Set<WorkflowNodeStatus>(["completed", "failed", "skipped"]);

export function reconcileWorkflowSnapshotForResume<TSnapshot extends WorkflowRunSnapshot>(
  snapshot: TSnapshot,
  options: ReconcileWorkflowSnapshotForResumeOptions,
): WorkflowSnapshotLifecycleResult<TSnapshot> {
  const reason = options.reason ?? DEFAULT_RESUME_RESET_REASON;
  const nodeScope = options.nodeIds ? new Set(options.nodeIds) : undefined;
  const resetActivities = options.resetActivities ?? true;
  const resetPhases = options.resetPhases ?? true;
  const nodeChanges: WorkflowGraphNodeChange[] = [];
  const resetPhaseIdsFromNodes = new Set<string>();

  const nodes = snapshot.graph.nodes.map((node) => {
    if (node.status !== "active" || !isInScope(node.id, nodeScope)) {
      return node;
    }
    nodeChanges.push(nodeChange(node, "pending"));
    if (node.phase) {
      resetPhaseIdsFromNodes.add(node.phase);
    }
    return {
      ...node,
      error: reason,
      status: "pending" as const,
    };
  });

  const phaseIds: string[] = [];
  const phases = snapshot.phases.map((phase) => {
    if (
      !resetPhases ||
      phase.status !== "active" ||
      !shouldRepairPhase(phase.phase, nodeScope, resetPhaseIdsFromNodes)
    ) {
      return phase;
    }
    phaseIds.push(phase.phase);
    return resetPhaseForRetry(phase, reason);
  });

  const activityIds: string[] = [];
  const activities = snapshot.activities.map((activity) => {
    if (
      !resetActivities ||
      activity.status !== "active" ||
      !shouldRepairActivity(activity, nodeScope, resetPhaseIdsFromNodes)
    ) {
      return activity;
    }
    activityIds.push(activity.activityId);
    return closeActivity(activity, "cancelled", options.timestamp, reason);
  });

  const changed = nodeChanges.length > 0 || phaseIds.length > 0 || activityIds.length > 0;
  return {
    activityIds,
    changed,
    nodeChanges,
    phaseIds,
    snapshot: changed
      ? ({
          ...snapshot,
          activities,
          graph: {
            collections: snapshot.graph.collections,
            edges: snapshot.graph.edges,
            nodes,
          },
          phases,
          sessionLinks: deriveWorkflowSessionLinks({ activities, runId: snapshot.runId }),
          updatedAt: options.timestamp,
        } as TSnapshot)
      : snapshot,
  };
}

export function cancelWorkflowSnapshot<TSnapshot extends WorkflowRunSnapshot>(
  snapshot: TSnapshot,
  options: CancelWorkflowSnapshotOptions,
): WorkflowSnapshotLifecycleResult<TSnapshot> {
  const reason = options.reason ?? DEFAULT_CANCEL_REASON;
  const nodeChanges: WorkflowGraphNodeChange[] = [];

  const nodes = snapshot.graph.nodes.map((node) => {
    if (!CANCELLABLE_STATUSES.has(node.status)) {
      return node;
    }
    nodeChanges.push(nodeChange(node, "cancelled"));
    return {
      ...node,
      error: reason,
      status: "cancelled" as const,
    };
  });

  const phaseIds: string[] = [];
  const phases = snapshot.phases.map((phase) => {
    if (!CANCELLABLE_STATUSES.has(phase.status)) {
      return phase;
    }
    phaseIds.push(phase.phase);
    return closePhase(phase, "cancelled", options.timestamp, reason);
  });

  const activityIds: string[] = [];
  const activities = snapshot.activities.map((activity) => {
    if (!CANCELLABLE_STATUSES.has(activity.status)) {
      return activity;
    }
    activityIds.push(activity.activityId);
    return closeActivity(activity, "cancelled", options.timestamp, reason);
  });

  const changed =
    snapshot.status !== "cancelled" ||
    snapshot.completedAt !== options.timestamp ||
    nodeChanges.length > 0 ||
    phaseIds.length > 0 ||
    activityIds.length > 0;

  return {
    activityIds,
    changed,
    nodeChanges,
    phaseIds,
    snapshot: changed
      ? ({
          ...snapshot,
          activities,
          completedAt: options.timestamp,
          graph: {
            collections: snapshot.graph.collections,
            edges: snapshot.graph.edges,
            nodes,
          },
          phases,
          sessionLinks: deriveWorkflowSessionLinks({ activities, runId: snapshot.runId }),
          status: "cancelled",
          updatedAt: options.timestamp,
        } as TSnapshot)
      : snapshot,
  };
}

export function reopenWorkflowGraphNode<TSnapshot extends WorkflowRunSnapshot>(
  snapshot: TSnapshot,
  options: ReopenWorkflowGraphNodeOptions,
): ReopenWorkflowGraphNodeResult<TSnapshot> {
  const node = snapshot.graph.nodes.find((item) => item.id === options.nodeId);
  if (!node) {
    throw new Error(`Workflow graph node not found: ${options.nodeId}`);
  }
  if (!REOPENABLE_STATUSES.has(node.status)) {
    throw new Error(
      `Cannot reopen workflow node "${options.nodeId}": status is "${node.status}", expected completed, failed, or skipped`,
    );
  }

  const maxReopens = options.maxReopens ?? 2;
  const reopenAttempts = node.reopenAttempts ?? 0;
  if (reopenAttempts >= maxReopens) {
    throw new Error(
      `Workflow node "${options.nodeId}" already reopened ${reopenAttempts}x (max=${maxReopens})`,
    );
  }

  const nextAttempts = reopenAttempts + 1;
  const reason = options.reason ?? DEFAULT_REOPEN_REASON;
  const nodes = snapshot.graph.nodes.map((item) =>
    item.id === options.nodeId
      ? {
          ...item,
          error: reason,
          reopenAttempts: nextAttempts,
          status: "pending" as const,
        }
      : item,
  );

  return {
    changed: true,
    nodeChange: nodeChange(node, "pending"),
    reopenAttempts: nextAttempts,
    snapshot: {
      ...snapshot,
      graph: {
        collections: snapshot.graph.collections,
        edges: snapshot.graph.edges,
        nodes,
      },
      updatedAt: options.timestamp,
    } as TSnapshot,
  };
}

export function isInScope(value: string, scope: ReadonlySet<string> | undefined): boolean {
  return !scope || scope.has(value);
}

export function shouldRepairPhase(
  phase: string,
  nodeScope: ReadonlySet<string> | undefined,
  resetPhaseIdsFromNodes: ReadonlySet<string>,
): boolean {
  if (!nodeScope) return true;
  return resetPhaseIdsFromNodes.has(phase);
}

export function shouldRepairActivity(
  activity: WorkflowActivitySnapshot,
  nodeScope: ReadonlySet<string> | undefined,
  resetPhaseIdsFromNodes: ReadonlySet<string>,
): boolean {
  if (!nodeScope) return true;
  if (activity.nodeId && nodeScope.has(activity.nodeId)) return true;
  return resetPhaseIdsFromNodes.has(activity.phase);
}

export function nodeChange(
  node: WorkflowGraphNode,
  status: WorkflowNodeStatus,
): WorkflowGraphNodeChange {
  return {
    nodeId: node.id,
    ...(node.phase ? { phase: node.phase } : {}),
    status,
  };
}

export function resetPhaseForRetry(
  phase: WorkflowPhaseSnapshot,
  reason: string,
): WorkflowPhaseSnapshot {
  return {
    error: reason,
    phase: phase.phase,
    status: "pending",
  };
}

export function closePhase(
  phase: WorkflowPhaseSnapshot,
  status: WorkflowNodeStatus,
  timestamp: string,
  reason: string,
): WorkflowPhaseSnapshot {
  return {
    ...phase,
    completedAt: phase.completedAt ?? timestamp,
    error: phase.error ?? reason,
    status,
  };
}

export function closeActivity(
  activity: WorkflowActivitySnapshot,
  status: WorkflowNodeStatus,
  timestamp: string,
  reason: string,
): WorkflowActivitySnapshot {
  return {
    ...activity,
    completedAt: activity.completedAt ?? timestamp,
    error: activity.error ?? reason,
    status,
  };
}
