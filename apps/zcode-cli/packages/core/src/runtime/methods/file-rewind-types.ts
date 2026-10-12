// Modified by ZCode Feiyu.
import type { CheckpointCreatedPayload, WorkspaceCheckpointArtifact } from "../deps.js";
import type { WorkspaceFileRewindPreview, WorkspaceFileRewindUnsafeReason } from "../types.js";

export type PlannedFileState = {
  content: string | null;
  exists: boolean;
  hash: string | null;
};

export type FileCheckpointOperation = {
  action: "restore" | "delete";
  afterContent: string | null;
  artifact: WorkspaceCheckpointArtifact;
  beforeContent: string | null;
  checkpoint: CheckpointCreatedPayload;
  path: string;
  toolName: string;
};

export type WorkspaceFileRewindPlan = WorkspaceFileRewindPreview & {
  operations: FileCheckpointOperation[];
};

export type FileRewindJournalEntry = {
  path: string;
  state: PlannedFileState;
};

export interface FileAggregate {
  action: "restore" | "delete";
  operationCount: number;
  path: string;
  toolNames: Set<string>;
  unsafe?: {
    currentHash?: string;
    expectedHash?: string;
    message?: string;
    reason: WorkspaceFileRewindUnsafeReason;
  };
}

export interface IgnoredFileAggregate {
  operationCount: number;
  path: string;
  toolNames: Set<string>;
}
