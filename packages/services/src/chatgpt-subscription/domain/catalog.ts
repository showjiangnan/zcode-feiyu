// Modified by ZCode Feiyu.
import { ChatGPTSubscriptionError } from "./errors.js";
import type { ChatGPTSubscriptionModel } from "../contract.js";
import { resolveSubscriptionContextPlan } from "./contextPlan.js";

export function parseSubscriptionCatalog(value: unknown): ChatGPTSubscriptionModel[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { models?: unknown }).models))
    throw new ChatGPTSubscriptionError("catalog_invalid");
  const rows = (value as { models: unknown[] }).models;
  if (rows.length > 10000) throw new ChatGPTSubscriptionError("catalog_invalid");
  const seen = new Set<string>();
  const result: ChatGPTSubscriptionModel[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") throw new ChatGPTSubscriptionError("catalog_invalid");
    const entry = row as Record<string, unknown>;
    if (entry.visibility !== "list") continue;
    if (
      typeof entry.slug !== "string" ||
      !entry.slug ||
      typeof entry.display_name !== "string" ||
      !entry.display_name ||
      seen.has(entry.slug)
    )
      throw new ChatGPTSubscriptionError("catalog_invalid");
    seen.add(entry.slug);
    // 当前官方目录仅承诺 slug/display_name/visibility；额外能力不凭字段名称猜测合同。
    result.push({
      slug: entry.slug,
      displayName: entry.display_name,
      ...resolveSubscriptionContextPlan(entry.slug),
    });
  }
  return result;
}
