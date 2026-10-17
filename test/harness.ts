import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';

export interface HistogramPoint {
  name: string;
  count: number;
  sum: number;
  boundaries: number[];
  attrs: Record<string, string | number | boolean>;
}

export function telemetry() {
  const spans = new InMemorySpanExporter();
  const tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(spans)],
  });
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 60_000,
  });
  const meterProvider = new MeterProvider({ readers: [reader] });
  const logExporter = new InMemoryLogRecordExporter();
  const loggerProvider = new LoggerProvider({
    processors: [new SimpleLogRecordProcessor({ exporter: logExporter })],
  });

  return {
    spans,
    metricExporter,
    logExporter,
    tracerProvider,
    meterProvider,
    loggerProvider,
    async flush(): Promise<void> {
      await reader.forceFlush();
    },
    async shutdown(): Promise<void> {
      await reader.forceFlush().catch(() => {});
      await meterProvider.shutdown().catch(() => {});
      await tracerProvider.shutdown().catch(() => {});
      await loggerProvider.shutdown().catch(() => {});
    },
  };
}

export function histograms(resourceMetrics: unknown): HistogramPoint[] {
  const out: HistogramPoint[] = [];
  const roots = Array.isArray(resourceMetrics) ? resourceMetrics : [];
  for (const root of roots) {
    const scopes = asArray((root as { scopeMetrics?: unknown }).scopeMetrics);
    for (const scope of scopes) {
      const metrics = asArray((scope as { metrics?: unknown }).metrics);
      for (const metric of metrics) {
        const name = (metric as { descriptor?: { name?: string } }).descriptor?.name;
        if (!name) continue;
        const points = asArray((metric as { dataPoints?: unknown }).dataPoints);
        for (const point of points) {
          const stats = pointStats(point);
          const record = point as { attributes?: Record<string, string | number | boolean> };
          out.push({
            name,
            count: stats.count,
            sum: stats.sum,
            boundaries: stats.boundaries,
            attrs: { ...(record.attributes ?? {}) },
          });
        }
      }
    }
  }
  return out;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function pointStats(point: unknown): { count: number; sum: number; boundaries: number[] } {
  if (!point || typeof point !== 'object') return { count: 0, sum: 0, boundaries: [] };
  const record = point as Record<string, unknown>;
  const value = record.value;
  const source = value && typeof value === 'object' ? (value as Record<string, unknown>) : record;
  const buckets = source.buckets;
  const boundaries =
    buckets && typeof buckets === 'object' && Array.isArray((buckets as { boundaries?: unknown }).boundaries)
      ? ((buckets as { boundaries: number[] }).boundaries)
      : [];
  return {
    count: typeof source.count === 'number' ? source.count : 0,
    sum: typeof source.sum === 'number' ? source.sum : 0,
    boundaries,
  };
}

export function spanText(span: { name?: string; attributes?: unknown; events?: unknown; status?: unknown }): string {
  return JSON.stringify({
    name: span.name,
    attributes: span.attributes,
    events: span.events?.map((event) => ({
      name: (event as { name?: string }).name,
      attributes: (event as { attributes?: unknown }).attributes,
    })),
    status: span.status,
  });
}
