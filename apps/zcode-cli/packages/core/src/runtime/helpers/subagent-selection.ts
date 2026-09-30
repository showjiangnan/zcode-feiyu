// Modified by ZCode Feiyu contributors (2026).
import { parseModelSelectionValue, SESSION_ENTRY_MODEL_SELECTION } from "@zcode/contracts";
import type { SessionStorePort } from "@zcode/contracts";
import { createCoreError, CoreErrorType, type ModelSelection } from "../deps.js";
import { cloneModelSelection } from "../model-selection.js";
import type { EffectiveModelSelectionResult } from "@zcode/shared/model-selection";

const SUBAGENT_SELECTION_MESSAGES = {
  "selection-missing": "No model selected / 未选择模型",
  "account-connection-unavailable": "Account connection unavailable / 当前账号连接不可用",
  "provider-not-found": "Provider unavailable / 供应商不存在或不可用",
  "model-not-found": "Model unavailable / 模型不存在或不可用",
  "reasoning-level-missing": "No reasoning level selected / 未选择思考档位",
  "reasoning-level-not-supported": "Reasoning level unsupported / 不支持所选思考档位",
} satisfies Record<NonNullable<EffectiveModelSelectionResult["selectionIssue"]>, string>;

/** 显式 profile 是待解析意图；继承与内部 override 已有执行归属，不重新对应账号。 */
export function resolveSubagentSelection(input: {
  profileSelection?: ModelSelection | null;
  parentSelection?: ModelSelection | null;
  overrideSelection?: ModelSelection;
  resolveSelection?: (selection: ModelSelection) => EffectiveModelSelectionResult;
}): { hasConcreteModel: boolean; selection: ModelSelection } {
  const explicit = input.profileSelection;
  const result: EffectiveModelSelectionResult = input.overrideSelection
    ? { effectiveSelection: input.overrideSelection }
    : explicit
      ? input.resolveSelection
        ? input.resolveSelection(cloneModelSelection(explicit))
        : { effectiveSelection: explicit }
      : { effectiveSelection: input.parentSelection ?? null };
  if (!result.effectiveSelection || result.selectionIssue) {
    const reason = result.selectionIssue ?? "selection-missing";
    const requested = input.overrideSelection ?? explicit ?? input.parentSelection;
    const identity = requested ? `; selection=${requested.providerId}/${requested.modelId}` : "";
    // 解析失败不能落回父模型，否则会悄悄改变用户显式指定的子任务模型。
    // 公共错误投影不读取结构化字段（只有 selectionIssue 时消费方看不到）；后台也只保留 message。
    // 因此同时给既有 reason 和消息补上原因，两个消费路径都能定位，不增加专用错误协议。
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      `Cannot start subagent: ${SUBAGENT_SELECTION_MESSAGES[reason]} [reason=${reason}${identity}]`,
      {
        recoverable: true,
        context: {
          selectionIssue: reason,
          reason,
          ...(result.effectiveSelection
            ? {
                providerId: result.effectiveSelection.providerId,
                modelId: result.effectiveSelection.modelId,
              }
            : {}),
        },
      },
    );
  }
  return {
    hasConcreteModel: explicit != null,
    selection: cloneModelSelection(result.effectiveSelection),
  };
}

/**
 * 续跑已有 child 会话时，读取它自己已持久化的模型选择。
 *
 * 修复原因：续跑同一个 teammate 时，子模型取自父 runtime **当前**选择；父在两次运行之间切换模型后，
 * 同一个 child 会悄悄换模型，而它持久化的选择仍是旧值，二者不一致（复审 DEF-16）。
 * 依据：round-team 约定 child 的模型/权限由原 child session 的既有快照恢复。
 * 显式覆盖或 profile 固定的模型始终优先，因此只在二者都未指定时读取；持久化选择缺失、损坏或已不可用时
 * 返回 undefined，由调用方回落到父当前选择，不让恢复因此失败。
 */
export async function resolveResumedChildSelection(input: {
  store: Pick<SessionStorePort, "sessionEntries"> | undefined;
  childSessionId: string;
  hasExplicitModel: boolean;
  validate?: (selection: ModelSelection) => EffectiveModelSelectionResult;
}): Promise<ModelSelection | undefined> {
  if (input.hasExplicitModel || !input.store?.sessionEntries) return undefined;
  const entries = await input.store.sessionEntries({
    sessionID: input.childSessionId as never,
    type: SESSION_ENTRY_MODEL_SELECTION,
  });
  const persisted = parseModelSelectionValue(entries.at(-1)?.data);
  if (!persisted) return undefined;
  if (!input.validate) return cloneModelSelection(persisted);
  const resolved = input.validate(cloneModelSelection(persisted));
  return resolved.selectionIssue || !resolved.effectiveSelection ? undefined : persisted;
}
