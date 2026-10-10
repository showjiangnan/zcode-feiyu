// Modified by ZCode Feiyu contributors (2026).
import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Loader2,
  Monitor,
  Play,
  Square,
  Move,
  ArrowUpRight,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu.js";
import { Button } from "@/components/ui/button.js";
import { useComputerControlTaskNavigation } from "@/hooks/useComputerControlTaskNavigation.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useComputerControl } from "@/hooks/useComputerControl.js";

export function ComputerControlPreview({
  workspacePath,
  workspaceIdentity,
  sessionId,
  taskTitle,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string;
  taskTitle: string;
}) {
  const { intl } = useZCodeIntl();
  const { taskLabel, returnToTask } = useComputerControlTaskNavigation(
    workspacePath,
    workspaceIdentity,
  );
  const message = (id: string) => intl.formatMessage({ id: `computerControl.${id}` });
  const { snapshot, command, act, pending, error, subscriber } = useComputerControl(
    workspacePath,
    workspaceIdentity,
    sessionId,
  );
  const [pageVisible, setPageVisible] = useState(document.visibilityState !== "hidden");
  useEffect(() => {
    const listener = () => setPageVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  }, []);
  const [width, setWidth] = useState(560);
  const [otherTasks, setOtherTasks] = useState<string[]>([]);
  const [hiddenSources, setHiddenSources] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const offsetRef = useRef(offset);
  offsetRef.current = offset;
  const drag = useRef<{ x: number; y: number; originX: number; originY: number } | undefined>(
    undefined,
  );
  const panel = useRef<HTMLElement>(null);
  const [narrow, setNarrow] = useState(false);
  const allSources = snapshot?.sources || [];
  const taskIds = [...new Set(allSources.map((source) => source.sessionId))];
  const sources = allSources.filter(
    (source) => source.sessionId === sessionId || otherTasks.includes(source.sessionId),
  );
  const candidates = sources.filter((source) => !hiddenSources.includes(source.id));
  const current = candidates.find((source) => source.id === selected) || candidates[0];
  const visible =
    collapsed || !pageVisible ? [] : narrow ? (current ? [current] : []) : candidates.slice(0, 4);
  const ids = JSON.stringify(visible.map((source) => source.id));
  useEffect(() => {
    if (snapshot)
      void command("visibility", { sourceIds: JSON.parse(ids) as string[], subscriber }).catch(
        () => undefined,
      );
  }, [command, ids, subscriber, Boolean(snapshot)]);
  useEffect(() => {
    const owner = panel.current?.parentElement;
    if (!owner) return;
    const observer = new ResizeObserver(() => {
      setNarrow(owner.clientWidth < 600);
      const parent = owner.getBoundingClientRect();
      const frame = panel.current?.getBoundingClientRect();
      if (!frame) return;
      const origin = offsetRef.current;
      const minimumX = parent.left - frame.left + origin.x;
      const minimumY = parent.top - frame.top + origin.y;
      setOffset((currentOffset) => {
        const x = Math.min(0, Math.max(minimumX, currentOffset.x));
        const y = Math.min(0, Math.max(minimumY, currentOffset.y));
        return x === currentOffset.x && y === currentOffset.y ? currentOffset : { x, y };
      });
    });
    observer.observe(owner);
    if (panel.current) observer.observe(panel.current);
    return () => observer.disconnect();
  }, [sources.length > 0]);
  useEffect(() => {
    setOtherTasks([]);
    setHiddenSources([]);
    setSelected(undefined);
    setOffset({ x: 0, y: 0 });
  }, [sessionId]);
  if (!allSources.length) return null;
  return (
    <>
      {allSources.length ? (
        <section
          ref={panel}
          data-testid="computer-control-preview"
          aria-label={message("title")}
          className="absolute right-3 bottom-28 z-30 overflow-hidden rounded-2xl border border-border bg-background shadow-md [app-region:no-drag]"
          style={{
            resize: "both",
            minWidth: 280,
            maxHeight: "calc(100% - 8rem)",
            overflow: "auto",
            width: `min(${width}px, calc(100% - 1.5rem))`,
            transform: `translate(${offset.x}px, ${offset.y}px)`,
          }}
        >
          <header className="flex items-center gap-2 border-b border-border px-3 py-2">
            <button
              type="button"
              aria-label={message("move")}
              className="cursor-move touch-none text-foreground-subtle focus-visible:ring-2 focus-visible:ring-ring"
              onPointerDown={(event) => {
                drag.current = {
                  x: event.clientX,
                  y: event.clientY,
                  originX: offset.x,
                  originY: offset.y,
                };
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                if (!drag.current || !panel.current?.parentElement) return;
                const parent = panel.current.parentElement.getBoundingClientRect();
                const rect = panel.current.getBoundingClientRect();
                const x = drag.current.originX + event.clientX - drag.current.x;
                const y = drag.current.originY + event.clientY - drag.current.y;
                setOffset({
                  x: Math.min(0, Math.max(-parent.width + rect.width + 24, x)),
                  y: Math.min(0, Math.max(-parent.height + rect.height + 120, y)),
                });
              }}
              onPointerUp={() => {
                drag.current = undefined;
              }}
              onPointerCancel={() => {
                drag.current = undefined;
              }}
              onKeyDown={(event) => {
                const delta = {
                  ArrowLeft: [-10, 0],
                  ArrowRight: [10, 0],
                  ArrowUp: [0, -10],
                  ArrowDown: [0, 10],
                }[event.key];
                if (delta) {
                  event.preventDefault();
                  const owner = panel.current?.parentElement;
                  const frame = panel.current?.getBoundingClientRect();
                  if (!owner || !frame) return;
                  const parent = owner.getBoundingClientRect();
                  setOffset((value) => ({
                    x: Math.min(
                      0,
                      Math.max(parent.left - frame.left + value.x, value.x + delta[0]!),
                    ),
                    y: Math.min(0, Math.max(parent.top - frame.top + value.y, value.y + delta[1]!)),
                  }));
                }
              }}
            >
              <Move className="size-4" />
            </button>
            <Monitor className="size-4 text-foreground-subtle" />
            <span className="min-w-0 flex-1 truncate text-ui-sm font-medium">
              {taskTitle || message("title")}
            </span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" aria-label={message("sources")}>
                  {message("sources")}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="max-h-80 overflow-y-auto">
                {taskIds.map((task) => (
                  <DropdownMenuCheckboxItem
                    key={task}
                    checked={task === sessionId || otherTasks.includes(task)}
                    disabled={task === sessionId}
                    onCheckedChange={(checked) =>
                      setOtherTasks((values) =>
                        checked ? [...values, task] : values.filter((value) => value !== task),
                      )
                    }
                  >
                    {task === sessionId ? message("currentTask") : taskLabel(task)}
                  </DropdownMenuCheckboxItem>
                ))}
                <DropdownMenuSeparator />
                {sources.map((source) => (
                  <DropdownMenuCheckboxItem
                    key={source.id}
                    checked={!hiddenSources.includes(source.id)}
                    onCheckedChange={(checked) =>
                      setHiddenSources((values) =>
                        checked
                          ? values.filter((value) => value !== source.id)
                          : [...values, source.id],
                      )
                    }
                  >
                    {source.app.displayName} · {source.title || message("window")}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={message(collapsed ? "expand" : "collapse")}
              onClick={() => setCollapsed((value) => !value)}
            >
              {collapsed ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
            </Button>
          </header>
          {!collapsed ? (
            <>
              <div className="flex items-center gap-2 px-3 py-2">
                <span className="shrink-0 text-ui-xs text-foreground-subtle">
                  {message("resize")}
                </span>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={message("smaller")}
                  onClick={() => setWidth((value) => Math.max(300, value - 40))}
                >
                  −
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={message("larger")}
                  onClick={() => setWidth((value) => Math.min(720, value + 40))}
                >
                  +
                </Button>
              </div>
              {narrow && sources.length > 1 ? (
                <div className="flex gap-1 overflow-x-auto p-2">
                  {sources.map((source) => (
                    <Button
                      key={source.id}
                      variant={source.id === current?.id ? "secondary" : "ghost"}
                      size="sm"
                      onClick={() => setSelected(source.id)}
                    >
                      {source.app.displayName}
                    </Button>
                  ))}
                </div>
              ) : null}
              <div
                className={
                  visible.length > 1 ? "grid grid-cols-2 gap-px bg-border" : "grid grid-cols-1"
                }
              >
                {visible.map((source) => (
                  <article key={source.id} className="min-w-0 bg-background">
                    <div className="relative flex aspect-video items-center justify-center overflow-hidden bg-surface-hover">
                      {source.image ? (
                        <img
                          className="h-full w-full object-contain"
                          src={`data:${source.image.mimeType};base64,${source.image.data}`}
                          alt={`${source.app.displayName} — ${source.title}`}
                          draggable={false}
                        />
                      ) : source.phase === "observing" || source.phase === "ready" ? (
                        <Loader2
                          className="size-5 animate-spin text-foreground-subtle"
                          aria-label={message("loading")}
                        />
                      ) : (
                        <span className="px-3 text-center text-ui-sm text-foreground-subtle">
                          {source.channels?.image?.status === "preview-paused"
                            ? message("selfPreview")
                            : source.reason === "device_quarantined"
                              ? message("deviceQuarantined")
                              : source.reason && source.stopRevision
                                ? message(`reason.${source.reason}`)
                                : message(`phase.${source.phase}`)}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 px-2 py-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-ui-sm font-medium">{source.app.displayName}</p>
                        <p className="truncate text-ui-xs text-foreground-subtle">
                          {source.title || message("window")} ·{" "}
                          {source.sessionId === sessionId
                            ? message("currentTask")
                            : taskLabel(source.sessionId)}{" "}
                          ·{" "}
                          {source.reason && source.stopRevision
                            ? message(`reason.${source.reason}`)
                            : message(`phase.${source.phase}`)}
                        </p>
                      </div>
                      {source.sessionId !== sessionId ? (
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={message("returnTask")}
                          onClick={() => returnToTask(source.sessionId)}
                        >
                          <ArrowUpRight className="size-4" />
                        </Button>
                      ) : null}
                      {source.stopRevision &&
                      (source.phase === "stopped" || source.phase === "paused") ? (
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          disabled={pending}
                          aria-label={message("continue")}
                          onClick={() =>
                            void act("resume", {
                              sourceId: source.id,
                              stopRevision: source.stopRevision,
                            })
                          }
                        >
                          <Play className="size-4" />
                        </Button>
                      ) : (
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          disabled={pending || source.phase === "stopping"}
                          aria-label={message("stop")}
                          onClick={() => void act("stop", { sourceId: source.id })}
                        >
                          <Square className="size-4" />
                        </Button>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            </>
          ) : null}
          {error ? (
            <p role="alert" className="px-3 py-2 text-ui-sm text-danger">
              {error}
            </p>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
