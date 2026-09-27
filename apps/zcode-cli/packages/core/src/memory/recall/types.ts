export const MEMORY_RECALL_TYPES = ["user", "feedback", "project", "reference"] as const;

export type MemoryRecallType = (typeof MEMORY_RECALL_TYPES)[number];

export interface MemoryManifestEntry {
  description?: string;
  filePath: string;
  filename: string;
  mtimeMs: number;
  type?: MemoryRecallType;
}
