import { pathFields, safeSettings, safeBroadcasts } from "./rcsPolicy.js";
import { redactConfiguration, preserveSecrets, filterRcsControllerFrame } from "./rcsProjection.js";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep, posix, win32 } from "node:path";
import { type Event, type IServerChannel } from "@zcode/rpc";
import { RCS_SERVICE_MANIFEST, type AppSettings, type RcsGrant } from "@zcode/shared";
import {
  type IFileService,
  type IZCodeTaskService,
  type ITerminalService,
  type IFileWatcherService,
} from "@zcode/services";

type Json = Record<string, unknown>;
function object(value: unknown): Json | undefined {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array)
    ? (value as Json)
    : undefined;
}
function scopeKey(value: { workspacePath: string; workspaceIdentity?: string }): string {
  return value.workspaceIdentity?.trim() || value.workspacePath;
}
function denied(): never {
  throw new Error("CAPABILITY_DENIED");
}

async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return resolve(await canonical(parent), relative(parent, path));
  }
}
function contained(root: string, path: string, remote: boolean): boolean {
  const paths = remote
    ? /^[a-z]:[\\/]/i.test(root)
      ? win32
      : posix
    : { relative, isAbsolute, sep };
  const part = paths.relative(root, path);
  return (
    part === "" || (part !== ".." && !part.startsWith(`..${paths.sep}`) && !paths.isAbsolute(part))
  );
}

