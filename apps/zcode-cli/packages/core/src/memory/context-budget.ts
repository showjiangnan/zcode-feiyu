// Modified by ZCode Feiyu contributors (2026).
import { estimateTokens } from "../context/utils.js";

const DEFAULT_MEMORY_TOKEN_BUDGET = 4_096;
const MIN_MEMORY_TOKEN_BUDGET = 256;
const MEMORY_CONTEXT_WINDOW_SHARE = 0.05;

export function budgetProjectMemoryContext(input: {
  contextWindow?: number;
  indexContent?: string;
  relevantContent?: string;
}): { indexContent?: string; relevantContent?: string; tokenBudget: number } {
  const windowBudget = input.contextWindow
    ? Math.floor(input.contextWindow * MEMORY_CONTEXT_WINDOW_SHARE)
    : DEFAULT_MEMORY_TOKEN_BUDGET;
  const tokenBudget = Math.max(
    MIN_MEMORY_TOKEN_BUDGET,
    Math.min(DEFAULT_MEMORY_TOKEN_BUDGET, windowBudget),
  );
  const indexBudget = input.relevantContent ? Math.floor(tokenBudget * 0.55) : tokenBudget;
  const indexContent = trimToEstimatedTokens(input.indexContent, indexBudget);
  const remaining = tokenBudget - estimateTokens(indexContent ?? "");
  const relevantContent = trimToEstimatedTokens(input.relevantContent, remaining);
  return { indexContent, relevantContent, tokenBudget };
}

function trimToEstimatedTokens(
  content: string | undefined,
  tokenBudget: number,
): string | undefined {
  if (!content || tokenBudget <= 0) return undefined;
  if (estimateTokens(content) <= tokenBudget) return content;
  let low = 0;
  let high = content.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateTokens(content.slice(0, middle)) <= tokenBudget) low = middle;
    else high = middle - 1;
  }
  return content.slice(0, low).trimEnd();
}
