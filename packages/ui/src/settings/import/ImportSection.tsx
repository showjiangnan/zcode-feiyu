// Modified by ZCode Feiyu.
import { useState } from "react";
import { Download, Terminal, FolderOpen } from "lucide-react";
import type { ExternalImportSelection, ExternalImportSource } from "@zcode/shared";
import { useExternalImport } from "@/hooks/useExternalImport.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog.js";
import { ImportDialog } from "./ImportDialog.js";

export function ImportSection({ isDesktop = false }: { isDesktop?: boolean }) {
  const controller = useExternalImport(isDesktop);
  const { intl, locale } = useZCodeIntl();
  const t = (name: string) => intl.formatMessage({ id: `import.${name}` });
  const [source, setSource] = useState<ExternalImportSource | null>(null);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [customizing, setCustomizing] = useState(false);
  const [editing, setEditing] = useState<ExternalImportSelection | undefined>();
  const open = (
    next: ExternalImportSource,
    selection?: ExternalImportSelection,
    customize = false,
  ) => {
    setCustomizing(customize);
    setEditing(selection);
    setSource(next);
    setScopeOpen(false);
  };
  const supported = isDesktop && controller.view.supported;
  return (
    <div className="space-y-6" data-testid="external-import-page">
      <p className="text-ui-base text-foreground-subtle">{t("description")}</p>
      {!supported && (
        <p className="rounded-xl border border-border bg-card p-4 text-ui-sm text-foreground-subtle">
          {t("desktop")}
        </p>
      )}
      {controller.error && (
        <p role="alert" className="break-words text-ui-sm text-destructive">
          {controller.error}
        </p>
      )}
      <section className="space-y-3">
        <h2 className="text-ui-base font-medium">{t("auto")}</h2>
        <div className="divide-y divide-border rounded-xl border border-border bg-card">
          <div className="flex items-center gap-4 p-4">
            <div className="min-w-0 flex-1">
              <p className="text-ui-base">{t("keepSync")}</p>
              <p className="mt-1 text-ui-sm text-foreground-subtle">
                {t(controller.view.syncEnabled ? "syncOn" : "syncOff")}
              </p>
              {controller.view.syncError && (
                <p className="break-words text-ui-xs text-destructive">
                  {controller.view.syncError}
                </p>
              )}
            </div>
            <Switch
              aria-label={t("keepSync")}
              checked={controller.view.syncEnabled}
              disabled={!supported || !controller.view.selections.length}
              onCheckedChange={(enabled) => void controller.configure({ enabled })}
            />
          </div>
          <div className="flex items-center gap-4 p-4">
            <div className="min-w-0 flex-1">
              <p className="text-ui-base">{t("scope")}</p>
              <p className="mt-1 text-ui-sm text-foreground-subtle">
                {controller.view.selections.length
                  ? controller.view.selections
                      .map((item) => (item.source === "codex" ? "Codex" : "Claude Code"))
                      .join(" · ")
                  : t("firstRequired")}
              </p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              disabled={!supported || !controller.view.selections.length}
              onClick={() => setScopeOpen(true)}
            >
              {t("customize")}
            </Button>
          </div>
        </div>
      </section>
      <section className="space-y-3">
        <h2 className="text-ui-base font-medium">{t("sources")}</h2>
        <div className="divide-y divide-border rounded-xl border border-border bg-card">
          {(["claudeCode", "codex"] as const).map((item) => (
            <div key={item} className="flex items-center gap-3 p-4">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-surface">
                <Terminal className="size-5" />
              </span>
              <span className="min-w-0 flex-1 text-ui-base font-medium">
                {item === "codex" ? "Codex" : "Claude Code"}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`${item}: ${t("directory")}`}
                disabled={!supported}
                onClick={async () => {
                  const root = await controller.chooseDirectory();
                  if (root)
                    open(item, {
                      source: item,
                      root,
                      sessionKeys: [],
                      resourceKeys: [],
                      includeArchived: false,
                    });
                }}
              >
                <FolderOpen className="size-4" />
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={!supported}
                onClick={() => open(item)}
              >
                <Download className="size-3.5" />
                {t("button")}
              </Button>
            </div>
          ))}
        </div>
      </section>
      <section className="space-y-3">
        <h2 className="text-ui-base font-medium">{t("history")}</h2>
        {!controller.view.operations.length && (
          <p className="text-ui-sm text-foreground-subtle">{t("noHistory")}</p>
        )}
        {controller.view.operations.map((operation) => (
          <div key={operation.id} className="rounded-xl border border-border bg-card p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 text-ui-sm">
              <span>
                {operation.source === "codex" ? "Codex" : "Claude Code"} ·{" "}
                {new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(
                  operation.startedAt,
                )}
              </span>
              <span className="text-foreground-subtle">
                {operation.completed}/{operation.total}
              </span>
            </div>
            <div className="mt-2 space-y-2">
              {operation.results.map((result) => (
                <div key={result.key} className="flex items-start gap-2 text-ui-sm">
                  <div className="min-w-0 flex-1">
                    <span className="break-words">{result.label}</span>
                    <span className="ml-2 text-foreground-subtle">{t(result.status)}</span>
                    {result.reason && (
                      <p className="break-words text-ui-xs text-foreground-subtle">
                        {t(`reason.${result.reason}`) === `import.reason.${result.reason}`
                          ? result.reason
                          : t(`reason.${result.reason}`)}
                      </p>
                    )}
                  </div>
                  {result.targetPath && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void controller.revealResult(result.targetPath!)}
                    >
                      {t("open")}
                    </Button>
                  )}
                  {result.workspacePath && (
                    <Button variant="ghost" size="sm" onClick={() => controller.openResult(result)}>
                      {t("open")}
                    </Button>
                  )}
                </div>
              ))}
            </div>
            {operation.state === "cancelled" ||
            operation.results.some(
              (item) => item.status === "failed" || item.status === "cancelled",
            ) ? (
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => void controller.retry(operation.id)}
              >
                {t("retry")}
              </Button>
            ) : null}
          </div>
        ))}
      </section>
      <Dialog open={scopeOpen} onOpenChange={setScopeOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("scope")}</DialogTitle>
            <DialogDescription>{t("selectionDescription")}</DialogDescription>
          </DialogHeader>
          <div className="max-h-[60dvh] space-y-3 overflow-y-auto">
            {controller.view.selections.map((selection, index) => (
              <div key={index} className="rounded-lg border border-border p-3">
                <p className="break-all text-ui-sm">
                  {selection.source === "codex" ? "Codex" : "Claude Code"} · {selection.root}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() => open(selection.source, selection, true)}
                >
                  {t("customize")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    void controller.configure({
                      selections: controller.view.selections.filter((item) => item !== selection),
                    })
                  }
                >
                  {t("removeScope")}
                </Button>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
      <ImportDialog
        source={source}
        controller={controller}
        initial={editing}
        customize={customizing}
        onClose={() => {
          controller.cancelScan();
          setSource(null);
          setEditing(undefined);
        }}
      />
    </div>
  );
}
