// Modified by ZCode Feiyu contributors (2026).
import {
  readMemoryCapabilities,
  unsupportedMemoryCapabilities,
} from "./workspace-memory-capabilities.js";
import { readMemoryCatalog, readMemoryCatalogFile, readMemoryFile } from "./memory-catalog.js";
import { resolveWorkspaceRefFromId } from "./workspace.js";
import { getWorkspaceMaintenanceApps } from "./maintenance-registry.js";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import { createConfig, resolvePath } from "@zcode/adapters/config";
import { createInMemorySessionEventStore } from "@zcode/adapters/storage";
import {
  commitMemoryHistory,
  listMemoryHistory,
  readMemoryHistory,
  recoverMemoryHistory,
  withSecureMemoryFile,
} from "@zcode/adapters/fs";
import { resolveProjectMemoryRoot, withProjectMemoryWriteLease } from "@zcode/core";
import {
  isRemoteWorkspaceIdentity,
  zcodeWorkspaceMemoryParamsSchema,
  type WorkspaceMemoryResult,
} from "@zcode/shared";
import { isTaskRoot, type SessionId } from "@zcode/contracts";
import { getCliStorageRoot } from "../app/paths.js";
import type { ZCodeApp } from "../app/types.js";
import { createWorkspaceZCodeApp } from "./workspace-model-runtime.js";
import { parseParams, type ZCodeProtocolAgentServerContext } from "./server-types.js";

const pendingMaintenance = new WeakMap<ZCodeProtocolAgentServerContext, Set<string>>();
const PAGE_SIZE = 50;
const cursorSchema = z
  .object({
    kind: z.enum(["history", "status"]),
    workspaceKey: z.string(),
    root: z.string(),
    time: z.number().int().nonnegative(),
    id: z.string().min(1),
  })
  .strict();
type CursorScope = Pick<z.infer<typeof cursorSchema>, "kind" | "workspaceKey" | "root">;
function decodeCursor(value: string | undefined, scope: CursorScope) {
  if (!value) return undefined;
  const cursor = cursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString()));
  // 两种列表时间戳可能相同；只绑定物理根会让历史游标被整理列表误用而静默漏页。
  if (
    cursor.root !== scope.root ||
    cursor.workspaceKey !== scope.workspaceKey ||
    cursor.kind !== scope.kind
  ) {
    throw new Error("Memory cursor belongs to another workspace or operation");
  }
  return cursor;
}
const cursorFor = (scope: CursorScope, time: number, id: string) =>
  Buffer.from(JSON.stringify({ ...scope, time, id })).toString("base64url");