/** 公网 attachment 的最后授权边界。内部新增方法不会通过反射自动公开。 */
export function createRcsAuthorization(options: {
  grant: RcsGrant;
  file: IFileService;
  task: IZCodeTaskService;
  terminal: ITerminalService;
  watcher?: IFileWatcherService;
}) {
  const { grant } = options;
  const watchers = new Set<string>();
  const terminals = new Set<string>();
  const controllers = new Map<string, () => Promise<unknown>>();
  const remote = Boolean(grant.remoteSessionId);
  const memoryKey = createHash("sha256")
    .update(
      grant.workspaceIdentity?.trim() ||
        (process.platform === "win32"
          ? resolve(grant.workspacePath).toLowerCase()
          : resolve(grant.workspacePath)),
    )
    .digest("hex")
    .slice(0, 16);

  function bind(value: unknown, depth = 0): unknown {
    if (depth > 32) denied();
    if (Array.isArray(value)) return value.map((item) => bind(item, depth + 1));
    const input = object(value);
    if (!input) return value;
    if (typeof input.workspacePath === "string" && input.workspacePath !== grant.workspacePath)
      denied();
    if (typeof input.workspaceIdentity === "string" && input.workspaceIdentity !== scopeKey(grant))
      denied();
    if (input.remoteSessionId !== undefined && input.remoteSessionId !== grant.remoteSessionId)
      denied();
    if (input.includeAllWorkspaces === true) denied();
    const result = Object.fromEntries(
      Object.entries(input).map(([key, entry]) => [key, bind(entry, depth + 1)]),
    );
    if (typeof input.workspacePath === "string") {
      if (grant.workspaceIdentity) result.workspaceIdentity = grant.workspaceIdentity;
      if (grant.remoteSessionId) result.remoteSessionId = grant.remoteSessionId;
    }
    return result;
  }
  async function assertPath(path: string): Promise<void> {
    const remotePaths = /^[a-z]:[\\/]/i.test(grant.workspacePath) ? win32 : posix;
    const absolute = remote
      ? remotePaths.resolve(grant.workspacePath, path)
      : resolve(grant.workspacePath, path);
    if (!contained(grant.workspacePath, absolute, remote)) denied();
    const [root, target] = remote
      ? await Promise.all([
          options.file.resolvePath({ path: grant.workspacePath }),
          options.file.resolvePath({ path: absolute }),
        ])
      : await Promise.all([canonical(grant.workspacePath), canonical(absolute)]);
    if (!contained(root, target, remote)) denied();
  }
  async function assertPaths(value: unknown, depth = 0): Promise<void> {
    if (depth > 32) denied();
    if (Array.isArray(value)) {
      await Promise.all(value.map((item) => assertPaths(item, depth + 1)));
      return;
    }
    const input = object(value);
    if (!input) return;
    for (const [key, entry] of Object.entries(input)) {
      if (pathFields.has(key) && typeof entry === "string") await assertPath(entry);
      else if (key === "paths" && Array.isArray(entry))
        await Promise.all(
          entry.map((path) =>
            typeof path === "string"
              ? assertPath(path)
              : Promise.reject(new Error("CAPABILITY_DENIED")),
          ),
        );
      else await assertPaths(entry, depth + 1);
    }
  }
  function sanitizeSettings(settings: AppSettings): AppSettings {
    const lastTask = settings.lastActiveTaskByWorkspace?.[scopeKey(grant)];
    const value: AppSettings = {
      ...Object.fromEntries(Object.entries(settings).filter(([key]) => safeSettings.has(key))),
      locale: settings.locale,
      policyRevision: settings.policyRevision,
      recentProjects: [grant.workspacePath],
      lastWorkspaceSession: (settings.lastWorkspaceSession ?? []).filter(
        (item) => scopeKey(item) === scopeKey(grant),
      ),
      lastActiveTaskByWorkspace: lastTask ? { [scopeKey(grant)]: lastTask } : {},
    };
    return value;
  }
  function filterCatalog(result: unknown): unknown {
    const value = object(result);
    if (value?.type === "catalog" && Array.isArray(value.workspaces))
      return {
        ...value,
        workspaces: value.workspaces.filter(
          (item) =>
            typeof object(item)?.id === "string" &&
            (object(item)!.id as string).endsWith(`-${memoryKey}`),
        ),
      };
    return result;
  }
  function mapEvent<T>(source: Event<T>, allowed: (value: T) => boolean): Event<T> {
    return (listener) =>
      source((value) => {
        if (allowed(value)) listener(value);
      });
  }
  function authorize(name: string, channel: IServerChannel): IServerChannel | undefined {
    const entry = RCS_SERVICE_MANIFEST[name];
    if (!entry || (!entry.methods.length && !entry.events.length)) return undefined;
    return {
      async call<T>(ctx: string, method: string, rawArgs?: unknown[]): Promise<T> {
        if (!entry.methods.includes(method)) denied();
        let args = bind(rawArgs ?? []) as unknown[];
        const first = object(args[0]);
        if (
          ["zcode-task", "zcode-agent", "zcode-session"].includes(name) &&
          first &&
          !method.startsWith("initializeConversation")
        ) {
          args[0] = { ...first, ...grant };
          if (typeof first.taskId === "string" && !["createTask", "getTaskMeta"].includes(method)) {
            const meta = await options.task.getTaskMeta({ taskId: first.taskId, ...grant });
            if (!meta || scopeKey(meta) !== scopeKey(grant)) denied();
          }
        }
        if (name === "window-controller") {
          if (method === "listTaskList") args[0] = { ...first, workspaceScopes: [grant] };
          if (
            ["resyncControllerV4", "unsubscribeControllerV4"].includes(method) &&
            !controllers.has(String(first?.subscriptionId))
          )
            denied();
        }
        if (name === "setting" && method === "update") {
          if (!first || Object.keys(first).some((key) => !safeSettings.has(key))) denied();
        }
        if (
          name === "broadcast" &&
          (!first ||
            !safeBroadcasts.has(String(first.channel)) ||
            first.channel === "settings:app-runtime-preferences")
        )
          denied();
        if (name === "zcode-agent" && method === "workspaceMemory") {
          const operation = object(first?.operation);
          if (
            operation?.type === "readCatalogFile" &&
            (typeof operation.workspaceId !== "string" ||
              !operation.workspaceId.endsWith(`-${memoryKey}`))
          )
            denied();
        }
        if (
          name === "memory" &&
          method === "readProjectMemoryFile" &&
          (typeof first?.workspaceId !== "string" || !first.workspaceId.endsWith(`-${memoryKey}`))
        )
          denied();
        if (name === "file-watcher" && method === "unwatch" && !watchers.has(String(first?.id)))
          denied();
        if (name === "terminal") {
          if (method === "create") args[0] = { ...first, cwd: grant.workspacePath };
          else if (method !== "list" && !terminals.has(String(first?.id))) denied();
        }
        if (name === "provider-settings" && method === "savePersonalProviderOverlay") {
          const view = await channel.call<Json>(ctx, "getView", []);
          const provider = Array.isArray(view.providers)
            ? view.providers.find((item) => object(item)?.providerId === args[0])
            : undefined;
          args[1] = preserveSecrets(
            args[1],
            object(provider)?.personalConfig ?? object(provider)?.effectiveConfig,
          );
        }
        await assertPaths(args);
        let result = await channel.call<unknown>(ctx, method, args);
        if (name === "window-controller" && method === "subscribeControllerV4") {
          const id = String(object(object(result)?.ack)?.subscriptionId);
          controllers.set(id, () =>
            channel.call(ctx, "unsubscribeControllerV4", [{ subscriptionId: id }]),
          );
        }
        if (name === "window-controller" && method === "unsubscribeControllerV4")
          controllers.delete(String(first?.subscriptionId));
        if (name === "setting" && ["get", "update"].includes(method))
          result = sanitizeSettings(result as AppSettings);
        if (name === "memory" && method === "listProjectMemories" && Array.isArray(result))
          result = result.filter(
            (item) =>
              typeof object(item)?.id === "string" &&
              (object(item)!.id as string).endsWith(`-${memoryKey}`),
          );
        if (name === "zcode-agent" && method === "workspaceMemory") result = filterCatalog(result);
        if (name === "file-watcher" && method === "watch") watchers.add(String(object(result)?.id));
        if (name === "terminal" && method === "create") terminals.add(String(object(result)?.id));
        if (name === "terminal" && method === "list" && Array.isArray(result)) {
          const visible = [];
          for (const item of result) {
            const cwd = object(item)?.cwd;
            if (typeof cwd !== "string" || !contained(grant.workspacePath, cwd, remote)) continue;
            await assertPath(cwd);
            terminals.add(String(object(item)?.id));
            visible.push(item);
          }
          result = visible;
        }
        if (name === "zcode-task" && method === "listGroupedTaskViewStructure") {
          const value = object(result);
          if (value)
            result = {
              ...value,
              members: Array.isArray(value.members)
                ? value.members.filter((item) => object(item)?.workspaceKey === scopeKey(grant))
                : [],
              topLevelOrders: Array.isArray(value.topLevelOrders)
                ? value.topLevelOrders.filter(
                    (item) =>
                      object(item)?.type === "group" ||
                      object(item)?.workspaceKey === scopeKey(grant),
                  )
                : [],
            };
        }
        if (["provider-settings", "model-selection", "setting"].includes(name))
          result = redactConfiguration(result);
        return result as T;
      },
      listen<T>(ctx: string, event: string, rawArg?: unknown): Event<T> {
        if (!entry.events.includes(event)) denied();
        let arg = bind(rawArg);
        if (["zcode-task", "zcode-agent", "zcode-session"].includes(name) && object(arg))
          arg = { ...object(arg), ...grant };
        if (
          name === "zcode-task" &&
          typeof arg === "string" &&
          ["onDynamicStreamEvent", "onDynamicTaskTerminalOutcome", "onDynamicTaskReady"].includes(
            event,
          )
        ) {
          const taskId = arg;
          return (listener) => {
            let disposed = false;
            let subscription: { dispose(): void } | undefined;
            void options.task
              .getTaskMeta({ taskId, ...grant })
              .then((meta) => {
                if (!disposed && meta && scopeKey(meta) === scopeKey(grant))
                  subscription = channel.listen<T>(ctx, event, taskId)(listener);
              })
              .catch(() => {});
            return {
              dispose() {
                disposed = true;
                subscription?.dispose();
              },
            };
          };
        }
        if (name === "file-watcher" && !watchers.has(String(arg))) denied();
        if (
          name === "terminal" &&
          !terminals.has(typeof arg === "string" ? arg : String(object(arg)?.id))
        )
          denied();
        if (
          name === "zcode-task" &&
          typeof arg === "string" &&
          event === "onDynamicWorkspaceEvent" &&
          arg !== scopeKey(grant) &&
          arg !== grant.workspacePath
        )
          denied();
        const source = channel.listen<T>(ctx, event, arg);
        if (name === "window-controller")
          return (listener) =>
            source((value) => listener(filterRcsControllerFrame(value, grant) as T));
        if (["provider-settings", "model-selection"].includes(name))
          return (listener) => source((value) => listener(redactConfiguration(value) as T));
        if (name === "zcode-task" && event === "onError")
          return mapEvent(source, (value) => {
            const error = object(value);
            return (
              error?.workspacePath === grant.workspacePath &&
              (typeof error.workspaceIdentity !== "string" ||
                error.workspaceIdentity === scopeKey(grant))
            );
          });
        if (
          name === "zcode-agent" &&
          ["onAgentRuntimeRestarted", "onAgentRuntimeLifecycle"].includes(event)
        )
          return mapEvent(source, (value) => object(value)?.workspaceKey === scopeKey(grant));
        if (name === "broadcast")
          return mapEvent(source, (value) => safeBroadcasts.has(String(object(value)?.channel)));
        return source;
      },
    };
  }
  return {
    authorize,
    async dispose() {
      await Promise.allSettled([...watchers].map((id) => options.watcher?.unwatch({ id })));
      await Promise.allSettled([...controllers.values()].map((dispose) => dispose()));
      controllers.clear();
      watchers.clear();
      terminals.clear();
    },
  };
}
