import type { LoggerProvider } from '@opentelemetry/api-logs';
import type { MeterProvider, TracerProvider } from '@opentelemetry/api';

export interface RecordedEvent {
  name: string;
  attributes: Record<string, string | number | boolean>;
}

export interface RecordedSpan {
  name: string;
  attributes: Record<string, string | number | boolean>;
  events: RecordedEvent[];
  ended: boolean;
  traceId: string;
  spanId: string;
}

export interface RecordedLog {
  eventName: string | undefined;
  attributes: Record<string, unknown>;
}

export interface RecordedMetric {
  name: string;
  value: number;
}

const spans: RecordedSpan[] = [];
const logs: RecordedLog[] = [];
const metrics: RecordedMetric[] = [];

function hex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function copyAttrs(attributes: unknown): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!attributes || typeof attributes !== 'object') return out;
  for (const [key, value] of Object.entries(attributes as Record<string, unknown>)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out[key] = value;
  }
  return out;
}

const tracer = {
  startSpan(name: string, options?: { attributes?: unknown }) {
    const span: RecordedSpan = {
      name,
      attributes: copyAttrs(options?.attributes),
      events: [],
      ended: false,
      traceId: hex(16),
      spanId: hex(8),
    };
    spans.push(span);
    return {
      spanContext: () => ({ traceId: span.traceId, spanId: span.spanId, traceFlags: 1 }),
      setAttribute: (key: string, value: string | number | boolean) => {
        span.attributes[key] = value;
      },
      addEvent: (eventName: string, attributes?: unknown) => {
        span.events.push({ name: eventName, attributes: copyAttrs(attributes) });
      },
      setStatus: () => {},
      end: () => {
        span.ended = true;
      },
      isRecording: () => !span.ended,
      recordException: () => {},
    };
  },
};

const meter = {
  createHistogram(name: string) {
    return {
      record(value: number) {
        metrics.push({ name, value });
      },
    };
  },
};

const logger = {
  emit(record: { eventName?: string; attributes?: Record<string, unknown> }) {
    logs.push({
      eventName: record.eventName,
      attributes: { ...(record.attributes ?? {}) },
    });
  },
};

export function browserProviders(): {
  tracerProvider: TracerProvider;
  meterProvider: MeterProvider;
  loggerProvider: LoggerProvider;
} {
  return {
    tracerProvider: { getTracer: () => tracer } as unknown as TracerProvider,
    meterProvider: { getMeter: () => meter } as unknown as MeterProvider,
    loggerProvider: { getLogger: () => logger } as unknown as LoggerProvider,
  };
}

export function recordedSpans(): RecordedSpan[] {
  return spans;
}

export function recordedLogs(): RecordedLog[] {
  return logs;
}

export function recordedMetrics(): RecordedMetric[] {
  return metrics;
}
