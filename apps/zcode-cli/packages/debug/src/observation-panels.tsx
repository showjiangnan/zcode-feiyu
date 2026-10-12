// Modified by ZCode Feiyu.
import { AlertTriangle, BarChart3, Clock3 } from "lucide-react";
import type { CacheReport, TimelineItem, TraceDetailResponse } from "./shared";
import { PanelTitle, EmptyLine, MetaLine, Metric } from "./panel-elements.js";
import {
  formatTime,
  stringifyPayload,
  formatCacheStatus,
  formatSegmentLabel,
} from "./observation-format.js";

export function TimelinePanel({ items }: { items: TimelineItem[] }) {
  return (
    <section className="panel timeline-panel">
      <PanelTitle icon={<Clock3 size={17} />} title="时间线" />
      <div className="timeline">
        {items.length === 0 ? <EmptyLine text="选择 Trace 后查看事件" /> : null}
        {items.map((item) => (
          <article className={`timeline-item severity-${item.severity ?? "info"}`} key={item.id}>
            <time>{formatTime(item.at)}</time>
            <div>
              <div className="timeline-heading">
                <strong>{item.label}</strong>
                <span>{item.source}</span>
              </div>
              <p className="timeline-summary">{item.summary}</p>
              {item.payload !== undefined ? <TimelinePayload payload={item.payload} /> : null}
              <MetaLine
                values={[
                  item.sessionId ? `会话 ${item.sessionId}` : "",
                  item.turnId ? `轮次 ${item.turnId}` : "",
                  item.toolCallId ? `工具 ${item.toolCallId}` : "",
                ]}
              />
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

export function TimelinePayload({ payload }: { payload: unknown }) {
  return (
    <details className="timeline-payload">
      <summary>原始 Payload</summary>
      <pre>{stringifyPayload(payload)}</pre>
    </details>
  );
}

export function CachePanel({ reports }: { reports: CacheReport[] }) {
  const report = reports.at(-1);
  const segments = report?.segments.filter(isRenderableCacheSegment) ?? [];

  return (
    <section className="panel cache-panel">
      <PanelTitle icon={<BarChart3 size={17} />} title="缓存" />
      {!report ? <EmptyLine text="未观察到缓存使用" /> : null}
      {report ? (
        <>
          <div className="metric-row">
            <Metric label="读取" value={report.cacheReadTokens.toLocaleString()} />
            <Metric label="写入" value={report.cacheWriteTokens.toLocaleString()} />
            <Metric
              label="命中"
              value={report.hitRate === null ? "未知" : `${Math.round(report.hitRate * 100)}%`}
            />
          </div>
          {segments.length > 0 ? (
            <div className="cache-segments">
              {segments.map((segment) => (
                <article className={`cache-segment ${segment.status}`} key={segment.id}>
                  <strong>{formatCacheStatus(segment.status)}</strong>
                  <span>{formatSegmentLabel(segment.role ?? segment.source)}</span>
                  <p>{segment.preview}</p>
                  {segment.reason ? <small>{segment.reason}</small> : null}
                </article>
              ))}
            </div>
          ) : null}
          {report.limitations.map((limitation) => (
            <p className="soft-warning" key={limitation}>
              {limitation}
            </p>
          ))}
        </>
      ) : null}
    </section>
  );
}

export function isRenderableCacheSegment(segment: CacheReport["segments"][number]): boolean {
  return segment.preview !== "SQLite 的 step-finish token usage 不包含 provider 可见文本。";
}

export function GapsPanel({ requests }: { requests: TraceDetailResponse["developerRequests"] }) {
  return (
    <section className="panel gaps-panel">
      <PanelTitle icon={<AlertTriangle size={17} />} title="观测缺口" />
      {requests.length === 0 ? <EmptyLine text="当前 trace 没有观测缺口" /> : null}
      {requests.map((request) => (
        <article className="request-row" key={request.eventName}>
          <strong>{request.title}</strong>
          <p>{request.reason}</p>
          <code>{request.eventName}</code>
        </article>
      ))}
    </section>
  );
}
