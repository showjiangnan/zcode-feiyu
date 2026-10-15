// Modified by ZCode Feiyu.
import { RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useTeamorouterBalance } from "@/hooks/useTeamorouterBalance.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useProviderDetailFeedback } from "./ProviderDetailFeedback.js";
import { SPONSORED_PROVIDER_SPECS } from "./sponsoredProviders.js";

export function TeamorouterBalanceSection({
  providerId,
  settingsRevision,
}: {
  providerId: string;
  settingsRevision: number;
}) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const { showFeedback } = useProviderDetailFeedback();
  const { state, refresh } = useTeamorouterBalance(providerId, settingsRevision);
  const recharge = async () => {
    try {
      await platform.openExternal(SPONSORED_PROVIDER_SPECS[0].loginUrl);
    } catch {
      showFeedback({
        key: `balance-recharge:${providerId}`,
        state: "failure",
        message: intl.formatMessage({ id: "settings.modelProvider.sponsored.openFailed" }),
      });
    }
  };
  return (
    <section
      data-testid="teamorouter-balance"
      className="flex min-w-0 items-center gap-3"
      aria-label={intl.formatMessage({ id: "settings.modelProvider.balance.title" })}
    >
      <div className="min-w-0 flex-1">
        <div className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.modelProvider.balance.title" })}
        </div>
        <div
          aria-live="polite"
          data-testid="teamorouter-balance-value"
          className="break-all text-ui-base text-foreground"
        >
          {state.status === "ready"
            ? `${state.balance.value} ${state.balance.currency}`
            : state.status === "loading"
              ? intl.formatMessage({ id: "common.loading" })
              : intl.formatMessage({ id: `settings.modelProvider.balance.error.${state.kind}` })}
        </div>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="shrink-0"
        disabled={state.status === "loading"}
        aria-label={intl.formatMessage({ id: "settings.modelProvider.balance.refresh" })}
        data-testid="teamorouter-balance-refresh"
        onClick={refresh}
      >
        <RefreshCwIcon
          className={`size-3.5 ${state.status === "loading" ? "animate-spin" : ""}`}
          aria-hidden="true"
        />
      </Button>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="ml-auto shrink-0"
        data-testid="teamorouter-recharge"
        onClick={() => void recharge()}
      >
        {intl.formatMessage({ id: "settings.modelProvider.balance.recharge" })}
      </Button>
    </section>
  );
}
