// Modified by ZCode Feiyu.
import type { ControlSource } from "@zcode/zcode-cua/control-contract";
import { ArrowUpRight, Loader2, Play, Square } from "lucide-react";
import { Button } from "@/components/ui/button.js";

export function ComputerControlPreviewStack({
  sources,
  sessionId,
  clock,
  narrow,
  pending,
  message,
  taskLabel,
  select,
  stop,
  resume,
  returnToTask,
}: {
  sources: ControlSource[];
  sessionId: string;
  clock: number;
  narrow: boolean;
  pending: boolean;
  message(id: string): string;
  taskLabel(id: string): string;
  select(id: string): void;
  stop(source: ControlSource): void;
  resume(source: ControlSource): void;
  returnToTask(id: string): void;
}) {
  const step = narrow ? 12 : 20;
  const inset = Math.max(0, sources.length - 1) * step;
  return (
    <div
      className="relative m-2"
      data-testid="computer-control-stack"
      style={{ paddingBottom: `calc((100% - ${inset}px) * 0.625 + ${inset}px)` }}
    >
      {sources.map((source, index) => {
        const foreground = index === sources.length - 1;
        const phase =
          source.channels?.image?.status === "preview-paused"
            ? message("selfPreview")
            : source.reason === "device_quarantined"
              ? message("deviceQuarantined")
              : source.reason && source.stopRevision
                ? message(`reason.${source.reason}`)
                : message(`phase.${source.phase}`);
        const label = `${source.app.displayName} — ${source.title || message("window")}`;
        return (
          <article
            key={source.id}
            data-testid="computer-control-stack-card"
            data-source-id={source.id}
            data-foreground={foreground}
            className="absolute overflow-hidden rounded-lg border border-border bg-background shadow-md motion-safe:transition-[top,left,box-shadow]"
            style={{
              left: index * step,
              top: (sources.length - index - 1) * step,
              width: `calc(100% - ${inset}px)`,
              aspectRatio: "16 / 10",
              zIndex: index + 1,
            }}
          >
            <button
              type="button"
              onClick={() => select(source.id)}
              aria-label={label}
              aria-pressed={foreground}
              className="absolute inset-0 flex h-full w-full items-center justify-center bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
            >
              {source.image ? (
                <img
                  className="h-full w-full object-contain"
                  draggable={false}
                  src={`data:${source.image.mimeType};base64,${source.image.data}`}
                  alt={label}
                />
              ) : source.phase === "observing" || source.phase === "ready" ? (
                <Loader2
                  className="size-5 animate-spin text-foreground-subtle"
                  aria-label={message("loading")}
                />
              ) : (
                <span className="px-3 text-center text-ui-xs text-foreground-subtle">{phase}</span>
              )}
            </button>
            {foreground &&
            source.image &&
            source.frameReceivedAt &&
            clock - source.frameReceivedAt > 2500 ? (
              <span
                role="status"
                className="pointer-events-none absolute top-1 left-1 rounded-md bg-background/90 px-2 py-1 text-ui-xs text-foreground-subtle"
              >
                {message("stalled")}
              </span>
            ) : null}
            {foreground ? (
              <footer className="absolute right-0 bottom-0 left-0 flex items-center gap-1 bg-background/90 px-2 py-1">
                <div className="pointer-events-none min-w-0 flex-1">
                  <p className="truncate text-ui-xs font-medium">{label}</p>
                  <p className="truncate text-ui-xs text-foreground-subtle">
                    {source.sessionId === sessionId
                      ? message("currentTask")
                      : taskLabel(source.sessionId)}{" "}
                    · {phase}
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
                    onClick={() => resume(source)}
                  >
                    <Play className="size-4" />
                  </Button>
                ) : (
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    disabled={pending || source.phase === "stopping"}
                    aria-label={message("stop")}
                    onClick={() => stop(source)}
                  >
                    <Square className="size-4" />
                  </Button>
                )}
              </footer>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}
