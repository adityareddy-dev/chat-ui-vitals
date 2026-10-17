import {
  context,
  metrics,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Histogram,
  type Meter,
  type Span,
  type SpanContext,
} from '@opentelemetry/api';
import { logs, SeverityNumber, type Logger } from '@opentelemetry/api-logs';
import { ATTR, BLAME_PREFIX, BUCKETS, EVALUATION_NAME, EVENT, METRIC, RESPONSE_HEADER, SPAN_NAME } from './names.js';
import type {
  BlameAttributes,
  ChatVitals,
  ChatVitalsOptions,
  FrameSample,
  PaintTarget,
  UserAction,
  Vote,
} from './types.js';

const SCOPE = 'chat-ui-vitals';
const VERSION = '0.0.0';

type TurnReason = 'complete' | UserAction | 'error';

interface Turn {
  span: Span;
  start: number;
  controller: AbortController;
  reader?: ReadableStreamDefaultReader<Uint8Array>;
  chunks: number;
  lastChunkAt: number;
  responseId?: string;
  ended: boolean;
  painted: boolean;
  reason?: TurnReason;
  cleanups: Array<() => void>;
}

/**
 * Browser timings stay on `gen_ai.ui.*`.
 * They are not written into `gen_ai.client.inference.*` or `gen_ai.response.time_to_first_chunk`.
 */
export function createChatVitals(options: ChatVitalsOptions = {}): ChatVitals {
  return new ChatVitalsImpl(options);
}

class ChatVitalsImpl implements ChatVitals {
  readonly fetch: typeof globalThis.fetch;

  private readonly now: () => number;
  private readonly baseFetch: typeof globalThis.fetch;
  private readonly sessionId: string | undefined;
  private readonly conversationId: string | undefined;
  private readonly requestModel: string | undefined;
  private readonly providerName: string | undefined;
  private readonly blame: ChatVitalsOptions['blame'];
  private readonly metricAttrs: Attributes;
  private readonly tracer: ReturnType<ReturnType<typeof trace.getTracerProvider>['getTracer']>;
  private readonly logger: Logger;
  private readonly firstChunk: Histogram;
  private readonly firstPaint: Histogram;
  private readonly streamDuration: Histogram;
  private readonly perChunk: Histogram;

  private open: Turn | undefined;
  private recent: Turn | undefined;
  private lastId: string | undefined;
  private pendingPrevious: string | undefined;
  private unsub: (() => void) | undefined;

