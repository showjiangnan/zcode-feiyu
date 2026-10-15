// Modified by ZCode Feiyu.
import { realpath, mkdir } from "node:fs/promises";
import type {
  ExternalImportOperation,
  ExternalImportSelection,
  ExternalImportItemResult,
} from "@zcode/shared";
import type { ExternalImportSessionPort } from "../contract.js";
import { join } from "node:path";
import { atomicPrivateFile } from "./privateState.js";
import { discover, directoryExists } from "./detection.js";
import { importPathIdentity } from "../domain/identity.js";
import { digest, readSource } from "./sourceFiles.js";
import { materializeAttachments } from "./attachments.js";
import { importResource, readMcpReview } from "./resources.js";
import { importResourceTarget, resourceMappingKey } from "./resourceTarget.js";
import type { ImportState } from "./privateState.js";

export async function runImport(options: {
  operation: ExternalImportOperation;
  state: ImportState;
  directory: string;
  targetRoot: string;
  sessionPort: ExternalImportSessionPort;
  selection: ExternalImportSelection;
  signal: AbortSignal;
  checkpoint: () => Promise<void>;
  cancelled: () => Promise<boolean>;
  registerProjects: (paths: string[]) => Promise<void>;
}): Promise<void> {
  const { operation, selection, state, signal } = options;
  const discovery = await discover(
    { source: selection.source, root: selection.root, includeArchived: selection.includeArchived },
    options.targetRoot,
    signal,
  );
  const sessions = new Map(discovery.sessions.map((item) => [item.key, item]));
  const resources = new Map(discovery.resources.map((item) => [item.key, item]));
  const selected = [...new Set([...selection.sessionKeys, ...selection.resourceKeys])];
  operation.total = selected.length + (selection.projectPaths?.length ?? 0);
  const done = new Set(
    operation.results
      .filter((item) => ["imported", "skipped", "conflict"].includes(item.status))
      .map((item) => item.key),
  );
  operation.results = operation.results.filter((item) => done.has(item.key));
  for (const key of selected) {
    if (done.has(key)) continue;
    if (signal.aborted || (await options.cancelled())) {
      operation.state = "cancelled";
      break;
    }
    let result: ExternalImportItemResult;
    const candidate = sessions.get(key);
    try {
      if (candidate) {
        const loaded = await readSource(
          selection.source,
          discovery.root,
          candidate.sourcePath,
          signal,
        );
        const current = loaded.candidate;
        if (
          selection.expectedRevisions?.[key] &&
          selection.expectedRevisions[key] !== current.revision
        )
          throw new Error("source_changed_rescan_required");
        const originalWorkspace = current.workspacePath;
        const target =
          selection.workspaceMappings?.[originalWorkspace] ||
          selection.targetWorkspacePath ||
          originalWorkspace;
        if (!target || !(await directoryExists(target)))
          throw new Error("workspace_path_missing_select_target");
        const workspacePath = await realpath(target);
        const mappingKey = digest(`${key}:${importPathIdentity(workspacePath, process.platform)}`);
        const previous = state.mappings[mappingKey];
        // 内容版本与目标目录一起决定稳定 ID，失败重试不会产生重复会话。
        const sessionId = `external-import-${digest(`${mappingKey}:${current.revision}`).slice(0, 32)}`;
        if (previous?.revision === current.revision)
          result = {
            key,
            label: candidate.title,
            status: "skipped",
            reason: "already_imported",
            taskId: previous.taskId,
            workspacePath,
          };
        else {
          const warnings = [...current.warnings];
          await materializeAttachments(loaded.messages, {
            directory: join(workspacePath, ".zcode", "external-import"),
            sourceRoot: discovery.root,
            workspacePath: originalWorkspace || workspacePath,
            warnings,
            signal,
          });
          const committed = await options.sessionPort.commit({
            sessionId,
            workspacePath,
            title: candidate.title,
            createdAt: current.createdAt,
            updatedAt: current.updatedAt,
            messages: loaded.messages,
            provenance: {
              source: selection.source,
              sourceKey: key,
              sourceSessionId: current.sessionId,
              revision: current.revision,
              ...(previous ? { previousTaskId: previous.taskId } : {}),
            },
          });
          state.mappings[mappingKey] = { revision: current.revision, ...committed };
          result = {
            key,
            label: candidate.title,
            status: previous ? "conflict" : "imported",
            reason: previous ? "source_update_saved_as_related_version" : undefined,
            ...committed,
            warnings,
          };
        }
      } else if (resources.has(key)) {
        let resource = resources.get(key)!;
        // 资源也必须与用户确认的预览一致，不能把重扫得到的新内容冒充已确认版本。
        if (
          selection.expectedRevisions?.[key] &&
          selection.expectedRevisions[key] !== resource.revision
        )
          throw new Error("source_changed_rescan_required");
        const ledgerKey = resourceMappingKey(resource, selection);
        if (resource.workspacePath && selection.workspaceMappings?.[resource.workspacePath]) {
          const target = selection.workspaceMappings[resource.workspacePath]!;
          if (!(await directoryExists(target)))
            throw new Error("workspace_path_missing_select_target");
          resource = {
            ...resource,
            targetPath: importResourceTarget(resource, selection),
          };
        }
        const previous = state.resources[ledgerKey];
        if (previous?.revision === resource.revision)
          result = {
            key,
            label: resource.name,
            status: "skipped",
            reason: "already_imported",
            targetPath: previous.targetPath,
          };
        else if (previous && resource.available && resource.sourcePath !== resource.targetPath) {
          const targetPath = join(
            options.directory,
            "imported-updates",
            ledgerKey,
            resource.revision,
            resource.name,
          );
          await mkdir(join(options.directory, "imported-updates", ledgerKey, resource.revision), {
            recursive: true,
            mode: 0o700,
          });
          if (resource.kind === "mcpServers") {
            // 更新配置保存为复核副本，不能替换正在使用的 MCP 配置。
            await atomicPrivateFile(
              targetPath + ".txt",
              await readMcpReview(
                resource,
                selection.source,
                resource.sourceRoot || discovery.root,
              ),
            );
            result = {
              key,
              label: resource.name,
              status: "conflict",
              targetPath: targetPath + ".txt",
              reason: "resource_update_requires_review",
            };
          } else {
            result = await importResource(
              {
                ...resource,
                kind: resource.kind === "plugins" ? "skills" : resource.kind,
                targetPath,
              },
              selection.source,
              resource.sourceRoot || discovery.root,
              signal,
            );
            result.status = "conflict";
            result.reason = "resource_update_requires_review";
          }
          state.resources[ledgerKey] = {
            revision: resource.revision,
            targetPath: result.targetPath!,
          };
        } else {
          result = await importResource(
            resource,
            selection.source,
            resource.sourceRoot || discovery.root,
            signal,
          );
          if (resource.available && ["imported", "conflict", "skipped"].includes(result.status))
            state.resources[ledgerKey] = {
              revision: resource.revision,
              targetPath: resource.targetPath,
            };
        }
      } else throw new Error("selection_outdated_rescan_required");
    } catch (error) {
      result = {
        key,
        label: candidate?.title || resources.get(key)?.name || key,
        ...(resources.has(key)
          ? { targetPath: importResourceTarget(resources.get(key)!, selection) }
          : {}),
        status: signal.aborted ? "cancelled" : "failed",
        reason: error instanceof Error ? error.message : "import_failed",
      };
    }
    operation.results.push(result);
    operation.completed = operation.results.length;
    await options.checkpoint();
  }
  if (!signal.aborted && operation.state !== "cancelled") {
    const allowed = new Set(discovery.sessions.map((item) => item.workspacePath));
    for (const path of selection.projectPaths ?? []) {
      const key = `project:${path}`;
      if (done.has(key)) continue;
      if (signal.aborted || (await options.cancelled())) {
        operation.state = "cancelled";
        break;
      }
      const target = selection.workspaceMappings?.[path] || selection.targetWorkspacePath || path;
      try {
        if (!allowed.has(path) || !(await directoryExists(target)))
          throw new Error("workspace_path_missing_select_target");
        // 登记与结果必须使用相同身份；原始路径别名会让 UI 建立第二个 workspace tab。
        const workspacePath = await realpath(target);
        await options.registerProjects([workspacePath]);
        operation.results.push({ key, label: path, status: "imported", workspacePath });
      } catch (error) {
        operation.results.push({
          key,
          label: path,
          status: "failed",
          reason: error instanceof Error ? error.message : "project_import_failed",
        });
      }
      operation.completed = operation.results.length;
      await options.checkpoint();
    }
  }
  operation.state = signal.aborted || operation.state === "cancelled" ? "cancelled" : "completed";
  operation.finishedAt = Date.now();
}
