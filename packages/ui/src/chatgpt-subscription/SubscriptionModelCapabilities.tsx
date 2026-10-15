// Modified by ZCode Feiyu.
import type { ChatGPTSubscriptionModel } from "@zcode/shared";
import {
  getSubscriptionEffectiveContextWindow,
  getSubscriptionSpeedOptions,
} from "@zcode/shared/chatgpt-subscription-catalog";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/** 只读同一订阅 owner 的目录事实；不创建模型设置或许可写入路径。 */
export function SubscriptionModelCapabilities({ model }: { model: ChatGPTSubscriptionModel }) {
  const { intl, locale } = useZCodeIntl();
  const m = (key: string) =>
    intl.formatMessage({ id: `chatgptSubscription.modelCapabilities.${key}` });
  const capabilities = model.capabilities;
  const boolean = (value?: boolean) =>
    value === undefined ? m("unknown") : m(value ? "yes" : "no");
  const number = (value?: number) =>
    value === undefined ? m("unknown") : value.toLocaleString(locale);
  const effort = (value: string) =>
    ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(value)
      ? intl.formatMessage({ id: `chatgptSubscription.modelCapabilities.effort.${value}` })
      : value;
  const speedKnown =
    capabilities?.serviceTiers !== undefined || capabilities?.additionalSpeedTiers !== undefined;
  const rows: [string, string][] = capabilities
    ? [
        [
          "speed",
          speedKnown
            ? getSubscriptionSpeedOptions(capabilities)
                .map((speed) => intl.formatMessage({ id: `chat.modelSpeed.${speed}` }))
                .join(" · ")
            : m("unknown"),
        ],
        [
          "reasoning",
          capabilities.supportedReasoningLevels === undefined
            ? m("unknown")
            : capabilities.supportedReasoningLevels
                .map((entry) => effort(entry.effort))
                .join(" · ") || m("empty"),
        ],
        [
          "defaultReasoning",
          capabilities.defaultReasoningLevel
            ? effort(capabilities.defaultReasoningLevel)
            : m("unknown"),
        ],
        ["context", number(capabilities.contextWindow)],
        ["effectiveContext", number(getSubscriptionEffectiveContextWindow(model))],
        ["maxContext", number(capabilities.maxContextWindow)],
        [
          "inputs",
          capabilities.inputModalities === undefined
            ? m("unknown")
            : capabilities.inputModalities
                .map((input) =>
                  ["text", "image", "file", "audio", "video"].includes(input)
                    ? m(`input.${input}`)
                    : input,
                )
                .join(" · ") || m("empty"),
        ],
        ["search", boolean(capabilities.supportsSearchTool)],
        ["imageDetail", boolean(capabilities.supportsImageDetailOriginal)],
        ["verbosity", boolean(capabilities.supportVerbosity)],
        [
          "defaultVerbosity",
          capabilities.defaultVerbosity ? effort(capabilities.defaultVerbosity) : m("unknown"),
        ],
      ]
    : [];
  return (
    <details
      className="w-full min-w-0 border-t border-border pt-2"
      data-testid="subscription-model-capabilities"
    >
      <summary className="cursor-pointer text-ui-sm text-foreground-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40">
        {m("title")}
      </summary>
      {capabilities?.description ? (
        <p className="mt-2 break-words text-ui-sm text-foreground-subtle">
          {capabilities.description}
        </p>
      ) : null}
      {rows.length ? (
        <dl className="mt-2 grid gap-2 text-ui-sm sm:grid-cols-2">
          {rows.map(([key, value]) => (
            <div key={key} className="min-w-0">
              <dt className="text-foreground-subtlest">{m(key)}</dt>
              <dd className="break-words text-foreground">{value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="mt-2 text-ui-sm text-foreground-subtle">{m("unknown")}</p>
      )}
    </details>
  );
}