  constructor(options: ChatVitalsOptions) {
    this.now = options.now ?? defaultNow;
    const boundFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.baseFetch = boundFetch;
    this.sessionId = blankToUndefined(options.sessionId);
    this.conversationId = blankToUndefined(options.conversationId);
    this.requestModel = blankToUndefined(options.requestModel);
    this.providerName = blankToUndefined(options.providerName);
    this.blame = options.blame;

    const metricAttrs: Attributes = {};
    if (this.providerName) metricAttrs[ATTR.providerName] = this.providerName;
    if (this.requestModel) metricAttrs[ATTR.requestModel] = this.requestModel;
    this.metricAttrs = metricAttrs;

    const tracerProvider = options.tracerProvider ?? trace.getTracerProvider();
    const meterProvider = options.meterProvider ?? metrics.getMeterProvider();
    const loggerProvider = options.loggerProvider ?? logs.getLoggerProvider();
    this.tracer = tracerProvider.getTracer(SCOPE, VERSION);
    const meter = meterProvider.getMeter(SCOPE, VERSION);
    this.logger = loggerProvider.getLogger(SCOPE, VERSION);
    this.firstChunk = histogram(meter, METRIC.firstChunk, 'Time to the first received chat chunk');
    this.firstPaint = histogram(meter, METRIC.firstPaint, 'Time to the first painted assistant token');
    this.streamDuration = histogram(meter, METRIC.streamDuration, 'Received chat stream duration');
    this.perChunk = histogram(meter, METRIC.perChunk, 'Time between received chat chunks');

    const observe = options.observeFrames ?? defaultObserveFrames;
    this.unsub = observe((sample) => this.onFrame(sample));
    this.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => this.onFetch(input, init)) as typeof globalThis.fetch;
  }

  stop(): void {
    if (this.open) this.finish(this.open, 'stop');
  }

  regenerate(): void {
    const id = this.open?.responseId ?? this.lastId;
    if (id) this.pendingPrevious = id;
    if (this.open) this.finish(this.open, 'regenerate');
  }

  abandon(): void {
    if (this.open) this.finish(this.open, 'abandon');
  }

  markFirstPaintedToken(): void {
    const turn = this.open ?? this.recent;
    if (!turn || turn.painted) return;
    const seconds = (this.now() - turn.start) / 1000;
    if (seconds < 0) return;
    turn.painted = true;
    this.firstPaint.record(seconds, this.metricAttrs);
    if (turn.span.isRecording()) turn.span.setAttribute(ATTR.firstPaint, seconds);
  }

  observePaintedToken(target: PaintTarget): () => void {
    const check = (): boolean => {
      if ((target.textContent ?? '').trim().length === 0) return false;
      this.markFirstPaintedToken();
      return true;
    };
    if (check()) return () => {};
    if (target.observe) {
      let stop: (() => void) | undefined;
      stop = target.observe(() => {
        if (check()) stop?.();
      });
      if (check()) stop();
      return () => {
        stop?.();
      };
    }
    if (typeof MutationObserver === 'undefined' || target.nodeType !== 1) return () => {};
    try {
      const observer = new MutationObserver(() => {
        if (check()) observer.disconnect();
      });
      observer.observe(target as unknown as Node, {
        childList: true,
        characterData: true,
        subtree: true,
      });
      return () => observer.disconnect();
    } catch {
      return () => {};
    }
  }

  feedback(vote: Vote, responseId: string): boolean {
    const id = responseId.trim();
    if (id.length === 0) return false;
    const span = this.spanFor(id);
    const parent = span ? trace.setSpan(ROOT_CONTEXT, span) : ROOT_CONTEXT;
    this.logger.emit({
      eventName: EVENT.evaluation,
      severityNumber: SeverityNumber.INFO,
      severityText: 'INFO',
      context: parent,
      attributes: {
        [ATTR.evaluationName]: EVALUATION_NAME,
        [ATTR.evaluationScore]: vote === 'up' ? 1 : 0,
        [ATTR.evaluationLabel]: vote,
        [ATTR.evaluatorType]: 'human',
        [ATTR.responseId]: id,
      },
    });
    return true;
  }

  lastResponseId(): string | undefined {
    return this.lastId;
  }

  dispose(): void {
    this.abandon();
    const unsub = this.unsub;
    this.unsub = undefined;
    try {
      unsub?.();
    } catch {
      // The host listener is already gone.
    }
  }

  private spanFor(responseId: string): Span | undefined {
    if (this.open?.responseId === responseId) return this.open.span;
    if (this.recent?.responseId === responseId) return this.recent.span;
    return undefined;
  }

  private async onFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const turn = this.startTurn(input, init);
    if (turn.ended) throw new DOMException('The operation was aborted.', 'AbortError');
    const headers = incomingHeaders(input, init);
    this.applyTraceHeaders(turn, headers);
    try {
      const response = await this.baseFetch(input, {
        ...init,
        headers,
        signal: turn.controller.signal,
      });
      if (turn.ended) return response;
      const responseId = response.headers.get(RESPONSE_HEADER)?.trim();
      if (responseId) {
        turn.responseId = responseId;
        this.lastId = responseId;
        turn.span.setAttribute(ATTR.responseId, responseId);
      }
      if (response.status >= 400) {
        this.finish(turn, 'error', String(response.status));
        return response;
      }
      const body = response.body;
      if (!body) {
        this.finish(turn, 'complete');
        return response;
      }
      return this.wrap(turn, response, body);
    } catch (err) {
      if (!turn.ended) {
        if (isAbort(err)) this.finish(turn, 'abandon');
        else this.finish(turn, 'error', errorTypeOf(err));
      }
      throw err;
    }
  }

  private startTurn(input: RequestInfo | URL, init: RequestInit | undefined): Turn {
    if (this.open) this.abandon();
    const method = methodOf(input, init);
    const attributes: Attributes = {
      ...endpointAttributes(input, method),
      [ATTR.requestStream]: true,
    };
    if (this.sessionId) attributes[ATTR.sessionId] = this.sessionId;
    if (this.conversationId) attributes[ATTR.conversationId] = this.conversationId;
    if (this.requestModel) attributes[ATTR.requestModel] = this.requestModel;
    if (this.providerName) attributes[ATTR.providerName] = this.providerName;
    const previous = this.pendingPrevious;
    this.pendingPrevious = undefined;
    if (previous) attributes[ATTR.previousResponseId] = previous;

    const span = this.tracer.startSpan(SPAN_NAME, { kind: SpanKind.CLIENT, attributes }, context.active());
    const start = this.now();
    const turn: Turn = {
      span,
      start,
      controller: new AbortController(),
      chunks: 0,
      lastChunkAt: start,
      ended: false,
      painted: false,
      cleanups: [],
    };
    this.open = turn;
    this.attachParents(turn, input, init);
    return turn;
  }

  private attachParents(turn: Turn, input: RequestInfo | URL, init: RequestInit | undefined): void {
    for (const signal of parentSignals(input, init)) {
      const onAbort = () => {
        if (!turn.ended) this.finish(turn, 'abandon');
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort);
      turn.cleanups.push(() => signal.removeEventListener('abort', onAbort));
    }
  }

  private applyTraceHeaders(turn: Turn, headers: Headers): void {
    const originalBaggage = headers.get('baggage');
    const carrier: Record<string, string> = {};
    // Inject first, then overwrite traceparent. A no-op global propagator would otherwise leave it unset.
    propagation.inject(trace.setSpan(context.active(), turn.span), carrier);
    for (const [key, value] of Object.entries(carrier)) headers.set(key, value);
    headers.set('traceparent', formatTraceParent(turn.span.spanContext()));
    if (this.sessionId) {
      headers.set('baggage', mergeBaggage(originalBaggage, this.sessionId));
    } else if (originalBaggage !== null) {
      headers.set('baggage', originalBaggage);
    }
  }

  private wrap(turn: Turn, response: Response, body: ReadableStream<Uint8Array>): Response {
    const reader = body.getReader();
    turn.reader = reader;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        void this.drain(turn, reader, controller);
      },
      cancel: () => {
        if (!turn.ended) this.finish(turn, 'abandon');
        return reader.cancel();
      },
    });
    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  private async drain(
    turn: Turn,
    reader: ReadableStreamDefaultReader<Uint8Array>,
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): Promise<void> {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (turn.ended && turn.reason !== 'complete') {
          closeQuietly(controller, turn.reason ?? 'abandon');
          return;
        }
        if (done) {
          this.finish(turn, 'complete');
          closeQuietly(controller, 'complete');
          return;
        }
        this.noteChunk(turn, value.byteLength);
        try {
          controller.enqueue(value);
        } catch {
          if (!turn.ended) this.finish(turn, 'abandon');
          return;
        }
      }
    } catch (err) {
      if (!turn.ended) {
        if (isAbort(err)) this.finish(turn, 'abandon');
        else this.finish(turn, 'error', errorTypeOf(err));
      }
      closeQuietly(controller, turn.reason ?? 'error', err);
    }
  }

  private noteChunk(turn: Turn, bytes: number): void {
    if (turn.ended || bytes <= 0) return;
    const at = this.now();
    if (turn.chunks === 0) {
      const seconds = (at - turn.start) / 1000;
      if (seconds >= 0) {
        this.firstChunk.record(seconds, this.metricAttrs);
        if (turn.span.isRecording()) turn.span.setAttribute(ATTR.firstChunk, seconds);
      }
    } else {
      const delta = (at - turn.lastChunkAt) / 1000;
      if (delta >= 0) this.perChunk.record(delta, this.metricAttrs);
    }
    turn.chunks += 1;
    turn.lastChunkAt = at;
  }

  private finish(turn: Turn, reason: TurnReason, errorType?: string): void {
    if (turn.ended) return;
    turn.ended = true;
    turn.reason = reason;
    const elapsed = (this.now() - turn.start) / 1000;
    if (elapsed >= 0) this.streamDuration.record(elapsed, this.metricAttrs);
    if (turn.span.isRecording()) {
      turn.span.setAttribute(ATTR.chunkCount, turn.chunks);
      if (reason === 'stop' || reason === 'regenerate' || reason === 'abandon') {
        turn.span.addEvent(EVENT.userAction, { [ATTR.userAction]: reason });
        turn.span.setStatus({ code: SpanStatusCode.OK });
      } else if (reason === 'error') {
        turn.span.setAttribute(ATTR.errorType, errorType && errorType.length > 0 ? errorType : '_OTHER');
        turn.span.setStatus({ code: SpanStatusCode.ERROR });
      } else {
        turn.span.setStatus({ code: SpanStatusCode.OK });
      }
      turn.span.end();
    }
    this.recent = turn;
    if (this.open === turn) this.open = undefined;
    for (const cleanup of turn.cleanups) cleanup();
    turn.cleanups = [];
    if (reason === 'stop' || reason === 'regenerate' || reason === 'abandon') {
      if (!turn.controller.signal.aborted) turn.controller.abort();
      const reader = turn.reader;
      turn.reader = undefined;
      if (reader) void reader.cancel().catch(() => {});
    }
  }

  private onFrame(sample: FrameSample): void {
    const turn = this.open;
    if (!turn || !turn.span.isRecording()) return;
    const attributes: Attributes = {};
    if (sample.kind === 'long-animation-frame') {
      if (Number.isFinite(sample.value)) attributes[ATTR.loafDuration] = sample.value;
    } else if (sample.kind === 'inp') {
      attributes[ATTR.vitalName] = 'inp';
      if (Number.isFinite(sample.value)) attributes[ATTR.vitalValue] = sample.value;
    }
    for (const [key, value] of Object.entries(this.readBlame(sample))) {
      if (!key.startsWith(BLAME_PREFIX)) continue;
      if (typeof value === 'string') attributes[key] = value;
      else if (typeof value === 'number' && Number.isFinite(value)) attributes[key] = value;
    }
    const name = sample.kind === 'long-animation-frame' ? EVENT.loaf : sample.kind === 'inp' ? EVENT.inp : EVENT.event;
    turn.span.addEvent(name, attributes);
  }

  private readBlame(sample: FrameSample): BlameAttributes {
    if (!this.blame) return {};
    try {
      return this.blame(sample) ?? {};
    } catch {
      return {};
    }
  }
}

