import { RcsLoginPage, RcsDirectoryPage, type RcsSelection } from "./RcsPages.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { RcsHttpClient, RcsRpcConnection } from "@zcode/client";
import {
  rcsWorkspaceSchema,
  type IPlatformService,
  type RcsDevice,
  type RcsHost,
} from "@zcode/shared";

const selectionKey = "zcode:rcs:selected-workspace:v1";
function restoredSelection(): RcsSelection | undefined {
  try {
    const value = JSON.parse(sessionStorage.getItem(selectionKey) ?? "null");
    if (!value || typeof value.deviceId !== "string" || typeof value.hostId !== "string") return;
    return {
      deviceId: value.deviceId,
      hostId: value.hostId,
      workspace: rcsWorkspaceSchema.parse(value.workspace),
    };
  } catch {
    return;
  }
}
import { Root, ZCodeIntlProvider, Button, Alert, AlertDescription, useZCodeIntl } from "@zcode/ui";

export function RcsApp({ platform }: { platform: IPlatformService }) {
  return (
    <ZCodeIntlProvider>
      <RcsSession platform={platform} />
    </ZCodeIntlProvider>
  );
}

function RcsSession({ platform }: { platform: IPlatformService }) {
  const { intl } = useZCodeIntl();
  const text = (id: string) => intl.formatMessage({ id: `remoteServices.web.${id}` });
  const http = useMemo(
    () => new RcsHttpClient({ endpoint: location.origin, cookieAuthentication: true }),
    [],
  );
  const [endpoint, setEndpoint] = useState(location.origin);
  const [key, setKey] = useState("");
  const [authenticated, setAuthenticated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [devices, setDevices] = useState<RcsDevice[]>([]);
  const [hosts, setHosts] = useState<RcsHost[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [selection, setSelection] = useState<RcsSelection>();
  useEffect(() => {
    try {
      if (selection) sessionStorage.setItem(selectionKey, JSON.stringify(selection));
    } catch {
      /* 隐私模式存储不可用时仍可手动选择工作区。 */
    }
  }, [selection]);
  const [connection, setConnection] = useState<RcsRpcConnection>();
  const [online, setOnline] = useState(false);
  const hostPlatform = useMemo(
    () => ({ ...platform, remoteCapabilities: connection?.attachment.capabilities }),
    [platform, connection],
  );
  const generation = useRef(0);
  const action = useRef(false);

  useEffect(() => {
    let active = true;
    void http
      .restore()
      .then(() => {
        if (active) {
          setAuthenticated(true);
          setSelection(restoredSelection());
        }
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [http]);
  useEffect(() => {
    if (!authenticated || selection) return;
    let active = true;
    const refresh = async () => {
      try {
        const items = await http.listDevices();
        if (active) {
          setDevices(items);
          setError(undefined);
        }
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      }
    };
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [authenticated, selection, http]);
  useEffect(() => {
    if (!deviceId || !authenticated || selection) return;
    let active = true;
    const refresh = async () => {
      try {
        const items = await http.listHosts(deviceId);
        if (active) {
          setHosts(items);
          setError(undefined);
        }
      } catch (reason) {
        if (active) {
          setHosts([]);
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      }
    };
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [deviceId, authenticated, selection, http]);
  useEffect(() => {
    if (!selection || !authenticated) return;
    const owner = ++generation.current;
    let current: RcsRpcConnection | undefined;
    let closeSubscription: { dispose(): void } | undefined;
    let attachmentId: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const live = () => generation.current === owner;
    const detach = () => {
      closeSubscription?.dispose();
      closeSubscription = undefined;
      current?.dispose();
      current = undefined;
      if (attachmentId) {
        void http.detach(attachmentId).catch(() => {});
        attachmentId = undefined;
      }
    };
    const connect = async () => {
      detach();
      if (!live()) return;
      setOnline(false);
      try {
        await http.refreshIfNeeded();
        const directory = await http.listHosts(selection.deviceId);
        const host = directory.find((item) => item.id === selection.hostId);
        const workspace = host?.workspaces.find(
          (item) =>
            (item.workspaceIdentity?.trim() || item.workspacePath) ===
            (selection.workspace.workspaceIdentity?.trim() || selection.workspace.workspacePath),
        );
        if (!host || !workspace) throw new Error("WORKSPACE_OFFLINE");
        const attachment = await http.attach({
          deviceId: selection.deviceId,
          hostId: host.id,
          hostGeneration: host.generation,
          workspaceHandle: workspace.handle,
        });
        if (!live()) {
          void http.detach(attachment.id).catch(() => {});
          return;
        }
        attachmentId = attachment.id;
        const next = await RcsRpcConnection.connect(http, attachment);
        if (!live()) {
          next.dispose();
          return;
        }
        current = next;
        failures = 0;
        setConnection(next);
        setOnline(true);
        setError(undefined);
        closeSubscription = next.closed(() => {
          if (!live()) return;
          setOnline(false);
          timer = setTimeout(() => {
            void connect();
          }, 1000);
        });
      } catch (reason) {
        if (!live()) return;
        const code = reason instanceof Error ? reason.message : String(reason);
        setError(code);
        if (
          [
            "AUTH_REQUIRED",
            "AUTH_FAILED",
            "SESSION_EXPIRED",
            "AUTH_REVOKED",
            "KEY_REVOKED",
            "VERSION_INCOMPATIBLE",
          ].includes(code)
        ) {
          setAuthenticated(false);
          setSelection(undefined);
          setConnection(undefined);
          return;
        }
        timer = setTimeout(
          () => {
            void connect();
          },
          Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5)),
        );
      }
    };
    void connect();
    return () => {
      ++generation.current;
      clearTimeout(timer);
      detach();
    };
  }, [selection, authenticated, http]);

  const run = async (operation: () => Promise<void>) => {
    if (action.current) return;
    action.current = true;
    setLoading(true);
    setError(undefined);
    try {
      await operation();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      action.current = false;
      setLoading(false);
    }
  };
  const logout = () =>
    run(async () => {
      try {
        await http.logout();
      } finally {
        setSelection(undefined);
        setConnection(undefined);
        setAuthenticated(false);
        setKey("");
        sessionStorage.removeItem(selectionKey);
      }
    });
  const feedback = error ? (
    <Alert variant="destructive">
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  ) : null;
  if (!authenticated)
    return (
      <RcsLoginPage
        text={text}
        feedback={feedback}
        endpoint={endpoint}
        setEndpoint={setEndpoint}
        keyValue={key}
        setKey={setKey}
        loading={loading}
        run={run}
        http={http}
        setAuthenticated={setAuthenticated}
      />
    );
  if (!selection)
    return (
      <RcsDirectoryPage
        text={text}
        feedback={feedback}
        logout={logout}
        deviceId={deviceId}
        setDeviceId={setDeviceId}
        devices={devices}
        hosts={hosts}
        setHosts={setHosts}
        setConnection={setConnection}
        setSelection={setSelection}
      />
    );
  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <header className="flex min-h-11 shrink-0 items-center justify-between gap-2 border-b border-border px-3 text-ui-xs">
        <span className="truncate">
          {selection.workspace.name} · {text(online ? "online" : "reconnecting")}
        </span>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              sessionStorage.removeItem(selectionKey);
              setSelection(undefined);
              setConnection(undefined);
              setOnline(false);
            }}
          >
            {text("switchWorkspace")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              void logout();
            }}
          >
            {text("logout")}
          </Button>
        </div>
      </header>
      <div className="relative min-h-0 flex-1">
        {connection ? (
          <div className="h-full" inert={!online}>
            <ZCodeIntlProvider
              settingService={connection.services.settingService}
              broadcastService={connection.services.broadcastService}
            >
              <Root
                key={`${selection.deviceId}:${selection.hostId}:${selection.workspace.handle}`}
                services={connection.services}
                authenticationSource="host-attachment"
                fillContainer
                platform={hostPlatform}
                initialWorkspaceAbsPath={selection.workspace.workspacePath}
                initialWorkspaceIdentity={selection.workspace.workspaceIdentity ?? undefined}
                restoreSession
                allowOpenWorkspace={false}
                allowRemoteWorkspace={false}
                preferDirectoryBrowser
                supportsEmbeddedBrowser={false}
              />
            </ZCodeIntlProvider>
          </div>
        ) : null}
        {!online ? (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 p-4">
            <div className="max-w-lg space-y-3 rounded-xl border border-card-border bg-card p-4">
              <p className="text-ui-base">{text("reconnecting")}</p>
              <p className="text-ui-xs text-foreground-subtle">{text("offlineHint")}</p>
              {feedback}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
