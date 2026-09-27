/** 资源指标聚合（纯函数，便于单测） */

export interface AggregateStats {
  mean: number;
  peak: number;
  p95: number;
  sample_count: number;
}

export function roundMetric(value: number, fractionDigits = 2): number {
  const factor = 10 ** fractionDigits;
  return Math.round(value * factor) / factor;
}

export function computeAggregateStats(values: readonly number[]): AggregateStats {
  if (values.length === 0) {
    return { mean: 0, peak: 0, p95: 0, sample_count: 0 };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  const mean = sum / sorted.length;
  const peak = sorted[sorted.length - 1] ?? 0;
  const p95Index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  const p95 = sorted[p95Index] ?? peak;

  return {
    mean: roundMetric(mean),
    peak: roundMetric(peak),
    p95: roundMetric(p95),
    sample_count: sorted.length,
  };
}

export function appendBoundedSamples(
  bucket: number[],
  value: number,
  maxSamples: number,
): number[] {
  const next = [...bucket, value];
  if (next.length <= maxSamples) {
    return next;
  }
  return next.slice(next.length - maxSamples);
}