function histogram(meter: Meter, name: string, description: string): Histogram {
  return meter.createHistogram(name, {
    description,
    unit: 's',
    advice: { explicitBucketBoundaries: [...BUCKETS] },
  });
}

function defaultNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now();
  return Date.now();
}

function defaultObserveFrames(onSample: (sample: FrameSample) => void): () => void {
  if (typeof PerformanceObserver === 'undefined') return () => {};
  let types: string[] = [];
  try {
    const supported = PerformanceObserver.supportedEntryTypes ?? [];
    types = ['long-animation-frame', 'event'].filter((type) => supported.includes(type));
  } catch {
    return () => {};
  }
  if (types.length === 0) return () => {};
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.entryType === 'long-animation-frame') {
          onSample({ kind: 'long-animation-frame', value: entry.duration, startTime: entry.startTime });
          continue;
        }
        if (entry.entryType !== 'event') continue;
        const interactionId = (entry as PerformanceEntry & { interactionId?: number }).interactionId;
        if (typeof interactionId !== 'number' || interactionId === 0) continue;
        onSample({ kind: 'event', value: entry.duration, startTime: entry.startTime });
      }
    });
    observer.observe({ entryTypes: types });
    return () => observer.disconnect();
  } catch {
    return () => {};
  }
}

function blankToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function incomingHeaders(input: RequestInfo | URL, init?: RequestInit): Headers {
  const headers = new Headers();
  if (typeof Request !== 'undefined' && input instanceof Request) {
    input.headers.forEach((value, key) => headers.set(key, value));
  }
  if (init?.headers) new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  return headers;
}

