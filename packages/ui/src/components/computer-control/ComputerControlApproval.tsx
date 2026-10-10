// Modified by ZCode Feiyu contributors (2026).
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog.js";
import { Button } from "@/components/ui/button.js";
import type { ControlSnapshot } from "@zcode/zcode-cua/control-contract";
export function ComputerControlApproval({
  approval,
  taskTitle,
  sessionId,
  message,
  pending,
  error,
  onDecision,
}: {
  approval?: ControlSnapshot["approvals"][number];
  taskTitle: string;
  sessionId: string;
  message(id: string): string;
  pending: boolean;
  error?: string;
  onDecision(allowed: boolean, scope?: "turn" | "workspace"): void;
}) {
  return (
    <Dialog
      open={Boolean(approval)}
      onOpenChange={(open) => {
        if (!open && approval) onDecision(false);
      }}
    >
      <DialogContent>
        <DialogTitle>{message("approval.title")}</DialogTitle>
        <DialogDescription>
          {taskTitle || sessionId} · {approval?.app.displayName}
        </DialogDescription>
        <p className="break-all text-ui-sm text-foreground-subtle">{approval?.app.path}</p>
        <p className="text-ui-sm">{message("approval.description")}</p>
        {error ? (
          <p role="alert" className="text-ui-sm text-danger">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" disabled={pending} onClick={() => onDecision(false)}>
            {message("deny")}
          </Button>
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => onDecision(true, "workspace")}
          >
            {message("allowWorkspace")}
          </Button>
          <Button disabled={pending} onClick={() => onDecision(true, "turn")}>
            {message("allowTurn")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
