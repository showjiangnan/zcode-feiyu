// Modified by ZCode Feiyu.
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  externalImportSelectionSchema,
  externalImportOperationSchema,
  ZCODE_FILE_LOCK_TIMEOUT_ERROR_CODE,
  type ExternalImportOperation,
  type ExternalImportSelection,
} from "@zcode/shared";
import { acquireFileLock } from "@zcode/shared/node";

export interface ImportState {
  version: 1;
  generation: number;
  syncEnabled: boolean;
  selections: ExternalImportSelection[];
  mappings: Record<string, { revision: string; taskId: string; workspacePath: string }>;
  resources: Record<string, { revision: string; targetPath: string }>;
  operations: ExternalImportOperation[];
  lastSyncAt?: number;
  syncError?: string;
}
const stateSchema = z
  .object({
    version: z.literal(1),
    generation: z.number().int().nonnegative(),
    syncEnabled: z.boolean(),
    selections: z.array(externalImportSelectionSchema),
    mappings: z.record(
      z.string(),
      z.object({ revision: z.string(), taskId: z.string(), workspacePath: z.string() }).strict(),
    ),
    resources: z
      .record(z.string(), z.object({ revision: z.string(), targetPath: z.string() }).strict())
      .default({}),
    operations: z.array(externalImportOperationSchema),
    lastSyncAt: z.number().optional(),
    syncError: z.string().optional(),
  })
  .strict();
export function initialState(): ImportState {
  return {
    version: 1,
    generation: 0,
    syncEnabled: false,
    selections: [],
    mappings: {},
    resources: {},
    operations: [],
  };
}
export async function atomicPrivateFile(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
export async function loadState(directory: string): Promise<ImportState> {
  try {
    return stateSchema.parse(JSON.parse(await readFile(join(directory, "state.json"), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return initialState();
    throw new Error("import_state_invalid", { cause: error });
  }
}
export async function saveState(directory: string, state: ImportState): Promise<void> {
  stateSchema.parse(state);
  await atomicPrivateFile(join(directory, "state.json"), JSON.stringify(state));
}
export async function withImportLease<T>(
  directory: string,
  signal: AbortSignal,
  action: () => Promise<T>,
): Promise<T> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (;;) {
    signal.throwIfAborted();
    let release: (() => Promise<void>) | undefined;
    try {
      // 复用唯一 owner 文件的回收机制，避免旧等待者递归删除后来进程的新锁。
      release = await acquireFileLock(join(directory, "owner"), [50, 100], 60000, 2000);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== ZCODE_FILE_LOCK_TIMEOUT_ERROR_CODE) throw error;
      continue;
    }
    try {
      signal.throwIfAborted();
      return await action();
    } finally {
      await release();
    }
  }
}
