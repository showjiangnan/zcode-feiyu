// Modified by ZCode Feiyu.
import { watch } from "node:fs";
import { access, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Emitter } from "@zcode/rpc";
import {
  externalImportSelectionSchema,
  externalImportSourceSchema,
  type ExternalImportDetectRequest,
  type ExternalImportDiscovery,
  type ExternalImportOperation,
  type ExternalImportSelection,
  type ExternalImportView,
} from "@zcode/shared";
import type { IExternalImportService } from "../contract.js";
import {
  atomicPrivateFile,
  initialState,
  loadState,
  saveState,
  withImportLease,
} from "./privateState.js";
import { discover } from "./detection.js";
import { runImport } from "./operation.js";
import { importPathIdentity } from "../domain/identity.js";
import { resourceMappingKey } from "./resourceTarget.js";
import { detectImportPreview } from "./preview.js";
import { ImportScanRequests } from "./scanRequests.js";
import { digest } from "./sourceFiles.js";

import type { ImportOwnerOptions } from "./options.js";
export type { ImportOwnerOptions } from "./options.js";
export class ExternalImportOwner implements IExternalImportService {
  private state = initialState();
  private readonly changed = new Emitter<ExternalImportView>();
  readonly onDidChange = this.changed.event;
  private readonly shutdown = new AbortController();
  private readonly scans = new ImportScanRequests(this.shutdown.signal);
  private readonly active = new Map<
    string,
    { controller: AbortController; automatic: boolean; promise: Promise<ExternalImportOperation> }
  >();
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  constructor(private readonly options: ImportOwnerOptions) {}
  async start(): Promise<void> {
    if (!this.options.supported || this.shutdown.signal.aborted || this.timer) return;
    await withImportLease(this.options.directory, this.shutdown.signal, async () => {
      this.state = await loadState(this.options.directory);
      // 取得全局锁后仍处于 running 的记录属于已退出 writer，保留提交事实并提供重试。
      for (const operation of this.state.operations)
        if (operation.state === "running") {
          operation.state = "cancelled";
          operation.finishedAt = Date.now();
        }
      await saveState(this.options.directory, this.state);
    });
    if (this.shutdown.signal.aborted) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => {});
    }, this.options.intervalMs ?? 15000);
    this.timer.unref();
    await this.tick();
  }
  private view(): ExternalImportView {
    const { syncEnabled, generation, selections, operations, lastSyncAt, syncError } = this.state;
    return structuredClone({
      supported: this.options.supported,
      syncEnabled,
      generation,
      selections,
      operations: operations.slice(-50).reverse(),
      lastSyncAt,
      syncError,
    });
  }
  private publish(): void {
    this.changed.fire(this.view());
  }
  private assertSupported(): void {
    if (!this.options.supported || this.shutdown.signal.aborted)
      throw new Error("desktop_import_required");
  }
  async getView(): Promise<ExternalImportView> {
    if (this.options.supported) this.state = await loadState(this.options.directory);
    return this.view();
  }
  async detect(request: ExternalImportDetectRequest): Promise<ExternalImportDiscovery> {
    this.assertSupported();
    externalImportSourceSchema.parse(request.source);
    return this.scans.run(request.requestId, (signal, id) =>
      detectImportPreview(request, this.options, signal, id),
    );
  }
  async cancelDetection(requestId: string): Promise<void> {
    this.assertSupported();
    this.scans.cancel(requestId);
  }
  async execute(request: {
    operationId: string;
    selection: ExternalImportSelection;
  }): Promise<ExternalImportOperation> {
    return this.executeOwned(request, false);
  }
  private async executeOwned(
    request: { operationId: string; selection: ExternalImportSelection },
    automatic: boolean,
    expectedGeneration?: number,
  ): Promise<ExternalImportOperation> {
    this.assertSupported();
    if (!/^[\w-]{1,160}$/u.test(request.operationId)) throw new Error("invalid_operation_id");
    const existing = this.active.get(request.operationId);
    if (existing) return existing.promise;
    const selection = externalImportSelectionSchema.parse(request.selection);
    const controller = new AbortController();
    const stop = () => controller.abort(this.shutdown.signal.reason);
    this.shutdown.signal.addEventListener("abort", stop, { once: true });
    const promise = withImportLease(this.options.directory, controller.signal, async () => {
      this.state = await loadState(this.options.directory);
      if (automatic && (!this.state.syncEnabled || this.state.generation !== expectedGeneration))
        return {
          id: request.operationId,
          automatic,
          source: selection.source,
          startedAt: Date.now(),
          finishedAt: Date.now(),
          state: "cancelled" as const,
          total: 0,
          completed: 0,
          results: [],
          selection,
        };
      let operation = this.state.operations.find((item) => item.id === request.operationId);
      if (operation && JSON.stringify(operation.selection) !== JSON.stringify(selection))
        throw new Error("operation_selection_conflict");
      if (operation?.state === "completed") return structuredClone(operation);
      if (!operation) {
        operation = {
          id: request.operationId,
          automatic,
          source: selection.source,
          startedAt: Date.now(),
          state: "running",
          total: 0,
          completed: 0,
          results: [],
          selection,
        };
        this.state.operations.push(operation);
      }
      operation.state = "running";
      this.state.generation++;
      const operationState = this.state;
      const checkpoint = async () => {
        operationState.generation++;
        await saveState(this.options.directory, operationState);
        this.state = operationState;
        this.publish();
      };
      await checkpoint();
      const cancelledPath = join(this.options.directory, `${request.operationId}.cancel`);
      const cancellation = watch(this.options.directory, (_event, filename) => {
        if (filename?.toString() === `${request.operationId}.cancel`)
          void access(cancelledPath).then(
            () => controller.abort(new Error("cancelled")),
            () => {},
          );
      });
      cancellation.on("error", () => controller.abort(new Error("import_control_unavailable")));
      try {
        await runImport({
          operation,
          selection,
          state: operationState,
          directory: this.options.directory,
          targetRoot: this.options.targetRoot,
          sessionPort: this.options.sessionPort,
          signal: controller.signal,
          checkpoint,
          registerProjects: this.options.registerProjects,
          cancelled: () =>
            access(join(this.options.directory, `${request.operationId}.cancel`)).then(
              () => true,
              () => false,
            ),
        });
      } catch (error) {
        operation.state = controller.signal.aborted ? "cancelled" : "completed";
        operation.results.push({
          key: "operation",
          label: "Import",
          status: controller.signal.aborted ? "cancelled" : "failed",
          reason: error instanceof Error ? error.message : "import_failed",
        });
        operation.finishedAt = Date.now();
      } finally {
        cancellation.close();
      }
      if (
        !automatic &&
        operation.results.some(
          (item) =>
            item.status === "imported" ||
            item.taskId ||
            (item.targetPath &&
              (item.status === "conflict" ||
                (item.status === "skipped" &&
                  ["already_imported", "instructions_already_available"].includes(
                    item.reason ?? "",
                  )))),
        )
      ) {
        const previousScope = operationState.selections.find(
          (item) => item.source === selection.source && item.root === selection.root,
        );
        if (previousScope) {
          previousScope.sessionKeys = [
            ...new Set([...previousScope.sessionKeys, ...selection.sessionKeys]),
          ];
          previousScope.resourceKeys = [
            ...new Set([...previousScope.resourceKeys, ...selection.resourceKeys]),
          ];
          previousScope.workspaceMappings = {
            ...previousScope.workspaceMappings,
            ...selection.workspaceMappings,
          };
          previousScope.includeArchived ||= selection.includeArchived;
          previousScope.targetWorkspacePath =
            selection.targetWorkspacePath ?? previousScope.targetWorkspacePath;
        } else operationState.selections.push(selection);
      }
      operationState.operations = operationState.operations.slice(-100);
      await checkpoint();
      await rm(join(this.options.directory, `${request.operationId}.cancel`), { force: true });
      return structuredClone(operation);
    }).finally(() => {
      this.shutdown.signal.removeEventListener("abort", stop);
      this.active.delete(request.operationId);
    });
    this.active.set(request.operationId, { controller, automatic, promise });
    return promise;
  }
  async cancel(operationId: string): Promise<void> {
    this.assertSupported();
    if (!/^[\w-]{1,160}$/u.test(operationId)) throw new Error("invalid_operation_id");
    await atomicPrivateFile(join(this.options.directory, `${operationId}.cancel`), "cancelled");
    this.active.get(operationId)?.controller.abort(new Error("cancelled"));
  }
  async configure(request: {
    enabled?: boolean;
    selections?: ExternalImportSelection[];
  }): Promise<ExternalImportView> {
    this.assertSupported();
    for (const item of this.active.values())
      if (item.automatic) item.controller.abort(new Error("sync_scope_changed"));
    const pending = await loadState(this.options.directory);
    for (const operation of pending.operations)
      if (operation.automatic && operation.state === "running")
        await atomicPrivateFile(
          join(this.options.directory, `${operation.id}.cancel`),
          "sync_scope_changed",
        );
    await withImportLease(this.options.directory, this.shutdown.signal, async () => {
      this.state = await loadState(this.options.directory);
      if (request.selections) {
        this.state.selections = request.selections
          .map((item) => externalImportSelectionSchema.parse(item))
          .filter(
            (item) =>
              item.sessionKeys.length || item.resourceKeys.length || item.projectPaths?.length,
          );
        if (!this.state.selections.length) this.state.syncEnabled = false;
      }
      if (request.enabled !== undefined) {
        if (request.enabled && !this.state.selections.length)
          throw new Error("first_import_required");
        this.state.syncEnabled = request.enabled;
      }
      this.state.generation++;
      await saveState(this.options.directory, this.state);
    });
    this.publish();
    return this.view();
  }
  async retry(operationId: string, retryOperationId?: string): Promise<ExternalImportOperation> {
    const view = await this.getView();
    const previous = view.operations.find((item) => item.id === operationId);
    if (!previous) throw new Error("operation_not_found");
    const keys = new Set(
      previous.results
        .filter((item) => item.status === "failed" || item.status === "cancelled")
        .map((item) => item.key),
    );
    const unfinished = new Set(
      [...previous.selection.sessionKeys, ...previous.selection.resourceKeys].filter(
        (key) => !previous.results.some((item) => item.key === key),
      ),
    );
    const retryKeys = new Set([...keys, ...unfinished]);
    return this.execute({
      operationId: retryOperationId ?? randomUUID(),
      selection: {
        ...previous.selection,
        expectedRevisions: undefined,
        sessionKeys: previous.selection.sessionKeys.filter((key) => retryKeys.has(key)),
        resourceKeys: previous.selection.resourceKeys.filter((key) => retryKeys.has(key)),
        projectPaths: previous.selection.projectPaths?.filter((path) =>
          keys.has(`project:${path}`),
        ),
      },
    });
  }
  private async tick(): Promise<void> {
    if (this.ticking || this.shutdown.signal.aborted) return;
    this.ticking = true;
    try {
      const state = await loadState(this.options.directory);
      this.state = state;
      this.publish();
      if (!state.syncEnabled) return;
      for (const selection of state.selections) {
        const discovery = await discover(
          {
            source: selection.source,
            root: selection.root,
            includeArchived: selection.includeArchived,
          },
          this.options.targetRoot,
          this.shutdown.signal,
        );
        const keys = discovery.sessions
          .filter((item) => {
            if (item.running || !selection.sessionKeys.includes(item.key)) return false;
            const target =
              selection.workspaceMappings?.[item.workspacePath] ||
              selection.targetWorkspacePath ||
              item.workspacePath;
            return (
              state.mappings[digest(`${item.key}:${importPathIdentity(target, process.platform)}`)]
                ?.revision !== item.revision
            );
          })
          .map((item) => item.key);
        const resources = discovery.resources
          .filter(
            (item) =>
              item.available &&
              selection.resourceKeys.includes(item.key) &&
              state.resources[resourceMappingKey(item, selection)]?.revision !== item.revision,
          )
          .map((item) => item.key);
        if (keys.length || resources.length)
          await this.executeOwned(
            {
              operationId: randomUUID(),
              selection: {
                ...selection,
                sessionKeys: keys,
                resourceKeys: resources,
                projectPaths: [],
                expectedRevisions: undefined,
              },
            },
            true,
            state.generation,
          );
      }
      await withImportLease(this.options.directory, this.shutdown.signal, async () => {
        this.state = await loadState(this.options.directory);
        this.state.generation++;
        this.state.lastSyncAt = Date.now();
        delete this.state.syncError;
        await saveState(this.options.directory, this.state);
      });
      this.publish();
    } catch (error) {
      if (!this.shutdown.signal.aborted) {
        await withImportLease(this.options.directory, this.shutdown.signal, async () => {
          this.state = await loadState(this.options.directory);
          this.state.syncError = error instanceof Error ? error.message : "sync_failed";
          await saveState(this.options.directory, this.state);
        });
        this.publish();
      }
    } finally {
      this.ticking = false;
    }
  }
  async dispose(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.shutdown.abort(new Error("host_closed"));
    await Promise.allSettled([...this.active.values()].map((item) => item.promise));
    this.changed.dispose();
  }
}
