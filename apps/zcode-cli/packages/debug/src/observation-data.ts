// Modified by ZCode Feiyu.
import type {
  ContextSectionSource,
  ContextSnapshotView,
  NetworkRequestRecord,
  TraceSpan,
} from "./shared";
import { compareDateDesc, formatNetworkStatus, formatBytes } from "./observation-format.js";
import { type DebugView } from "./app-types.js";

export function groupSections(snapshot?: ContextSnapshotView) {
  const groups = new Map<ContextSectionSource, number>();
  for (const section of snapshot?.sections ?? []) {
    groups.set(section.source, (groups.get(section.source) ?? 0) + section.tokens);
  }
  const total = [...groups.values()].reduce((sum, value) => sum + value, 0);
  return [...groups.entries()].map(([source, tokens]) => ({
    source,
    tokens,
    percent: total > 0 ? tokens / total : 0,
  }));
}

export function mergeNetworkRequest(
  current: NetworkRequestRecord[],
  next: NetworkRequestRecord,
): NetworkRequestRecord[] {
  const byId = new Map(current.map((request) => [request.id, request]));
  byId.set(next.id, next);
  return [...byId.values()]
    .toSorted((left, right) => compareDateDesc(left.startedAt, right.startedAt))
    .slice(0, 200);
}

export function mergeNetworkSpans(
  spans: TraceSpan[],
  requests: NetworkRequestRecord[],
  traceId: string,
): TraceSpan[] {
  if (!traceId) return spans;
  const networkSpans = requests
    .filter((request) => request.traceId === traceId)
    .map(networkRequestToSpan);
  return [...spans, ...networkSpans];
}

export function networkRequestToSpan(request: NetworkRequestRecord): TraceSpan {
  return {
    id: `network:${request.id}`,
    traceId: request.traceId,
    sessionId: request.sessionId,
    turnId: request.turnId,
    spanId: request.spanId,
    lane: "network",
    label: `${request.method} ${request.host}`,
    source: "network",
    startAt: request.startedAt,
    endAt: request.completedAt,
    status: request.status === "pending" ? "running" : request.status === "error" ? "error" : "ok",
    summary: `${request.method} ${request.url}\n${formatNetworkStatus(request)} · ${formatBytes(
      request.requestBodyBytes,
    )} up · ${formatBytes(request.responseBodyBytes)} down`,
    payload: request,
  };
}

export function filterNetworkRequests(
  requests: NetworkRequestRecord[],
  filter: string,
): NetworkRequestRecord[] {
  const normalized = filter.trim().toLowerCase();
  if (!normalized) return requests;
  return requests.filter((request) =>
    [
      request.traceId,
      request.sessionId,
      request.turnId,
      request.spanId,
      request.method,
      request.host,
      request.path,
      request.url,
      request.status,
      request.statusCode ? String(request.statusCode) : "",
    ]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(normalized)),
  );
}

export function networkRequestFromPayload(payload: unknown): NetworkRequestRecord | null {
  if (!isPlainObject(payload)) return null;
  if (typeof payload.id !== "string") return null;
  if (typeof payload.startedAt !== "string") return null;
  if (typeof payload.method !== "string") return null;
  if (typeof payload.url !== "string") return null;
  if (typeof payload.status !== "string") return null;
  return payload as unknown as NetworkRequestRecord;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function viewFromHash(hash: string): DebugView {
  const normalized = hash.replace(/^#/, "");
  if (normalized === "gantt" || normalized === "network") return normalized;
  return "gantt";
}
