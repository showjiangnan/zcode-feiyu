// Modified by ZCode Feiyu.
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ExternalImportDiscovery,
  ExternalImportOperation,
  ExternalImportSelection,
  ExternalImportSource,
  ExternalImportView,
} from "@zcode/shared";
import { useServices } from "./useServices.js";
import { usePlatform } from "./usePlatform.js";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { invalidateTaskQueryCacheByScopes } from "@/store/taskQueryCacheStore.js";

const unavailable: ExternalImportView = {
  supported: false,
  syncEnabled: false,
  generation: 0,
  selections: [],
  operations: [],
};
export function useExternalImport(isDesktop: boolean) {
  const { externalImportService: service } = useServices();
  const platform = usePlatform();
  const tabs = useTabStoreApi();
  const [view, setView] = useState(unavailable);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [discovery, setDiscovery] = useState<ExternalImportDiscovery | null>(null);
  const [operation, setOperation] = useState<ExternalImportOperation | null>(null);
  const scanRequest = useRef<string | undefined>(undefined);
  const generation = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    if (!isDesktop || !service) {
      setView(unavailable);
      return;
    }
    let disposed = false;
    service.getView().then(
      (next) => {
        if (!disposed)
          setView((current) => (next.generation >= current.generation ? next : current));
      },
      (cause) => {
        if (!disposed) {
          setView(unavailable);
          setError(cause instanceof Error ? cause.message : "import_failed");
        }
      },
    );
    const subscription = service.onDidChange((next) => {
      if (disposed) return;
      setView((current) => (next.generation >= current.generation ? next : current));
      setOperation((current) =>
        current ? (next.operations.find((item) => item.id === current.id) ?? current) : null,
      );
    });
    return () => {
      disposed = true;
      mounted.current = false;
      generation.current++;
      if (scanRequest.current) void service.cancelDetection(scanRequest.current).catch(() => {});
      subscription.dispose();
    };
  }, [isDesktop, service]);
  const scan = useCallback(
    async (
      source: ExternalImportSource,
      options: {
        root?: string;
        query?: string;
        includeArchived?: boolean;
        modifiedSince?: number;
        cursor?: number;
      } = {},
    ) => {
      if (!service || !isDesktop) return;
      if (scanRequest.current) void service.cancelDetection(scanRequest.current).catch(() => {});
      const requestId = crypto.randomUUID();
      scanRequest.current = requestId;
      const request = ++generation.current;
      setLoading(true);
      setError(null);
      if (!options.cursor) setDiscovery(null);
      try {
        const result = await service.detect({ source, ...options, requestId });
        if (!mounted.current || request !== generation.current) return;
        setDiscovery((previous) =>
          options.cursor && previous?.source === result.source && previous.root === result.root
            ? { ...result, sessions: [...previous.sessions, ...result.sessions] }
            : result,
        );
      } catch (cause) {
        if (mounted.current && request === generation.current)
          setError(cause instanceof Error ? cause.message : "import_failed");
      } finally {
        if (mounted.current && request === generation.current) setLoading(false);
      }
    },
    [service, isDesktop],
  );
  const cancelScan = useCallback(() => {
    generation.current++;
    setLoading(false);
    if (service && scanRequest.current)
      void service.cancelDetection(scanRequest.current).catch(() => {});
    scanRequest.current = undefined;
  }, [service]);
  const execute = useCallback(
    async (selection: ExternalImportSelection) => {
      if (!service) return;
      setError(null);
      const operationId = crypto.randomUUID();
      setOperation({
        id: operationId,
        source: selection.source,
        startedAt: Date.now(),
        state: "running",
        total:
          selection.sessionKeys.length +
          selection.resourceKeys.length +
          (selection.projectPaths?.length ?? 0),
        completed: 0,
        results: [],
        selection,
      });
      try {
        const result = await service.execute({ operationId, selection });
        if (mounted.current) {
          setOperation(result);
          setView(await service.getView());
        }
        const scopes = result.results
          .filter((item) => item.workspacePath)
          .map((item) => ({ workspacePath: item.workspacePath! }));
        for (const scope of scopes) tabs.getState().ensureWorkspaceTab(scope.workspacePath);
        invalidateTaskQueryCacheByScopes(scopes);
      } catch (cause) {
        if (mounted.current) {
          setError(cause instanceof Error ? cause.message : "import_failed");
          setOperation(null);
        }
      }
    },
    [service, tabs],
  );
  const configure = useCallback(
    async (request: { enabled?: boolean; selections?: ExternalImportSelection[] }) => {
      try {
        if (service) setView(await service.configure(request));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "sync_failed");
      }
    },
    [service],
  );
  const chooseDirectory = useCallback(() => platform.selectDirectory(), [platform]);
  const openResult = useCallback(
    (result: { taskId?: string; workspacePath?: string }) => {
      if (!result.workspacePath) return;
      const id = tabs.getState().ensureWorkspaceTab(result.workspacePath);
      tabs.getState().activateTab(id);
      if (result.taskId)
        useZCodeSessionStore.getState().setActiveTaskId(result.workspacePath, result.taskId);
    },
    [tabs],
  );
  const revealResult = useCallback(
    async (targetPath: string) => {
      try {
        await platform.openInFileManager(targetPath);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "import_failed");
      }
    },
    [platform],
  );
  const cancel = useCallback(async () => {
    try {
      if (service && operation) await service.cancel(operation.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "import_failed");
    }
  }, [operation, service]);
  const retry = useCallback(
    async (id: string) => {
      try {
        if (service) {
          const previous = view.operations.find((item) => item.id === id);
          const retryId = crypto.randomUUID();
          if (previous)
            setOperation({
              ...previous,
              id: retryId,
              state: "running",
              completed: 0,
              results: [],
              startedAt: Date.now(),
              finishedAt: undefined,
            });
          const next = await service.retry(id, retryId);
          setOperation(next);
          setView(await service.getView());
          for (const result of next.results)
            if (result.workspacePath) tabs.getState().ensureWorkspaceTab(result.workspacePath);
          invalidateTaskQueryCacheByScopes(
            next.results
              .filter((item) => item.workspacePath)
              .map((item) => ({ workspacePath: item.workspacePath! })),
          );
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "import_failed");
      }
    },
    [service, tabs, view.operations],
  );
  return {
    view,
    error,
    loading,
    discovery,
    operation,
    scan,
    cancelScan,
    execute,
    configure,
    chooseDirectory,
    openResult,
    revealResult,
    cancel,
    retry,
    resetOperation: () => setOperation(null),
  };
}
