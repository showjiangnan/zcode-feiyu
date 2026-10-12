// Modified by ZCode Feiyu.
import { useState } from "react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ChatGPTIcon, ChatGPTSubscriptionPanel } from "./ChatGPTSubscriptionPanel.js";

export function ChatGPTLoginEntry({ onReady }: { onReady?: () => void }) {
  const [open, setOpen] = useState(false),
    { intl } = useZCodeIntl();
  const title = intl.formatMessage({ id: "chatgptSubscription.entry" });
  return (
    <>
      <div className="flex items-center gap-3 py-2 text-ui-sm text-foreground-subtle">
        <span className="h-px flex-1 bg-border" />
        <span>or</span>
        <span className="h-px flex-1 bg-border" />
      </div>
      <Button
        variant="default"
        className="h-10 w-full text-ui-base"
        size="lg"
        data-testid="chatgpt-login-entry"
        onClick={() => setOpen(true)}
      >
        <ChatGPTIcon />
        {title}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              {intl.formatMessage({ id: "chatgptSubscription.description" })}
            </DialogDescription>
          </DialogHeader>
          <ChatGPTSubscriptionPanel
            onReady={() => {
              setOpen(false);
              onReady?.();
            }}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