/** 工作区维护不依赖当前 UI 选中的线程；会话历史仅按显式范围读取。 */
export async function workspaceMemory(
  context: ZCodeProtocolAgentServerContext,
  raw: unknown,
): Promise<WorkspaceMemoryResult> {
  const { workspace, operation } = parseParams(zcodeWorkspaceMemoryParamsSchema, raw);
  // 远程工作区没有本地 CLI 受控端口；能力查询按“不支持并给出原因”返回，其余操作保持显式报错。
  if (
    (workspace.remoteSessionId ||
      isRemoteWorkspaceIdentity(workspace.workspaceIdentity?.trim() || workspace.workspaceKey)) &&
    operation.type === "capabilities"
  ) {
    // unsupported 是只读环境事实；远端会话不在本地库中，不能要求伪造本地 session 才回答。
    return unsupportedMemoryCapabilities();
  }
  if (operation.type !== "capabilities") {
    // identity 不是远程标志；保留本地 identity，同时禁止路径和身份键不一致导致读写/状态串域。
    const workspaceKey = workspace.workspaceIdentity?.trim() || workspace.workspacePath;
    if (workspace.workspaceKey !== workspaceKey)
      throw new Error("Memory workspace key does not match its identity");
    if (workspace.remoteSessionId || resolveWorkspaceRefFromId(workspaceKey).workspaceIdentity) {
      throw new Error("Memory maintenance requires a local workspace");
    }
  }
  const store = context.deps.sessionStore;
  if (!store) throw new Error("Memory storage is unavailable");
  if (operation.type === "capabilities")
    return readMemoryCapabilities(context, workspace, operation.sessionId);
  const config = createConfig({ env: context.deps.env, workingDirectory: workspace.workspacePath });
  const cliStorageRoot = getCliStorageRoot(resolvePath(config.config.storage.dir));
  if (operation.type === "catalog")
    return {
      type: "catalog",
      workspaces: await readMemoryCatalog(join(cliStorageRoot, "memories", "projects")),
    };
  if (operation.type === "readCatalogFile")
    return readMemoryCatalogFile(join(cliStorageRoot, "memories", "projects"), operation);
  const root = resolveProjectMemoryRoot({
    cliStorageRoot,
    workspacePath: workspace.workspacePath,
    workspaceIdentity: workspace.workspaceIdentity,
  });
  const directory = join(cliStorageRoot, "memory-history");
  const fence = <T>(run: Parameters<typeof withProjectMemoryWriteLease<T>>[0]["operation"]) =>
    withProjectMemoryWriteLease({ sessionStore: store, workspaceKey: root, operation: run });
  if (operation.type === "history") {
    const scope: CursorScope = { kind: operation.type, workspaceKey: workspace.workspaceKey, root };
    const cursor = decodeCursor(operation.cursor, scope);
    await fence((_signal, guard) => guard(() => recoverMemoryHistory(directory, root)));
    const rows = await listMemoryHistory(
      directory,
      root,
      cursor && { createdAt: cursor.time, operationId: cursor.id },
      PAGE_SIZE + 1,
      true,
    );
    const entries = rows
      .slice(0, PAGE_SIZE)
      .map(({ rootDir: _rootDir, before: _before, after: _after, ...entry }) => entry);
    const last = entries.at(-1);
    return {
      type: "history",
      entries,
      nextCursor:
        rows.length > PAGE_SIZE && last ? cursorFor(scope, last.createdAt, last.operationId) : null,
    };
  }
  if (operation.type === "revision") {
    const entry = await readMemoryHistory(directory, root, operation.operationId);
    if (!entry) throw new Error("Memory revision was not found");
    let currentHash: string | null = null;
    try {
      currentHash = await withSecureMemoryFile(
        root,
        entry.path,
        false,
        async (handle) => (await handle.read()).hash,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const { rootDir: _rootDir, ...value } = entry;
    return { type: "revision", entry: value, currentHash };
  }
  if (operation.type === "readFile") return readMemoryFile(root, root, operation.fileName);
  if (operation.type === "revert") {
    const assertAllowed = () => {
      context.assertServing?.();
      if (context.appRuntimePreferences.memory?.enabled !== true)
        throw new Error("Memory editing is disabled");
    };
    assertAllowed();
    const entry = await readMemoryHistory(directory, root, operation.operationId);
    if (!entry || entry.state !== "committed") throw new Error("Memory revision is not committed");
    const path = relative(root, entry.path);
    if (path.startsWith(`..${sep}`) || path === ".." || isAbsolute(path) || !path.endsWith(".md"))
      throw new Error("Invalid memory history path");
    const value = await fence(async (signal, guard) => {
      // 等待历史 IO/写租约时许可可被撤销；复核必须位于共同排他 guard 内，不能仅检查入站快照。
      const allowedGuard: typeof guard = (commit) =>
        guard(() => {
          assertAllowed();
          return commit();
        });
      const request = {
        path: entry.path,
        content: entry.before ?? "",
        createParents: true,
        ...(operation.expectedHash !== null
          ? { expectedRevision: { id: operation.expectedHash, hash: operation.expectedHash } }
          : { expectedAbsent: true }),
        memoryCommit: {
          rootDir: root,
          operationId: randomUUID(),
          sourceSessionId: "user:memory-revert",
          guard: allowedGuard,
        },
      };
      return entry.before === null
        ? commitMemoryHistory(directory, request, signal, true)
        : commitMemoryHistory(directory, request, signal);
    });
    return { type: "reverted", path: entry.path, hash: value?.hash ?? null };
  }
  if (operation.type === "status") {
    const scope: CursorScope = { kind: operation.type, workspaceKey: workspace.workspaceKey, root };
    const cursor = decodeCursor(operation.cursor, scope);
    const [current, rows] = await Promise.all([
      store.getProjectMemoryReview?.(workspace.workspaceKey) ?? null,
      store.listProjectMemoryReviews?.(
        workspace.workspaceKey,
        cursor && { startedAt: cursor.time, reviewId: cursor.id },
      ) ?? [],
    ]);
    const runs = rows.slice(0, PAGE_SIZE),
      last = runs.at(-1);
    // 门槛进度只读统计，与认领共用候选口径；旧执行端不提供时字段缺省，界面按未知处理（复审 GAP-05）。
    // status 操作没有「当前会话」入参：workspace 范围本就把当前会话排除在候选之外，
    // current_session 范围由整理记录里冻结的范围决定，因此这里不再猜测一个会话身份。
    const thresholdProgress = store.readProjectMemoryReviewThreshold
      ? await store.readProjectMemoryReviewThreshold({
          workspaceKey: workspace.workspaceKey,
          workspacePath: workspace.workspacePath,
          currentSessionId: "" as SessionId,
          historyScope:
            current?.historyScope ??
            context.appRuntimePreferences.memory?.continuityPolicy?.memoryHistoryScope ??
            "workspace",
          now: Date.now(),
        })
      : undefined;
    return {
      type: "status",
      current,
      runs,
      ...(thresholdProgress ? { thresholdProgress } : {}),
      nextCursor:
        rows.length > PAGE_SIZE && last ? cursorFor(scope, last.startedAt, last.reviewId) : null,
    };
  }
  if (operation.type === "cancelReview") {
    const apps = getWorkspaceMaintenanceApps(context);
    const app = apps.get(workspace.workspaceKey);
    const records = [...context.sessions.entries()]
      .filter(([, record]) => record.workspace.workspaceKey === workspace.workspaceKey)
      .map(([id, record]) => ({ id, record, app: record.app }));
    const accepted =
      (await store.requestCancelProjectMemoryReview?.({
        workspaceKey: workspace.workspaceKey,
        reviewId: operation.reviewId,
      })) ?? false;
    const current = accepted
      ? await store.getProjectMemoryReview?.(workspace.workspaceKey)
      : undefined;
    // 取消响应可能晚于新整理/会话切换；只唤醒捕获的 owner，runtime 再按唯一 reviewId 拒绝旧请求。
    if (
      current?.reviewId === operation.reviewId &&
      current.status === "running" &&
      current.cancelRequested
    ) {
      if (app && apps.get(workspace.workspaceKey) === app)
        app.runtime.cancelProjectMemoryReview(operation.reviewId);
      for (const target of records) {
        if (
          context.sessions.get(target.id) === target.record &&
          target.record.app === target.app &&
          target.record.workspace.workspaceKey === workspace.workspaceKey
        )
          target.app.runtime.cancelProjectMemoryReview(operation.reviewId);
      }
    }
    return { type: "cancelled", accepted };
  }
  const apps = getWorkspaceMaintenanceApps(context);
  if (apps.has(workspace.workspaceKey))
    return { type: "review", result: { status: "skipped", reason: "running" } };
  const disabled = (): WorkspaceMemoryResult => ({
    type: "review",
    result: { status: "skipped", reason: "disabled" },
  });
  if (!context.appRuntimePreferences.memory?.enabled) return disabled();
  if (!operation.selection) throw new Error("Select a configured model before memory maintenance");
  const assertScope = () => {
    context.assertServing?.();
    if (
      context.appRuntimePreferences.memory?.continuityPolicy?.memoryHistoryScope ===
        "current_session" &&
      !operation.sourceSessionId
    ) {
      throw new Error("Select a session for current-session history scope");
    }
  };
  const validateSource = async () => {
    assertScope();
    if (!operation.sourceSessionId) return;
    const source = await store.getSession(operation.sourceSessionId as SessionId);
    // 显式子任务即使缺 parentID 也不成为根；旧数据缺类型时由公共判定保留 parent fallback。
    if (
      !source ||
      (source.workspaceID?.trim() || source.directory) !== workspace.workspaceKey ||
      !isTaskRoot(source.taskType, source.parentID)
    )
      throw new Error("Maintenance source is outside this workspace");
  };
  await validateSource();
  if (!context.appRuntimePreferences.memory?.enabled) return disabled();
  assertScope();
  let pending = pendingMaintenance.get(context);
  if (!pending) {
    pending = new Set();
    pendingMaintenance.set(context, pending);
  }
  if (pending.has(workspace.workspaceKey) || apps.has(workspace.workspaceKey))
    return { type: "review", result: { status: "skipped", reason: "running" } };
  pending.add(workspace.workspaceKey);
  let app: ZCodeApp | undefined;
  try {
    const prefs = context.appRuntimePreferences.memory;
    app = await createWorkspaceZCodeApp(context, workspace, {
      env: context.deps.env,
      eventStore: createInMemorySessionEventStore(),
      runtimeConfig: {
        workingDirectory: workspace.workspacePath,
        memory: {
          enabled: prefs.enabled,
          extractionEnabled: false,
          reviewEnabled: prefs.reviewEnabled,
        },
      },
      sessionStore: store,
      version: context.deps.version,
    });
    context.assertServing?.();
    if (!context.appRuntimePreferences.memory?.enabled) return disabled();
    apps.set(workspace.workspaceKey, app);
    await app.runtime.updateProjectMemoryPreferences({
      ...context.appRuntimePreferences.memory,
      extractionEnabled: false,
    });
    await app.setModel(operation.selection, { transient: true });
    // 装配/选模期间许可、范围或会话归属可能变化；不能让旧选择在最新 current_session 范围下准入。
    if (!context.appRuntimePreferences.memory?.enabled) return disabled();
    await validateSource();
    if (!context.appRuntimePreferences.memory?.enabled) return disabled();
    assertScope();
    return {
      type: "review",
      result: await app.runtime.reviewProjectMemoryNow(operation.sourceSessionId),
    };
  } finally {
    pending.delete(workspace.workspaceKey);
    if (apps.get(workspace.workspaceKey) === app) apps.delete(workspace.workspaceKey);
    await app?.close?.();
  }
}
