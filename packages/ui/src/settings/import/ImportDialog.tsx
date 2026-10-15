// Modified by ZCode Feiyu.
import { useEffect, useMemo, useState } from "react";
import { Loader2, FolderOpen } from "lucide-react";
import type { ExternalImportSelection, ExternalImportSource } from "@zcode/shared";
import type { useExternalImport } from "@/hooks/useExternalImport.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Progress } from "@/components/ui/progress.js";
import { ImportResults } from "./ImportResults.js";
import { ImportSelectionGroup } from "./ImportSelectionGroup.js";

export function ImportDialog({
  source,
  controller,
  onClose,
  initial,
  customize = false,
}: {
  source: ExternalImportSource | null;
  controller: ReturnType<typeof useExternalImport>;
  onClose: () => void;
  initial?: ExternalImportSelection;
  customize?: boolean;
}) {
  const { intl, locale } = useZCodeIntl();
  const t = (name: string) => intl.formatMessage({ id: `import.${name}` });
  const reason = (value?: string) => {
    if (!value) return undefined;
    const translated = t(`reason.${value}`);
    return translated === `import.reason.${value}` ? value : translated;
  };
  const [selected, setSelected] = useState(new Set<string>());
  const [query, setQuery] = useState("");
  const [archived, setArchived] = useState(false);
  const [root, setRoot] = useState<string | undefined>();
  const [days, setDays] = useState("all");
  const [defaultTarget, setDefaultTarget] = useState<string | undefined>();
  const [mappings, setMappings] = useState<Record<string, string>>({});
  const { discovery, operation, loading } = controller;
  const current = discovery?.source === source ? discovery : null;
  useEffect(() => {
    if (!source) return;
    setSelected(
      new Set([
        ...(initial?.sessionKeys ?? []),
        ...(initial?.resourceKeys ?? []),
        ...(initial?.projectPaths ?? []).map((path) => `project:${path}`),
      ]),
    );
    setQuery("");
    setDays("all");
    setDefaultTarget(initial?.targetWorkspacePath);
    setArchived(initial?.includeArchived ?? false);
    setRoot(initial?.root);
    setMappings(initial?.workspaceMappings ?? {});
    controller.resetOperation();
    void controller.scan(source, {
      root: initial?.root,
      includeArchived: initial?.includeArchived,
    });
  }, [source, initial]); // eslint-disable-line react-hooks/exhaustive-deps
  const items = useMemo(() => current?.sessions ?? [], [current]);
  const projects = [...new Set(items.map((item) => item.workspacePath).filter(Boolean))];
  const change = (keys: string[], checked: boolean) =>
    setSelected((previous) => {
      const next = new Set(previous);
      for (const key of keys) {
        if (checked) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  const rescan = (
    next: {
      root?: string;
      query?: string;
      includeArchived?: boolean;
      cursor?: number;
      days?: string;
    } = {},
  ) => {
    if (!source) return;
    if (!next.cursor) setSelected(new Set());
    void controller.scan(source, {
      root: next.root ?? root ?? current?.root,
      query: next.query ?? query,
      includeArchived: next.includeArchived ?? archived,
      cursor: next.cursor,
      modifiedSince:
        (next.days ?? days) === "all"
          ? undefined
          : Date.now() - Number(next.days ?? days) * 86400000,
    });
  };
  const confirm = async () => {
    if (!source || !current) return;
    const selection: ExternalImportSelection = {
      source,
      root: current.root,
      sessionKeys: [
        ...new Set([
          ...items.filter((item) => selected.has(item.key)).map((item) => item.key),
          ...(customize ? (initial?.sessionKeys.filter((key) => selected.has(key)) ?? []) : []),
        ]),
      ],
      resourceKeys: current.resources
        .filter((item) => item.available && selected.has(item.key))
        .map((item) => item.key),
      projectPaths: projects.filter((path) => selected.has(`project:${path}`)),
      includeArchived: archived,
      workspaceMappings: mappings,
      targetWorkspacePath: defaultTarget,
      expectedRevisions: Object.fromEntries(
        [...items, ...current.resources]
          .filter((item) => selected.has(item.key))
          .map((item) => [item.key, item.revision]),
      ),
    };
    if (customize) {
      await controller.configure({
        selections: [
          ...controller.view.selections.filter(
            (item) => item !== initial && !(item.source === source && item.root === current.root),
          ),
          selection,
        ],
      });
      onClose();
    } else await controller.execute(selection);
  };
  const busy = operation?.state === "running";
  const result = operation && operation.state !== "running";
  return (
    <Dialog
      open={source !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="flex max-h-[85dvh] w-[calc(100%_-_2rem)] max-w-lg flex-col gap-0 overflow-hidden p-0"
        data-testid="external-import-dialog"
      >
        <DialogHeader className="shrink-0 p-5 pb-4">
          <DialogTitle>{t(busy ? "running" : result ? "done" : "selectionTitle")}</DialogTitle>
          <DialogDescription>{t(busy ? "closeRunning" : "selectionDescription")}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 space-y-3 overflow-y-auto px-5 pb-4">
          {controller.error && (
            <p role="alert" className="break-words text-ui-sm text-destructive">
              {reason(controller.error)}
            </p>
          )}
          {operation ? (
            <>
              <Progress
                value={operation.total ? (100 * operation.completed) / operation.total : 0}
              />
              <p className="text-ui-sm text-foreground-subtle">
                {operation.completed} / {operation.total}
              </p>
              <ImportResults
                operation={operation}
                controller={controller}
                onClose={onClose}
                t={t}
                reason={reason}
              />
            </>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 break-all text-ui-xs text-foreground-subtle">
                  {current?.root || root || t("sourcePath")}
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("directory")}
                  disabled={loading}
                  onClick={async () => {
                    const path = await controller.chooseDirectory();
                    if (path) {
                      setRoot(path);
                      rescan({ root: path });
                    }
                  }}
                >
                  <FolderOpen className="size-4" />
                </Button>
              </div>
              <div className="flex gap-2">
                <Input
                  placeholder={t("search")}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") rescan();
                  }}
                />
                <Button size="sm" variant="outline" disabled={loading} onClick={() => rescan()}>
                  {t("searchAction")}
                </Button>
              </div>
              <Select
                value={days}
                onValueChange={(value) => {
                  setDays(value);
                  rescan({ days: value });
                }}
              >
                <SelectTrigger aria-label={t("timeRange")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["all", "7", "30", "90"].map((value) => (
                    <SelectItem key={value} value={value}>
                      {value === "all"
                        ? t("allTime")
                        : intl.formatMessage({ id: "import.lastDays" }, { days: value })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  const path = await controller.chooseDirectory();
                  if (path) setDefaultTarget(path);
                }}
              >
                <FolderOpen className="size-4 shrink-0" />
                <span className="truncate">{defaultTarget || t("defaultTarget")}</span>
              </Button>
              {source === "codex" && (
                <label className="flex items-center gap-2 text-ui-sm">
                  <Checkbox
                    checked={archived}
                    onCheckedChange={(value) => {
                      setArchived(value === true);
                      rescan({ includeArchived: value === true });
                    }}
                  />
                  {t("archived")}
                </label>
              )}
              {loading && (
                <p
                  role="status"
                  className="flex items-center gap-2 text-ui-sm text-foreground-subtle"
                >
                  <Loader2 className="size-4 animate-spin" />
                  {t("loading")}
                </p>
              )}
              {current?.warnings.map((warning, index) => (
                <p key={index} className="break-words text-ui-xs text-foreground-subtle">
                  {reason(warning)}
                </p>
              ))}
              {current && !current.total && !current.resources.length && !loading && (
                <p className="text-ui-sm text-foreground-subtle">{t("empty")}</p>
              )}
              {Boolean(current?.resources.length) && (
                <ImportSelectionGroup
                  title={t("tools")}
                  selected={selected}
                  onChange={change}
                  items={current!.resources.map((item) => ({
                    key: item.key,
                    label: `${t(item.kind)} · ${item.name}`,
                    caption: `${item.sourcePath} → ${item.workspacePath && mappings[item.workspacePath] ? `${mappings[item.workspacePath]!.replace(/[\\/]+$/u, "")}/${item.targetPath.slice(item.workspacePath.length).replace(/^[\\/]+/u, "")}` : item.targetPath}`,
                    available: item.available,
                    note: reason(item.reason) || t("selectionDescription"),
                  }))}
                />
              )}
              {projects.length > 0 && (
                <>
                  <ImportSelectionGroup
                    title={`${t("projects")} (${projects.length})`}
                    selected={selected}
                    onChange={change}
                    items={projects.map((path) => ({
                      key: `project:${path}`,
                      label: path.split(/[\\/]/u).filter(Boolean).at(-1) || path,
                      caption: mappings[path] ? `${path} → ${mappings[path]}` : path,
                      available: true,
                    }))}
                  />
                  {projects.map((path) => (
                    <Button
                      key={path}
                      variant="ghost"
                      size="sm"
                      className="max-w-full justify-start"
                      onClick={async () => {
                        const target = await controller.chooseDirectory();
                        if (target) setMappings((previous) => ({ ...previous, [path]: target }));
                      }}
                    >
                      <FolderOpen className="size-4 shrink-0" />
                      <span className="truncate">
                        {t("target")}: {path.split(/[\\/]/u).at(-1)}
                      </span>
                    </Button>
                  ))}
                </>
              )}
              {items.length > 0 && (
                <ImportSelectionGroup
                  title={`${t("sessions")} (${items.length === current?.total ? items.length : `${items.length} / ${current?.total ?? 0}`})`}
                  selected={selected}
                  onChange={change}
                  items={items.map((item) => ({
                    key: item.key,
                    label: item.title,
                    caption: `${item.workspacePath} · ${new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(item.updatedAt)}`,
                    available: true,
                    note: item.importedTaskId
                      ? t("reason.already_imported")
                      : item.warnings.map((value) => reason(value)).join("\n"),
                  }))}
                />
              )}
              {current?.nextCursor !== undefined && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={loading}
                  onClick={() => rescan({ cursor: current.nextCursor })}
                >
                  {t("more")}
                </Button>
              )}
            </>
          )}
        </div>
        <DialogFooter className="shrink-0 items-center border-t border-border p-4">
          {!operation && (
            <span className="mr-auto text-ui-xs text-foreground-subtle">
              {intl.formatMessage({ id: "import.count" }, { count: selected.size })}
            </span>
          )}
          {busy ? (
            <Button variant="outline" onClick={() => void controller.cancel()}>
              {t("stop")}
            </Button>
          ) : (
            <Button variant="ghost" onClick={onClose}>
              {t(operation ? "close" : "cancel")}
            </Button>
          )}
          {!operation && (
            <Button
              disabled={loading || !current || (!customize && !selected.size)}
              onClick={() => void confirm()}
            >
              {t(customize ? "saveScope" : "confirm")}
            </Button>
          )}
          {result && (
            <Button variant="outline" onClick={controller.resetOperation}>
              {t("adjustSelection")}
            </Button>
          )}
          {result &&
            (operation.state === "cancelled" ||
              operation.results.some(
                (item) => item.status === "failed" || item.status === "cancelled",
              )) && (
              <Button onClick={() => void controller.retry(operation.id)}>{t("retry")}</Button>
            )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
