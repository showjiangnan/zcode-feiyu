export const TEAMOROUTER_TEMPLATE_IDS = ["teamorouter-messages", "teamorouter-responses"] as const;

export function isTeamorouterEndpoint(baseUrl: string | null | undefined): boolean {
  if (!baseUrl) return false;
  try {
    const url = new URL(baseUrl);
    return (
      url.origin === "https://api.teamorouter.com" &&
      ["", "/v1"].includes(url.pathname.replace(/\/+$/u, "")) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export function isTeamorouterTemplate(templateId?: string | null): boolean {
  return TEAMOROUTER_TEMPLATE_IDS.some((id) => id === templateId);
}

export function supportsTeamorouterFast(
  apiType: string | null | undefined,
  baseUrl: string | null | undefined,
  modelId: string,
): boolean {
  return (
    apiType === "openai-responses" &&
    isTeamorouterEndpoint(baseUrl) &&
    filterTeamorouterModels([modelId], "openai-responses").length === 1
  );
}

export function filterTeamorouterModels(ids: readonly string[], apiType: string): string[] {
  return [
    ...new Set(
      ids.filter((id) =>
        apiType === "openai-responses"
          ? /^gpt-[a-z0-9][a-z0-9.-]*$/u.test(id) &&
            !/^gpt-image(?:-|$)/u.test(id) &&
            !/(?:[.-]fast)$/u.test(id)
          : apiType === "anthropic-messages" && /^claude-[a-z0-9][a-z0-9.-]*$/u.test(id),
      ),
    ),
  ];
}
