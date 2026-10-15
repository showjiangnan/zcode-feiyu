// Modified by ZCode Feiyu.
import { subscriptionErrorMessageKey } from "./errors.js";
import { SubscriptionModelCapabilities } from "./SubscriptionModelCapabilities.js";
import { Loader2Icon, RefreshCwIcon, ExternalLinkIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Alert, AlertDescription } from "@/components/ui/alert.js";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useChatGPTSubscription } from "@/hooks/useChatGPTSubscription.js";
import { ProviderLogo } from "@/settings/model-provider-section/ProviderLogo.js";

export function ChatGPTIcon({ className = "size-4" }: { className?: string }) {
  return <ProviderLogo logo={{ type: "builtin", key: "openai" }} className={className} />;
}

export function ChatGPTSubscriptionPanel({ onReady }: { onReady?: () => void }) {
  const { intl } = useZCodeIntl(),
    subscription = useChatGPTSubscription();
  const { view, busy, execute, desktop, openUsage } = subscription;
  const [removeOpen, setRemoveOpen] = useState(false);
  const m = (key: string) => intl.formatMessage({ id: `chatgptSubscription.${key}` });
  const connection = view.connection,
    pending = view.pending;
  const enabled = connection?.status === "connected";
  return (
    <section className="space-y-5" data-testid="chatgpt-subscription-panel">
      <header className="flex items-center gap-3">
        <ChatGPTIcon className="size-6" />
        <h2 className="text-ui-xl font-semibold">{m("title")}</h2>
      </header>
      <p className="text-ui-base text-foreground-subtle">{m("description")}</p>
      {!desktop ? (
        <p className="text-ui-sm text-foreground-subtle">{m("desktopManagement")}</p>
      ) : null}
      {!view.available ? (
        <Alert variant="warning">
          <AlertDescription>
            {m(
              view.unavailableReason === "credential_store_unavailable"
                ? "credentialStoreUnavailable"
                : view.unavailableReason === "secure_storage_unavailable"
                  ? "secureStorageUnavailable"
                  : "desktopRequired",
            )}
          </AlertDescription>
        </Alert>
      ) : null}
      {view.error ? (
        <Alert variant="warning">
          <AlertDescription>
            {m(subscriptionErrorMessageKey(view.error.code) ?? "error")}{" "}
            <span className="break-all font-mono">{view.error.code}</span>
            {view.error.requestId ? <span className="ml-2">{view.error.requestId}</span> : null}
          </AlertDescription>
        </Alert>
      ) : null}
      {connection ? (
        <div className="rounded-xl border border-border bg-surface p-4 space-y-2">
          <div className="font-medium break-all">{connection.email ?? connection.label}</div>
          <div className="text-ui-sm text-foreground-subtle">
            {connection.label} · {m(`status.${connection.status}`)}
          </div>
          <div className="flex flex-wrap gap-2">
            {desktop ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || !!pending}
                  onClick={() => void execute({ type: "sign-in", mode: "switch" })}
                >
                  {m("switch")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || !!pending}
                  onClick={() =>
                    void execute({
                      type: "sign-in",
                      mode: "reauthorize",
                      enableUsage: connection.status === "identity-only",
                    })
                  }
                >
                  {m(connection.status === "identity-only" ? "authorizeUsage" : "reconnect")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || !!pending}
                  onClick={() => void execute({ type: "sign-out" })}
                >
                  {m("signOut")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || !!pending}
                  onClick={() => setRemoveOpen(true)}
                >
                  {m("remove")}
                </Button>
              </>
            ) : null}
            <Button size="sm" variant="outline" onClick={openUsage}>
              <ExternalLinkIcon className="size-4" />
              {m("usage")}
            </Button>
          </div>
          {connection.remoteRevocation === "unconfirmed" ? (
            <p className="text-ui-sm text-warning">{m("revocationUnconfirmed")}</p>
          ) : null}
        </div>
      ) : null}
      {desktop && (!connection || connection.status === "signed-out") ? (
        <Button
          size="lg"
          className="h-10 w-full text-ui-base"
          disabled={busy || !!pending || !view.available}
          onClick={() => void execute({ type: "sign-in", mode: "sign-in" })}
          aria-label="Continue with ChatGPT"
          data-testid="chatgpt-continue"
        >
          <ChatGPTIcon />
          {m("continue")}
        </Button>
      ) : null}
      {pending ? (
        <div className="flex items-center gap-2 text-ui-base">
          <Loader2Icon className="size-4 animate-spin" />
          {m("waiting")}
          {desktop ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void execute({ type: "cancel", attemptId: pending.attemptId })}
            >
              {m("cancel")}
            </Button>
          ) : null}
        </div>
      ) : null}
      {connection ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-ui-base font-medium">{m("models")}</h3>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !enabled || !!pending}
              onClick={() => void execute({ type: "refresh-models" })}
            >
              <RefreshCwIcon className={`size-4 ${busy ? "animate-spin" : ""}`} />
              {m("refresh")}
            </Button>
          </div>
          <p className="text-ui-sm text-foreground-subtle">
            {m(`catalog.${connection.catalogState}`)}
            {connection.catalogError ? ` · ${connection.catalogError}` : ""}
          </p>
          <div className="divide-y divide-border rounded-xl border border-border overflow-hidden">
            {connection.models.map((model) => (
              <div
                key={model.slug}
                className="p-3 text-ui-base flex flex-wrap items-center justify-between gap-2"
              >
                <div className="min-w-0">
                  <span>{model.displayName}</span>
                  {model.contextWindow && (
                    <p className="text-ui-sm text-foreground-subtle">
                      {m(
                        model.contextWindowSource === "subscription-catalog"
                          ? "contextCatalogLabel"
                          : "contextPlanning",
                      )}{" "}
                      {model.contextWindow.toLocaleString()} ·{" "}
                      {m(
                        model.contextWindowSource === "subscription-catalog"
                          ? "contextCatalog"
                          : model.contextWindowSource === "official-model-reference"
                            ? "contextReference"
                            : "contextFallback",
                      )}
                    </p>
                  )}
                </div>
                <span className="text-ui-sm text-foreground-subtle break-all">{model.slug}</span>
                <SubscriptionModelCapabilities model={model} />
              </div>
            ))}
          </div>
          <p className="text-ui-sm text-foreground-subtle">{m("capabilities")}</p>
          {enabled && onReady ? (
            <Button
              disabled={!connection.models.length || !connection.usageAcknowledged}
              onClick={onReady}
            >
              {m("ready")}
            </Button>
          ) : null}
        </div>
      ) : null}
      <p className="text-ui-sm text-foreground-subtle">{m("privacy")}</p>
      <AlertDialog open={!!enabled && !connection?.usageAcknowledged && desktop}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{m("welcomeTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{m("welcome")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => void execute({ type: "sign-out" })}>
              {m("cancel")}
            </AlertDialogCancel>
            <AlertDialogAction onClick={() => void execute({ type: "acknowledge-usage" })}>
              {m("acknowledge")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{m("remove")}</AlertDialogTitle>
            <AlertDialogDescription>{m("removeDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{m("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void execute({ type: "remove" })}>
              {m("remove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