function parentSignals(input: RequestInfo | URL, init?: RequestInit): AbortSignal[] {
  const signals: AbortSignal[] = [];
  if (init?.signal) signals.push(init.signal);
  if (typeof Request !== 'undefined' && input instanceof Request) signals.push(input.signal);
  return signals;
}

function methodOf(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method && init.method.length > 0) return init.method.toUpperCase();
  if (typeof Request !== 'undefined' && input instanceof Request) return input.method.toUpperCase();
  return 'GET';
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof URL !== 'undefined' && input instanceof URL) return input.href;
  if (typeof Request !== 'undefined' && input instanceof Request) return input.url;
  return String(input);
}

function endpointAttributes(input: RequestInfo | URL, method: string): Attributes {
  const attributes: Attributes = { [ATTR.httpMethod]: method };
  let url: URL;
  try {
    url = new URL(requestUrl(input));
  } catch {
    return attributes;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return attributes;
  url.username = '';
  url.password = '';
  url.hash = '';
  attributes[ATTR.urlFull] = url.toString();
  attributes[ATTR.serverAddress] = url.hostname;
  const port = url.port.length > 0 ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (Number.isFinite(port)) attributes[ATTR.serverPort] = port;
  return attributes;
}

function formatTraceParent(spanContext: SpanContext): string {
  const sampled = (spanContext.traceFlags & 1) === 1;
  return `00-${spanContext.traceId}-${spanContext.spanId}-${sampled ? '01' : '00'}`;
}

function mergeBaggage(existing: string | null, sessionId: string): string {
  const parts = existing
    ? existing
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
    : [];
  const hasSession = parts.some((part) => part.startsWith('session.id='));
  if (!hasSession) parts.push(`session.id=${encodeURIComponent(sessionId)}`);
  return parts.join(',');
}

function isAbort(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'name' in err && (err as { name?: unknown }).name === 'AbortError';
}

function errorTypeOf(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'name' in err) {
    const name = (err as { name?: unknown }).name;
    if (typeof name === 'string' && name.length > 0) return name;
  }
  return '_OTHER';
}

function closeQuietly(
  controller: ReadableStreamDefaultController<Uint8Array>,
  reason: TurnReason,
  err?: unknown,
): void {
  try {
    if (reason === 'complete') controller.close();
    else if (reason === 'error') controller.error(err instanceof Error ? err : new Error('chat stream failed'));
    else controller.error(new DOMException('The operation was aborted.', 'AbortError'));
  } catch {
    // The consumer already closed this side.
  }
}
