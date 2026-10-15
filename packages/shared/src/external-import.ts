// Modified by ZCode Feiyu.
import { z } from "zod";

export const externalImportSourceSchema = z.enum(["claudeCode", "codex"]);
export type ExternalImportSource = z.infer<typeof externalImportSourceSchema>;
export const externalHistoryFileSchema = z
  .object({ type: z.literal("file"), mime: z.string(), filename: z.string(), url: z.string() })
  .strict();
export const externalHistoryBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("reasoning"), text: z.string() }).strict(),
  z
    .object({ type: z.literal("file"), mime: z.string(), filename: z.string(), url: z.string() })
    .strict(),
  z
    .object({
      type: z.literal("tool"),
      callId: z.string(),
      name: z.string(),
      input: z.record(z.string(), z.unknown()),
      output: z.string(),
      status: z.enum(["completed", "error", "interrupted"]),
      attachments: z.array(externalHistoryFileSchema).optional(),
    })
    .strict(),
]);
export const externalHistoryMessageSchema = z
  .object({
    id: z.string(),
    role: z.enum(["user", "assistant"]),
    content: z.string(),
    timestamp: z.number().finite(),
    phase: z.string().optional(),
    model: z.string().optional(),
    blocks: z.array(externalHistoryBlockSchema),
  })
  .strict();
export type ExternalHistoryMessage = z.infer<typeof externalHistoryMessageSchema>;
export const externalImportProvenanceSchema = z
  .object({
    source: externalImportSourceSchema,
    sourceKey: z.string().regex(/^[a-f0-9]{64}$/u),
    revision: z.string().regex(/^[a-f0-9]{64}$/u),
    sourceSessionId: z.string(),
    previousTaskId: z.string().optional(),
  })
  .strict();
export type ExternalImportProvenance = z.infer<typeof externalImportProvenanceSchema>;
export interface ExternalImportCandidate {
  key: string;
  source: ExternalImportSource;
  sessionId: string;
  title: string;
  workspacePath: string;
  sourcePath: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  running: boolean;
  messageCount: number;
  warnings: string[];
  revision: string;
  importedTaskId?: string;
}
export type ExternalImportResourceKind =
  | "settings"
  | "instructions"
  | "skills"
  | "commands"
  | "plugins"
  | "mcpServers"
  | "memory";
export interface ExternalImportResource {
  key: string;
  kind: ExternalImportResourceKind;
  name: string;
  sourcePath: string;
  targetPath: string;
  available: boolean;
  reason?: string;
  workspacePath?: string;
  revision: string;
  sourceRoot?: string;
}
export interface ExternalImportSelection {
  source: ExternalImportSource;
  root: string;
  sessionKeys: string[];
  resourceKeys: string[];
  includeArchived: boolean;
  targetWorkspacePath?: string;
  projectPaths?: string[];
  workspaceMappings?: Record<string, string>;
  expectedRevisions?: Record<string, string>;
}
export interface ExternalImportDiscovery {
  source: ExternalImportSource;
  root: string;
  requestId: string;
  sessions: ExternalImportCandidate[];
  resources: ExternalImportResource[];
  total: number;
  nextCursor?: number;
  warnings: string[];
}
export interface ExternalImportItemResult {
  key: string;
  label: string;
  status: "imported" | "skipped" | "conflict" | "failed" | "cancelled";
  reason?: string;
  taskId?: string;
  workspacePath?: string;
  warnings?: string[];
  targetPath?: string;
}
export interface ExternalImportOperation {
  id: string;
  automatic?: boolean;
  source: ExternalImportSource;
  startedAt: number;
  finishedAt?: number;
  state: "running" | "completed" | "cancelled";
  total: number;
  completed: number;
  results: ExternalImportItemResult[];
  selection: ExternalImportSelection;
}
export interface ExternalImportView {
  supported: boolean;
  syncEnabled: boolean;
  generation: number;
  selections: ExternalImportSelection[];
  operations: ExternalImportOperation[];
  lastSyncAt?: number;
  syncError?: string;
}
export interface ExternalImportDetectRequest {
  requestId?: string;
  source: ExternalImportSource;
  root?: string;
  includeArchived?: boolean;
  modifiedSince?: number;
  query?: string;
  cursor?: number;
  limit?: number;
}
export const externalImportSelectionSchema = z
  .object({
    source: externalImportSourceSchema,
    root: z.string().min(1),
    sessionKeys: z.array(z.string()).max(10000),
    resourceKeys: z.array(z.string()).max(10000),
    includeArchived: z.boolean(),
    projectPaths: z.array(z.string()).optional(),
    workspaceMappings: z.record(z.string(), z.string()).optional(),
    expectedRevisions: z.record(z.string(), z.string()).optional(),
    targetWorkspacePath: z.string().min(1).optional(),
  })
  .strict();
export const externalImportOperationSchema = z
  .object({
    id: z.string().regex(/^[\w-]{1,160}$/u),
    automatic: z.boolean().optional(),
    source: externalImportSourceSchema,
    startedAt: z.number().finite(),
    finishedAt: z.number().finite().optional(),
    state: z.enum(["running", "completed", "cancelled"]),
    total: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    selection: externalImportSelectionSchema,
    results: z.array(
      z
        .object({
          key: z.string(),
          label: z.string(),
          status: z.enum(["imported", "skipped", "conflict", "failed", "cancelled"]),
          reason: z.string().optional(),
          taskId: z.string().optional(),
          workspacePath: z.string().optional(),
          warnings: z.array(z.string()).optional(),
          targetPath: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict();
