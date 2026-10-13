// Modified by ZCode Feiyu.
import { ComputerControlPreviewStack } from "./ComputerControlPreviewStack.js";
import { ComputerControlPreviewMove } from "./ComputerControlPreviewMove.js";
import { createPortal } from "react-dom";
import { useComputerControlPreviewWindow } from "@/hooks/useComputerControlPreviewWindow.js";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Monitor, PictureInPicture2, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
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
  const floating = useComputerControlPreviewWindow();
  const [clock, setClock] = useState(() => Date.now());
  const { snapshot, command, act, pending, error, subscriber } = useComputerControl(
    workspacePath,
    workspaceIdentity,
    sessionId,
    Boolean(floating.window && floating.visible),
  );
  const [pageVisible, setPageVisible] = useState(document.visibilityState !== "hidden");
  useEffect(() => {
    const listener = () => setPageVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  }, []);
  const [width, setWidth] = useState(340);
  const [otherTasks, setOtherTasks] = useState<string[]>([]);
  const [hiddenSources, setHiddenSources] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const offsetRef = useRef(offset);
  offsetRef.current = offset;
  const panel = useRef<HTMLElement>(null);
  const [narrow, setNarrow] = useState(false);
  const allSources = snapshot?.sources || [];
  const hasFrames = allSources.some((source) => source.image);
  useEffect(() => {
    if (!hasFrames) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasFrames]);
  const taskIds = [...new Set(allSources.map((source) => source.sessionId))];
  const sources = allSources.filter(
    (source) => source.sessionId === sessionId || otherTasks.includes(source.sessionId),
  );
  const candidates = sources.filter((source) => !hiddenSources.includes(source.id));
  const current = candidates.find((source) => source.id === selected) || candidates.at(-1);
  // 选中来源只改变前景；保持其它三个可见来源，不改变控制目标或权限。
  const stacked = current
    ? [...candidates.filter((source) => source !== current).slice(-3), current]
    : [];
  const visible = collapsed || !(floating.window ? floating.visible : pageVisible) ? [] : stacked;
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
    const view = owner.ownerDocument.defaultView || window;
    let resizeFrame = 0;
    const updateBounds = () => {
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
    };
    // ResizeObserver 内同步改布局会导致重复通知；按该窗口的下一帧统一测量。
    const observer = new ResizeObserver(() => {
      view.cancelAnimationFrame(resizeFrame);
      resizeFrame = view.requestAnimationFrame(updateBounds);
    });
    observer.observe(owner);
    if (panel.current) observer.observe(panel.current);
    return () => {
      observer.disconnect();
      view.cancelAnimationFrame(resizeFrame);
    };
  }, [sources.length > 0, Boolean(floating.window)]);
  useEffect(() => {
    setOtherTasks([]);
    setHiddenSources([]);
    setSelected(undefined);
    setOffset({ x: 0, y: 0 });
  }, [sessionId]);
  useEffect(() => {
    if (snapshot && !allSources.length) floating.close();
  }, [allSources.length, Boolean(snapshot), floating.close]);
  if (!allSources.length) return null;
  const content = (
    <>
      {allSources.length ? (
        <section
          ref={panel}
          data-testid="computer-control-preview"
          aria-label={message("title")}
          className={
            floating.window
              ? "relative h-screen overflow-auto bg-background [app-region:no-drag]"
              : "absolute right-3 bottom-28 z-30 rounded-xl bg-background/90 [app-region:no-drag]"
          }
          style={{
            resize: floating.window ? "none" : "both",
            minWidth: 280,
            maxHeight: floating.window ? "100vh" : "calc(100% - 8rem)",
            overflow: "auto",
            width: floating.window ? "100%" : `min(${width}px, calc(100% - 1.5rem))`,
            transform: floating.window ? undefined : `translate(${offset.x}px, ${offset.y}px)`,
          }}
        >
          <header className="flex items-center gap-1 px-2 py-1">
            <ComputerControlPreviewMove
              panel={panel}
              offset={offset}
              setOffset={setOffset}
              hidden={Boolean(floating.window)}
            />
            <Monitor className="size-4 text-foreground-subtle" />
            <span className="min-w-0 flex-1 truncate text-ui-sm font-medium">
              {taskTitle || message("title")}
            </span>
            {floating.supported ? (
              <Button
                variant="ghost"
                size="sm"
                aria-label={message(floating.window ? "dock" : "detach")}
                onClick={() => (floating.window ? floating.close() : void floating.open())}
              >
                {floating.window ? (
                  <X className="size-4" />
                ) : (
                  <PictureInPicture2 className="size-4" />
                )}
              </Button>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" aria-label={message("sources")}>
                  {message("sources")}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                portalContainer={floating.window?.document.body}
                className="max-h-80 overflow-y-auto"
              >
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
                <div className="flex items-center gap-2 px-2 py-1">
                  <span className="flex-1 text-ui-xs text-foreground-subtle">
                    {message("resize")}
                  </span>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={message("smaller")}
                    onClick={() => setWidth((value) => Math.max(280, value - 40))}
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
                <DropdownMenuSeparator />
                <DropdownMenuRadioGroup
                  value={current?.id}
                  onValueChange={(id) => {
                    setSelected(id);
                    setHiddenSources((values) => values.filter((value) => value !== id));
                  }}
                >
                  {sources.map((source) => (
                    <DropdownMenuRadioItem key={source.id} value={source.id}>
                      {source.app.displayName} · {source.title || message("window")}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
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
              <ComputerControlPreviewStack
                sources={visible}
                sessionId={sessionId}
                clock={clock}
                narrow={narrow}
                pending={pending}
                message={message}
                taskLabel={taskLabel}
                select={setSelected}
                stop={(source) => void act("stop", { sourceId: source.id })}
                resume={(source) =>
                  void act("resume", { sourceId: source.id, stopRevision: source.stopRevision })
                }
                returnToTask={returnToTask}
              />
            </>
          ) : null}
          {error || floating.error ? (
            <p role="alert" className="px-3 py-2 text-ui-sm text-danger">
              {error || floating.error}
            </p>
          ) : null}
        </section>
      ) : null}
    </>
  );
  return floating.window ? createPortal(content, floating.window.document.body) : content;
}
