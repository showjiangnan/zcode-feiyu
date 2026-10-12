// Modified by ZCode Feiyu.
import type { ModelSelectionView } from "@zcode/services";

export interface ProviderAvailabilityState {
  readonly source: "registry";
  readonly hydrated: boolean;
  readonly providerCount: number;
  readonly hasUsableProvider: boolean;
  readonly hasUsableSubscription: boolean;
}

export function resolveProviderAvailabilityState(params: {
  modelSelectionView: ModelSelectionView | null;
}): ProviderAvailabilityState {
  const providers = params.modelSelectionView?.providers ?? [];
  return {
    source: "registry",
    hydrated: params.modelSelectionView !== null,
    providerCount: providers.length,
    hasUsableSubscription: providers.some(
      (provider) =>
        provider.config.visibility !== "hidden" &&
        provider.config.access?.type === "chatgpt-subscription" &&
        provider.config.access.entitled &&
        provider.models.length > 0,
    ),
    hasUsableProvider:
      params.modelSelectionView !== null &&
      providers.some((provider) => provider.models.length > 0),
  };
}

export function shouldOpenProviderLoginEntry(params: {
  availability: ProviderAvailabilityState;
  providerFamilyDomain: string | null | undefined;
  hasUser: boolean;
}): boolean {
  // 订阅连接不属于智谱区域账号；已授权目录可独立恢复，不能每次启动再要求连接。
  return (
    (!params.providerFamilyDomain && !params.availability.hasUsableSubscription) ||
    (!params.hasUser && !params.availability.hasUsableProvider)
  );
}
