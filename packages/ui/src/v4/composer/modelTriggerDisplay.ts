// Modified by ZCode Feiyu.
import {
  BUILTIN_MODEL_PROVIDER_IDS,
  resolveModelProviderFamilyIdByProviderId,
} from "@zcode/shared";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import type { ModelSelectGroup } from "@/ModelConfigSelect.js";

export interface V4ModelTriggerDisplay {
  fullLabel: string;
  modelLabel: string;
  providerPrefix?: string;
}

export function formatModelChangeLabel(
  providerId: string | undefined,
  providerName: string | undefined,
  modelName: string,
  intl: Pick<IntlInstance, "formatMessage">,
): string {
  let planLabelId: string;
  // 切换记录必须保留当时的套餐身份，不能从当前连接或可用模型目录反推历史套餐。
  switch (providerId) {
    case BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan:
    case BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan:
      planLabelId = "settings.modelProvider.connectionMode.codingPlan";
      break;
    case BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan:
    case BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan:
      planLabelId = "settings.modelProvider.connectionMode.startPlan";
      break;
    case BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan:
    case BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan:
      planLabelId = "settings.modelProvider.connectionMode.teamPlan";
      break;
    default:
      return formatProviderModelLabel(providerId, providerName, modelName);
  }
  return `${modelName}(${intl.formatMessage({ id: planLabelId })})`;
}

export function formatProviderModelLabel(
  providerId: string | undefined,
  providerName: string | undefined,
  modelName: string,
): string {
  // Z.ai / BigModel 的内置连接名属于产品固定入口，拼进模型文案会重复展示
  // “Coding Plan”等连接信息；切换提示额外通过 formatModelChangeLabel 标明套餐类型。
  if (providerId && resolveModelProviderFamilyIdByProviderId(providerId)) {
    return modelName;
  }

  const normalizedProviderName = providerName?.trim();
  return normalizedProviderName ? `${normalizedProviderName}/${modelName}` : modelName;
}

export function resolveV4ModelTriggerLabel({
  modelGroups,
  normalizedValue,
  fallbackLabel,
  providerId,
  providerName,
}: {
  modelGroups: readonly ModelSelectGroup[];
  normalizedValue: string;
  fallbackLabel: string;
  providerId: string | undefined;
  providerName?: string;
}): string {
  const selectedGroup = modelGroups.find((group) =>
    group.items.some((item) => item.value === normalizedValue),
  );
  const selectedItem = selectedGroup?.items.find((item) => item.value === normalizedValue);
  if (!selectedGroup || !selectedItem) {
    return fallbackLabel;
  }

  // 仅当前菜单中存在的连接按 ID 兜底；历史记录的通用格式化保留原有语义。
  return formatProviderModelLabel(
    providerId,
    providerName?.trim() || providerId,
    selectedItem.name,
  );
}

export function resolveV4ModelTriggerDisplay({
  modelGroups,
  normalizedValue,
  fallbackLabel,
  providerId,
  providerName,
}: {
  modelGroups: readonly ModelSelectGroup[];
  normalizedValue: string;
  fallbackLabel: string;
  providerId: string | undefined;
  providerName?: string;
}): V4ModelTriggerDisplay {
  // 输入框展示与供应来源提示分别投影；不从拼接文案中裁剪名称，避免同名连接串选。
  const fullLabel = resolveV4ModelTriggerLabel({
    modelGroups,
    normalizedValue,
    fallbackLabel,
    providerId,
    providerName,
  });
  const selectedGroup = modelGroups.find((group) =>
    group.items.some((item) => item.value === normalizedValue),
  );
  const selectedItem = selectedGroup?.items.find((item) => item.value === normalizedValue);
  if (!selectedGroup || !selectedItem) {
    return { fullLabel, modelLabel: fallbackLabel };
  }

  const modelLabel = selectedItem.name;
  // 输入框仅展示模型名；供应商身份仍由菜单分组、提示和历史切换事实保留。
  return { fullLabel, modelLabel };
}
