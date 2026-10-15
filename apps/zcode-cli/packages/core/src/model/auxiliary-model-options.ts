import type { Model, ModelOptions } from "@zcode/contracts";

const AUXILIARY_MAX_OUTPUT_TOKENS = 5_000;

/**
 * 辅助调用统一使用公开档位的最低项，并限制输出预算；档位顺序来自 Model Config，
 * 不能再按 disabled/off 等名字推断协议行为。
 */
export function auxiliaryModelOptions(model: Model): Required<ModelOptions> {
  return {
    // 标题/记忆等辅助工作不继承主任务额外速度消耗，始终使用标准档位。
    speed: "standard",
    reasoningLevel: model.optionSpecs.reasoningLevel.values[0]!,
    maxOutputTokens: Math.min(AUXILIARY_MAX_OUTPUT_TOKENS, model.optionSpecs.maxOutputTokens.max),
  };
}
