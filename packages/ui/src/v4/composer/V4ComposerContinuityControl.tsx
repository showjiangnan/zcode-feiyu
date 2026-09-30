// Modified by ZCode Feiyu contributors (2026).
import { useEffect, useRef, useState } from "react";
import { ActivityIcon, PlusIcon, Trash2Icon } from "lucide-react";
import {
  DEFAULT_PROACTIVE_STATE,
  type ProactiveState,
  type ProactiveSubscription,
  type CommandPayloadMap,
} from "@zcode/shared/zcode-protocol-v4";
import { useWorkspaceMemory } from "@/hooks/useWorkspaceMemory.js";
import {
  formatContinuityReason,
  resolveProactiveRuntimeState,
} from "@/hooks/continuityProjection.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { Textarea } from "@/components/ui/textarea.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";

type Props = {
  state?: ProactiveState;
  sessionId: string;
  workspacePath: string;
  disabled: boolean;
  onControl: (input: CommandPayloadMap["controlProactiveWork"]) => Promise<void>;
};
export function V4ComposerContinuityControl(props: Props) {
  const { intl } = useZCodeIntl();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const status = props.state?.status ?? "stopped";
  // 触发器也要能读出休眠/工作中的区别（复审 GAP-04）：折叠时只显示状态词，运行细分放进提示与 aria。
  const runtimeState = resolveProactiveRuntimeState(props.state);
  const runtimeLabel = runtimeState.label
    ? intl.formatMessage({ id: `chat.proactive.${runtimeState.label}` })
    : null;
  const reason = props.state?.reason
    ? formatContinuityReason(props.state.reason, (key, values) =>
        intl.formatMessage({ id: `chat.proactive.${key}` }, values),
      )
    : null;
  const controlLabel = runtimeLabel
    ? `${intl.formatMessage({ id: "chat.proactive.title" })} · ${runtimeLabel}`
    : intl.formatMessage({ id: "chat.proactive.title" });
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={props.disabled}
        ref={triggerRef}
        title={reason ?? runtimeLabel ?? undefined}
        aria-label={controlLabel}
        data-testid="chat-proactive-control"
        data-composer-collapse-priority="1"
        className="group/continuity h-7 gap-1 rounded-lg px-2 text-ui-base data-[composer-compact=true]:w-7 data-[composer-compact=true]:px-0"
        onClick={() => setOpen(true)}
      >
        <ActivityIcon className="size-4" />
        <span className="group-data-[composer-compact=true]/continuity:hidden">
          {intl.formatMessage({ id: `chat.proactive.${status}` })}
        </span>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        {open ? (
          <ContinuityDialog
            key={`${props.workspacePath}:${props.sessionId}:${props.state?.generation ?? 0}`}
            {...props}
            onCloseFocus={() => triggerRef.current?.focus()}
          />
        ) : null}
      </Dialog>
    </>
  );
}

