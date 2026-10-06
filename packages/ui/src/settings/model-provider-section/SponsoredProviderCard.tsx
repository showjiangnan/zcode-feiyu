import { CoinsIcon, LayersIcon, ReceiptTextIcon, ShieldCheckIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useProviderDetailFeedback } from "./ProviderDetailFeedback.js";
import { PlanStatusCardSurface } from "./StatusCards.js";
import { SPONSORED_PROVIDER_SPECS, type SponsoredProviderId } from "./sponsoredProviders.js";

const FEATURES = [
  { id: "models", Icon: LayersIcon },
  { id: "value", Icon: CoinsIcon },
  { id: "routing", Icon: ShieldCheckIcon },
  { id: "billing", Icon: ReceiptTextIcon },
] as const;

export function SponsoredProviderCard({ sponsorId }: { sponsorId: SponsoredProviderId }) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const { showFeedback, dismissFeedback } = useProviderDetailFeedback();
  const sponsor = SPONSORED_PROVIDER_SPECS.find((item) => item.id === sponsorId)!;
  const feedbackKey = `sponsored-open:${sponsor.id}`;

  const openLogin = () => {
    dismissFeedback(feedbackKey);
    try {
      platform.openExternal(sponsor.loginUrl);
    } catch {
      showFeedback({
        key: feedbackKey,
        state: "failure",
        message: intl.formatMessage({ id: "settings.modelProvider.sponsored.openFailed" }),
      });
    }
  };

  return (
    <section className="space-y-4" data-testid="sponsored-provider-detail">
      <PlanStatusCardSurface
        planTitle={sponsor.label}
        titleAccessory={
          <Badge variant="outline">
            {intl.formatMessage({ id: "settings.modelProvider.sponsored.badge" })}
          </Badge>
        }
        statusMeta={
          <p className="text-ui-base leading-6 text-foreground-subtle">
            {intl.formatMessage({ id: "settings.modelProvider.sponsored.loginDescription" })}
          </p>
        }
        trailingAction={
          <Button type="button" size="sm" onClick={openLogin}>
            {intl.formatMessage({ id: "settings.modelProvider.sponsored.login" })}
          </Button>
        }
      />
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {FEATURES.map(({ id, Icon }) => (
          <article
            key={id}
            className="min-w-0 space-y-3 rounded-xl border border-border bg-surface p-4"
          >
            <Icon className="size-5 text-foreground-subtle" aria-hidden="true" />
            <div className="space-y-1.5">
              <h4 className="text-ui-lg font-semibold text-foreground">
                {intl.formatMessage({ id: `settings.modelProvider.sponsored.${id}.title` })}
              </h4>
              <p className="text-ui-base leading-6 text-foreground-subtle">
                {intl.formatMessage({ id: `settings.modelProvider.sponsored.${id}.description` })}
              </p>
            </div>
          </article>
        ))}
      </div>
      <p className="text-ui-sm leading-5 text-foreground-subtlest">
        {intl.formatMessage({ id: "settings.modelProvider.sponsored.pricingNote" })}
      </p>
      <p className="text-ui-base leading-6 text-foreground-subtle">
        {intl.formatMessage({ id: "settings.modelProvider.sponsored.setupHint" })}
      </p>
    </section>
  );
}
