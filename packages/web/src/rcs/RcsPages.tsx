import type { ReactNode, Dispatch, SetStateAction } from "react";
import type { RcsDevice, RcsHost, RcsWorkspace } from "@zcode/shared";
import type { RcsHttpClient, RcsRpcConnection } from "@zcode/client";
import { Button, Input } from "@zcode/ui";
export interface RcsSelection {
  deviceId: string;
  hostId: string;
  workspace: RcsWorkspace;
}
type Text = (id: string) => string;
export function RcsLoginPage({
  text,
  feedback,
  endpoint,
  setEndpoint,
  keyValue: key,
  setKey,
  loading,
  run,
  http,
  setAuthenticated,
}: {
  text: Text;
  feedback: ReactNode;
  endpoint: string;
  setEndpoint: Dispatch<SetStateAction<string>>;
  keyValue: string;
  setKey: Dispatch<SetStateAction<string>>;
  loading: boolean;
  run: (operation: () => Promise<void>) => Promise<void>;
  http: RcsHttpClient;
  setAuthenticated: Dispatch<SetStateAction<boolean>>;
}) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 text-foreground">
      <form
        className="w-full max-w-md space-y-4 rounded-xl border border-card-border bg-card p-6"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            const target = new URL(endpoint.trim());
            if (target.origin !== location.origin) {
              if (target.protocol !== "https:") throw new Error("RCS_ENDPOINT_HTTPS_REQUIRED");
              location.assign(target.origin);
              return;
            }
            await http.login(key, "ZCode Web");
            setKey("");
            setAuthenticated(true);
          });
        }}
      >
        <h1 className="text-ui-lg font-medium">{text("title")}</h1>
        <p className="text-ui-base text-foreground-subtle">{text("description")}</p>
        <label className="block space-y-2 text-ui-base">
          {text("endpoint")}
          <Input
            type="url"
            value={endpoint}
            onChange={(event) => setEndpoint(event.target.value)}
            required
            autoComplete="url"
          />
        </label>
        <label className="block space-y-2 text-ui-base">
          {text("key")}
          <Input
            type="password"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            required
            minLength={32}
            autoComplete="off"
          />
        </label>
        {feedback}
        <Button type="submit" className="w-full" disabled={loading}>
          {text(loading ? "loading" : "login")}
        </Button>
      </form>
    </main>
  );
}
export function RcsDirectoryPage({
  text,
  feedback,
  logout,
  deviceId,
  setDeviceId,
  devices,
  hosts,
  setHosts,
  setConnection,
  setSelection,
}: {
  text: Text;
  feedback: ReactNode;
  logout: () => Promise<void>;
  deviceId: string;
  setDeviceId: Dispatch<SetStateAction<string>>;
  devices: RcsDevice[];
  hosts: RcsHost[];
  setHosts: Dispatch<SetStateAction<RcsHost[]>>;
  setConnection: Dispatch<SetStateAction<RcsRpcConnection | undefined>>;
  setSelection: Dispatch<SetStateAction<RcsSelection | undefined>>;
}) {
  return (
    <main className="min-h-dvh bg-background p-4 text-foreground">
      <section className="mx-auto max-w-3xl space-y-4">
        <header className="flex items-center justify-between gap-4">
          <h1 className="text-ui-lg font-medium">{text("workspaces")}</h1>
          <Button
            variant="outline"
            onClick={() => {
              void logout();
            }}
          >
            {text("logout")}
          </Button>
        </header>
        {feedback}
        <label className="block space-y-2 text-ui-base">
          {text("device")}
          <select
            aria-label={text("device")}
            className="w-full rounded-md border border-input bg-background p-2 text-ui-base"
            value={deviceId}
            onChange={(event) => {
              setDeviceId(event.target.value);
              setHosts([]);
            }}
          >
            <option value="">{text("chooseDevice")}</option>
            {devices.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        {!devices.length ? (
          <p className="text-ui-base text-foreground-subtle">{text("noDevices")}</p>
        ) : null}
        {hosts.map((host) => (
          <section
            key={host.id}
            className="space-y-3 rounded-xl border border-card-border bg-card p-4"
          >
            <h2 className="text-ui-base font-medium">{host.name}</h2>
            <div className="grid gap-2 sm:grid-cols-2">
              {host.workspaces.map((workspace) => (
                <Button
                  key={workspace.handle}
                  variant="outline"
                  className="h-auto min-h-12 justify-start whitespace-normal text-left"
                  onClick={() => {
                    setConnection(undefined);
                    setSelection({ deviceId, hostId: host.id, workspace });
                  }}
                >
                  <span className="min-w-0">
                    <span className="block">{workspace.name}</span>
                    <span className="block break-all text-ui-xs text-foreground-subtle">
                      {workspace.workspacePath}
                    </span>
                  </span>
                </Button>
              ))}
            </div>
          </section>
        ))}
      </section>
    </main>
  );
}