function ContinuityDialog({
  state = DEFAULT_PROACTIVE_STATE,
  sessionId,
  workspacePath,
  onControl,
  onCloseFocus,
}: Props & { onCloseFocus: () => void }) {
  const { intl } = useZCodeIntl();
  const t = (name: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id: `chat.proactive.${name}` }, values);
  const { settings } = useSettings();
  const { tasks, automations, taskError } = useWorkspaceMemory(workspacePath, true);
  const [subscriptions, setSubscriptions] = useState(state.subscriptions);
  const runtimeState = resolveProactiveRuntimeState(state);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const act = async (action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      if (active.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (active.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };
  const change = (id: string, patch: Partial<ProactiveSubscription>) =>
    setSubscriptions((value) =>
      value.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  return (
    <DialogContent
      aria-describedby={undefined}
      className="max-h-[85vh] overflow-y-auto sm:max-w-2xl"
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        onCloseFocus();
      }}
    >
      <DialogHeader>
        <DialogTitle>{t("title")}</DialogTitle>
      </DialogHeader>
      <p className="text-ui-sm text-foreground-subtle">{t("description")}</p>
      {!settings?.continuityPolicy?.proactiveWorkAllowed ? (
        <p role="status" className="text-ui-sm text-foreground-subtle">
          {t("disabled")}
        </p>
      ) : null}
      <div className="space-y-1 text-ui-sm" role="status" aria-live="polite">
        <p>{t(state.status)}</p>
        {state.reason ? (
          <p className="break-words text-foreground-subtle">
            {t("stateReason", { reason: formatContinuityReason(state.reason, t) })}
          </p>
        ) : null}
        {state.status === "running" ? (
          // 休眠与工作中的区别在这里落地：休眠只是订阅就绪、等待下一次事件（复审 GAP-04）。
          <p className="text-foreground-subtle" data-testid="chat-proactive-runtime-state">
            {t(runtimeState.label === "sleeping" ? "sleeping" : "working")}
          </p>
        ) : null}
      </div>
      <div className="divide-y divide-border">
        {subscriptions.map((item) => (
          <div key={item.id} className="space-y-2 py-3">
            <div className="flex flex-wrap gap-2">
              <Select
                value={item.event}
                onValueChange={(event: ProactiveSubscription["event"]) =>
                  change(item.id, { event, sourceId: "" })
                }
                disabled={busy}
              >
                <SelectTrigger
                  className="w-full min-w-0 sm:w-auto sm:min-w-40"
                  aria-label={t("event")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["task_completed", "task_failed", "mailbox_message", "automation_due"].map(
                    (event) => (
                      <SelectItem key={event} value={event}>
                        {t(event)}
                      </SelectItem>
                    ),
                  )}
                </SelectContent>
              </Select>
              {item.event === "automation_due" ? (
                <Select
                  value={item.sourceId}
                  onValueChange={(sourceId) => change(item.id, { sourceId })}
                  disabled={busy}
                >
                  <SelectTrigger
                    className="min-w-0 flex-1 sm:min-w-40"
                    aria-label={t("automationId")}
                  >
                    <SelectValue placeholder={t("automationId")} />
                  </SelectTrigger>
                  <SelectContent>
                    {automations.map((automation) => (
                      <SelectItem key={automation.automationId} value={automation.automationId}>
                        {automation.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Select
                  value={item.sourceId}
                  onValueChange={(sourceId) => change(item.id, { sourceId })}
                  disabled={busy}
                >
                  <SelectTrigger className="min-w-0 flex-1 sm:min-w-40" aria-label={t("source")}>
                    <SelectValue placeholder={t("source")} />
                  </SelectTrigger>
                  <SelectContent>
                    {tasks
                      .filter((task) => task.taskId !== sessionId)
                      .map((task) => (
                        <SelectItem key={task.taskId} value={task.taskId}>
                          {task.title}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              )}
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("remove")}
                disabled={busy}
                onClick={() =>
                  setSubscriptions((value) => value.filter((entry) => entry.id !== item.id))
                }
              >
                <Trash2Icon className="size-4" />
              </Button>
            </div>
            <Textarea
              aria-label={t("prompt")}
              placeholder={t("prompt")}
              value={item.prompt}
              maxLength={10_000}
              disabled={busy}
              onChange={(event) => change(item.id, { prompt: event.target.value })}
            />
          </div>
        ))}
      </div>
      <Button
        variant="ghost"
        disabled={busy || subscriptions.length >= 20}
        onClick={() =>
          setSubscriptions([
            ...subscriptions,
            { id: crypto.randomUUID(), event: "task_completed", sourceId: "", prompt: "" },
          ])
        }
      >
        <PlusIcon className="size-4" />
        {t("add")}
      </Button>
      {error || taskError ? (
        <p role="alert" className="break-words text-ui-sm text-destructive">
          {error ?? taskError}
        </p>
      ) : null}
      <DialogFooter>
        <Button
          variant="ghost"
          disabled={busy || state.status === "stopped"}
          onClick={() => void act(() => onControl({ action: "stop" }))}
        >
          {t("stop")}
        </Button>
        <Button
          variant="outline"
          disabled={busy || state.status !== "running"}
          onClick={() => void act(() => onControl({ action: "pause" }))}
        >
          {t("pause")}
        </Button>
        <Button
          disabled={
            busy ||
            !settings?.continuityPolicy?.proactiveWorkAllowed ||
            subscriptions.length === 0 ||
            subscriptions.some(
              (item) =>
                !item.sourceId ||
                !item.prompt.trim() ||
                (item.event === "automation_due"
                  ? !automations.some((automation) => automation.automationId === item.sourceId)
                  : item.sourceId === sessionId ||
                    !tasks.some((task) => task.taskId === item.sourceId)),
            )
          }
          onClick={() => {
            void act(() => onControl({ action: "start", subscriptions }));
          }}
        >
          {state.status === "running" ? t("apply") : t("start")}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
