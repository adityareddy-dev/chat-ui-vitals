import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { ATTR, BUCKETS, EVENT, SPAN_NAME } from '../src/names.js';
import { createChatVitals, withChatVitals } from '../src/index.js';
import { histograms, spanText, telemetry } from './harness.js';

const SECRET = 'SECRET_PROMPT_do_not_record';

function near(actual: unknown, expected: number): void {
  assert.equal(typeof actual, 'number');
  assert.ok(Math.abs((actual as number) - expected) < 1e-9, `${String(actual)} is not near ${expected}`);
}

interface Step {
  at: number;
  bytes?: Uint8Array;
  done?: boolean;
}

interface Captured {
  url: string;
  method: string;
  headers: Headers;
  body: string | undefined;
}

function clock() {
  return {
    t: 0,
    at(ms: number) {
      this.t = ms;
    },
  };
}

function scripted(
  time: { at(ms: number): void },
  steps: Step[],
  extra?: { status?: number; responseId?: string },
): { fetch: typeof fetch; requests: Captured[] } {
  const requests: Captured[] = [];
  const pending = [...steps];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const step = pending.shift();
        if (!step || step.done) {
          if (step) time.at(step.at);
          controller.close();
          return;
        }
        time.at(step.at);
        controller.enqueue(step.bytes ?? new Uint8Array());
      },
    });
    const headers = new Headers();
    if (extra?.responseId) headers.set('x-gen-ai-response-id', extra.responseId);
    return new Response(stream, { status: extra?.status ?? 200, headers });
  };
  return { fetch: fetchImpl, requests };
}

function hangFetch(): { fetch: typeof fetch; requests: Captured[] } {
  const requests: Captured[] = [];
  const fetchImpl: typeof fetch = (_input, init) => {
    requests.push({
      url: '',
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    return new Promise((_resolve, reject) => {
      const fail = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
      if (init?.signal?.aborted) {
        fail();
        return;
      }
      init?.signal?.addEventListener('abort', fail, { once: true });
    });
  };
  return { fetch: fetchImpl, requests };
}

function hangBody(signal: AbortSignal | null | undefined, responseId: string): Response {
  let rejectPull: ((err: unknown) => void) | undefined;
  const stream = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise((_resolve, reject) => {
        rejectPull = reject;
        const fail = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
        if (signal?.aborted) {
          fail();
          return;
        }
        signal?.addEventListener('abort', fail, { once: true });
      });
    },
    cancel() {
      rejectPull?.(new DOMException('The operation was aborted.', 'AbortError'));
    },
  });
  return new Response(stream, { headers: { 'x-gen-ai-response-id': responseId } });
}

function textOf(bytes: string): Uint8Array {
  return new TextEncoder().encode(bytes);
}

describe('chat fetch signals', () => {
  it('records receive timings, traceparent, baggage, and skips empty reads', async () => {
    const kit = telemetry();
    try {
      const stamps = [0, 100, 180, 250];
      let stamp = 0;
      const script = scripted(
        { at() {} },
        [
          { at: 0, bytes: new Uint8Array() },
          { at: 0, bytes: textOf('hello') },
          { at: 0, bytes: new Uint8Array() },
          { at: 0, bytes: textOf(' world') },
          { at: 0, done: true },
        ],
        { responseId: 'resp-1' },
      );
      const vitals = createChatVitals({
        now: () => stamps[stamp++] ?? 250,
        fetch: script.fetch,
        sessionId: 'sess-1',
        conversationId: 'conv-1',
        requestModel: 'claude-test',
        providerName: 'anthropic',
        tracerProvider: kit.tracerProvider,
        meterProvider: kit.meterProvider,
        loggerProvider: kit.loggerProvider,
      });
      const response = await vitals.fetch('/api/chat', {
        method: 'POST',
        headers: { baggage: 'other=keep', 'x-debug': SECRET },
        body: SECRET,
      });
      assert.equal(await response.text(), 'hello world');
      assert.equal(response.headers.get('x-gen-ai-response-id'), 'resp-1');
      assert.equal(script.requests.length, 1);
      const outgoing = script.requests[0];
      assert.ok(outgoing);
      assert.equal(outgoing.body, SECRET);
      assert.equal(outgoing.headers.get('baggage'), 'other=keep,session.id=sess-1');
      const traceparent = outgoing.headers.get('traceparent');
      assert.ok(traceparent);

      const finished = kit.spans.getFinishedSpans();
      assert.equal(finished.length, 1);
      const span = finished[0];
      assert.ok(span);
      assert.equal(span.name, SPAN_NAME);
      assert.equal(span.kind, SpanKind.CLIENT);
      assert.equal(span.status.code, SpanStatusCode.OK);
      assert.equal(span.attributes[ATTR.sessionId], 'sess-1');
      assert.equal(span.attributes[ATTR.conversationId], 'conv-1');
      assert.equal(span.attributes[ATTR.requestModel], 'claude-test');
      assert.equal(span.attributes[ATTR.providerName], 'anthropic');
      assert.equal(span.attributes[ATTR.requestStream], true);
      assert.equal(span.attributes[ATTR.responseId], 'resp-1');
      assert.equal(span.attributes[ATTR.httpMethod], 'POST');
      assert.equal(span.attributes[ATTR.urlFull], undefined);
      assert.equal(span.attributes[ATTR.serverAddress], undefined);
      assert.equal(span.attributes['gen_ai.operation.name'], undefined);
      near(span.attributes[ATTR.firstChunk], 0.1);
      assert.equal(span.attributes[ATTR.chunkCount], 2);
      assert.equal(spanText(span).includes(SECRET), false);
      assert.equal(stamp, 4);
      const parts = traceparent.split('-');
      assert.equal(parts[1], span.spanContext().traceId);
      assert.equal(parts[2], span.spanContext().spanId);

      await kit.flush();
      const points = histograms(kit.metricExporter.getMetrics());
      const first = points.find((point) => point.name === 'gen_ai.ui.time_to_first_chunk');
      const cadence = points.find((point) => point.name === 'gen_ai.ui.time_per_output_chunk');
      const duration = points.find((point) => point.name === 'gen_ai.ui.stream.duration');
      assert.ok(first, JSON.stringify(points));
      assert.ok(cadence, JSON.stringify(points));
      assert.ok(duration, JSON.stringify(points));
      assert.equal(first.count, 1);
      near(first.sum, 0.1);
      assert.equal(cadence.count, 1);
      near(cadence.sum, 0.08);
      assert.equal(duration.count, 1);
      near(duration.sum, 0.25);
      assert.deepEqual(first.boundaries, BUCKETS);
      assert.deepEqual(first.attrs, {
        [ATTR.providerName]: 'anthropic',
        [ATTR.requestModel]: 'claude-test',
      });
      assert.equal(first.attrs[ATTR.sessionId], undefined);
      assert.equal(first.attrs[ATTR.responseId], undefined);
      vitals.dispose();
    } finally {
      await kit.shutdown();
    }
  });

  it('keeps an existing session.id baggage member and strips userinfo from url.full', async () => {
    const kit = telemetry();
    try {
      const time = clock();
      const script = scripted(time, [{ at: 10, bytes: textOf('ok') }, { at: 20, done: true }], {
        responseId: 'resp-abs',
      });
      const vitals = createChatVitals({
        now: () => time.t,
        fetch: script.fetch,
        sessionId: 'new-session',
        tracerProvider: kit.tracerProvider,
        meterProvider: kit.meterProvider,
        loggerProvider: kit.loggerProvider,
      });
      const response = await vitals.fetch('http://user:pass@files.example/v1/chat?q=1#frag', {
        method: 'POST',
        headers: { baggage: 'session.id=keep-me,other=1' },
      });
      assert.equal(await response.text(), 'ok');
      const outgoing = script.requests[0];
      assert.ok(outgoing);
      assert.equal(outgoing.headers.get('baggage'), 'session.id=keep-me,other=1');
      const span = kit.spans.getFinishedSpans()[0];
      assert.ok(span);
      assert.equal(span.attributes[ATTR.urlFull], 'http://files.example/v1/chat?q=1');
      assert.equal(span.attributes[ATTR.serverAddress], 'files.example');
      assert.equal(span.attributes[ATTR.serverPort], 80);
      assert.equal(spanText(span).includes('user:pass'), false);
      vitals.dispose();
    } finally {
      await kit.shutdown();
    }
  });

  it('does not invent a host for a relative url', async () => {
    const kit = telemetry();
    try {
      let seen = '';
      const vitals = createChatVitals({
        fetch: async (_input, init) => {
          seen = new Headers(init?.headers).get('traceparent') ?? '';
          return new Response(null);
        },
        tracerProvider: kit.tracerProvider,
        meterProvider: kit.meterProvider,
        loggerProvider: kit.loggerProvider,
      });
      const response = await vitals.fetch('/api/chat');
      assert.equal(response.body, null);
      const span = kit.spans.getFinishedSpans()[0];
      assert.ok(span);
      assert.equal(span.attributes[ATTR.httpMethod], 'GET');
      assert.equal(span.attributes[ATTR.urlFull], undefined);
      assert.equal(span.attributes[ATTR.serverAddress], undefined);
      assert.equal(span.attributes[ATTR.serverPort], undefined);
      assert.match(seen, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
      vitals.dispose();
    } finally {
      await kit.shutdown();
    }
  });

  it('ends a 500 without a first-chunk sample and keeps the error body', async () => {
    const kit = telemetry();
    try {
      const time = clock();
      const vitals = createChatVitals({
        now: () => time.t,
        fetch: async () => {
          time.at(30);
          return new Response('nope', { status: 500, headers: { 'x-gen-ai-response-id': 'err-1' } });
        },
        tracerProvider: kit.tracerProvider,
        meterProvider: kit.meterProvider,
        loggerProvider: kit.loggerProvider,
      });
      const response = await vitals.fetch('/api/chat', { method: 'POST', body: SECRET });
      assert.equal(response.status, 500);
      assert.equal(await response.text(), 'nope');
      const span = kit.spans.getFinishedSpans()[0];
      assert.ok(span);
      assert.equal(span.status.code, SpanStatusCode.ERROR);
      assert.equal(span.attributes[ATTR.errorType], '500');
      assert.equal(span.attributes[ATTR.responseId], 'err-1');
      assert.equal(span.attributes[ATTR.firstChunk], undefined);
      assert.equal(span.attributes[ATTR.chunkCount], 0);
      assert.equal(spanText(span).includes(SECRET), false);
      await kit.flush();
      const points = histograms(kit.metricExporter.getMetrics());
      assert.equal(points.some((point) => point.name === 'gen_ai.ui.time_to_first_chunk'), false);
      const duration = points.find((point) => point.name === 'gen_ai.ui.stream.duration');
      assert.ok(duration);
      near(duration.sum, 0.03);
      vitals.dispose();
    } finally {
      await kit.shutdown();
    }
  });

  it('records stream duration for an empty body and skips time to first chunk', async () => {
    const kit = telemetry();
    try {
      const vitals = createChatVitals({
        now: () => 0,
        fetch: async () => new Response(''),
        tracerProvider: kit.tracerProvider,
        meterProvider: kit.meterProvider,
        loggerProvider: kit.loggerProvider,
      });
      const response = await vitals.fetch('/api/chat');
      assert.equal(await response.text(), '');
      const span = kit.spans.getFinishedSpans()[0];
      assert.ok(span);
      assert.equal(span.attributes[ATTR.firstChunk], undefined);
      assert.equal(span.attributes[ATTR.chunkCount], 0);
      assert.equal(span.status.code, SpanStatusCode.OK);
      await kit.flush();
      const points = histograms(kit.metricExporter.getMetrics());
      assert.equal(points.some((point) => point.name === 'gen_ai.ui.time_to_first_chunk'), false);
      assert.equal(points.find((point) => point.name === 'gen_ai.ui.stream.duration')?.count, 1);
      vitals.dispose();
    } finally {
      await kit.shutdown();
    }
  });

  it('uses the error name, or _OTHER when the throw has none', async () => {
    const kit = telemetry();
    try {
      const named = createChatVitals({
        fetch: async () => {
          throw new TypeError('socket');
        },
        tracerProvider: kit.tracerProvider,
        meterProvider: kit.meterProvider,
        loggerProvider: kit.loggerProvider,
      });
      await assert.rejects(() => named.fetch('/api/chat'), TypeError);
      const unnamed = createChatVitals({
        fetch: async () => {
          throw 'nope';
        },
        tracerProvider: kit.tracerProvider,
        meterProvider: kit.meterProvider,
        loggerProvider: kit.loggerProvider,
      });
      await assert.rejects(() => unnamed.fetch('/api/chat'));
      const spans = kit.spans.getFinishedSpans();
      assert.equal(spans[0]?.attributes[ATTR.errorType], 'TypeError');
      assert.equal(spans[1]?.attributes[ATTR.errorType], '_OTHER');
      assert.equal(spans[0]?.status.code, SpanStatusCode.ERROR);
      named.dispose();
      unnamed.dispose();
    } finally {
      await kit.shutdown();
    }
  });

  it('records stop as a user action and aborts the fetch', async () => {
    const kit = telemetry();
    try {
      const hanging = hangFetch();
      const vitals = createChatVitals({
        fetch: hanging.fetch,
        tracerProvider: kit.tracerProvider,
        meterProvider: kit.meterProvider,
        loggerProvider: kit.loggerProvider,
      });
      const pending = vitals.fetch('/api/chat', { method: 'POST', body: SECRET });
      vitals.stop();
      await assert.rejects(pending, (err: unknown) => {
        assert.equal((err as { name?: string }).name, 'AbortError');
        return true;
      });
      const span = kit.spans.getFinishedSpans()[0];
      assert.ok(span);
      assert.equal(span.status.code, SpanStatusCode.OK);
      assert.equal(span.attributes[ATTR.errorType], undefined);
      assert.equal(span.events[0]?.name, EVENT.userAction);
      assert.equal(span.events[0]?.attributes[ATTR.userAction], 'stop');
      assert.equal(spanText(span).includes(SECRET), false);
      vitals.dispose();
    } finally {
      await kit.shutdown();
    }
  });

  it('treats a caller abort as abandon', async () => {
    const kit = telemetry();
    try {
      const hanging = hangFetch();
      const vitals = createChatVitals({
        fetch: hanging.fetch,
        tracerProvider: kit.tracerProvider,
        meterProvider: kit.meterProvider,
        loggerProvider: kit.loggerProvider,
      });
      const controller = new AbortController();
      const pending = vitals.fetch('/api/chat', { signal: controller.signal });
      controller.abort();
      await assert.rejects(pending);
      const span = kit.spans.getFinishedSpans()[0];
      assert.equal(span?.events[0]?.attributes[ATTR.userAction], 'abandon');
      assert.equal(span?.attributes[ATTR.errorType], undefined);
      vitals.dispose();
    } finally {
      await kit.shutdown();
    }
  });

  it('puts the previous response id on the next span after regenerate', async () => {
    const kit = telemetry();
    try {
      let call = 0;
      const vitals = createChatVitals({
        fetch: async (_input, init) => {
          call += 1;
          if (call === 1) return hangBody(init?.signal, 'resp-1');
          return new Response('next', { headers: { 'x-gen-ai-response-id': 'resp-2' } });
        },
        tracerProvider: kit.tracerProvider,
        meterProvider: kit.meterProvider,
        loggerProvider: kit.loggerProvider,
      });
      const first = await vitals.fetch('/api/chat', { method: 'POST', body: SECRET });
      assert.equal(first.headers.get('x-gen-ai-response-id'), 'resp-1');
      vitals.regenerate();
      const second = await vitals.fetch('/api/chat', { method: 'POST', body: SECRET });
      assert.equal(await second.text(), 'next');
      const spans = kit.spans.getFinishedSpans();
      assert.equal(spans.length, 2);
      assert.equal(spans[0]?.attributes[ATTR.responseId], 'resp-1');
      assert.equal(spans[0]?.attributes[ATTR.previousResponseId], undefined);
      assert.equal(spans[0]?.events[0]?.attributes[ATTR.userAction], 'regenerate');
      assert.equal(spans[0]?.status.code, SpanStatusCode.OK);
      assert.equal(spans[1]?.attributes[ATTR.previousResponseId], 'resp-1');
      assert.equal(spans[1]?.attributes[ATTR.responseId], 'resp-2');
      vitals.dispose();
    } finally {
      await kit.shutdown();
    }
  });

  it('abandons an open turn when the next fetch starts', async () => {
    const kit = telemetry();
    try {
      const hanging = hangFetch();
      const vitals = createChatVitals({
        fetch: hanging.fetch,
        tracerProvider: kit.tracerProvider,
        meterProvider: kit.meterProvider,
        loggerProvider: kit.loggerProvider,
      });
      const first = vitals.fetch('/api/chat');
      const second = vitals.fetch('/api/chat');
      vitals.stop();
      await assert.rejects(first);
      await assert.rejects(second);
      const spans = kit.spans.getFinishedSpans();
      assert.equal(spans[0]?.events[0]?.attributes[ATTR.userAction], 'abandon');
      assert.equal(spans[1]?.events[0]?.attributes[ATTR.userAction], 'stop');
      vitals.dispose();
    } finally {
      await kit.shutdown();
    }
  });

  it('records paint on an open turn and still records the histogram after the span ends', async () => {
    const kit = telemetry();
    try {
      const time = clock();
      let release: (() => void) | undefined;
      const vitals = createChatVitals({
        now: () => time.t,
        fetch: async () => {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              time.at(100);
              controller.enqueue(textOf('hi'));
              release = () => {
                time.at(200);
                try {
                  controller.close();
                } catch {
                  // Already closed.
                }
              };
            },
          });
          return new Response(stream, { headers: { 'x-gen-ai-response-id': 'paint-1' } });
        },
        tracerProvider: kit.tracerProvider,
        meterProvider: kit.meterProvider,
        loggerProvider: kit.loggerProvider,
      });
      const response = await vitals.fetch('/api/chat');
      time.at(120);
      const target = {
        textContent: '',
        observe(onChange: () => void) {
          target.textContent = 'hi';
          onChange();
          return () => {};
        },
      };
      const stopObserve = vitals.observePaintedToken(target);
      stopObserve();
      assert.equal(kit.spans.getFinishedSpans().length, 0);
      release?.();
      assert.equal(await response.text(), 'hi');
      time.at(300);
      vitals.markFirstPaintedToken();
      const span = kit.spans.getFinishedSpans()[0];
      near(span?.attributes[ATTR.firstPaint], 0.12);
      await kit.flush();
      const paint = histograms(kit.metricExporter.getMetrics()).filter(
        (point) => point.name === 'gen_ai.ui.time_to_first_painted_token',
      );
      assert.equal(paint.length, 1);
      assert.equal(paint[0]?.count, 1);
      near(paint[0]?.sum, 0.12);
      vitals.dispose();
    } finally {
      await kit.shutdown();
    }
  });

  it('records a paint histogram after the span has ended', async () => {
    const kit = telemetry();
    try {
      const time = clock();
      const script = scripted(time, [{ at: 50, bytes: textOf('x') }, { at: 80, done: true }]);
      const vitals = createChatVitals({
        now: () => time.t,
        fetch: script.fetch,
        tracerProvider: kit.tracerProvider,
        meterProvider: kit.meterProvider,
        loggerProvider: kit.loggerProvider,
      });
      const response = await vitals.fetch('/api/chat');
      assert.equal(await response.text(), 'x');
      time.at(400);
      vitals.markFirstPaintedToken();
      const span = kit.spans.getFinishedSpans()[0];
      assert.equal(span?.attributes[ATTR.firstPaint], undefined);
      await kit.flush();
      const paint = histograms(kit.metricExporter.getMetrics()).find(
        (point) => point.name === 'gen_ai.ui.time_to_first_painted_token',
      );
      assert.equal(paint?.count, 1);
      near(paint?.sum, 0.4);
      vitals.dispose();
    } finally {
      await kit.shutdown();
    }
  });

  it('copies only react_inp_blame strings and finite numbers while a turn is open', async () => {
    const kit = telemetry();
    try {
      let push: ((sample: { kind: 'inp' | 'long-animation-frame' | 'event'; value: number; startTime?: number }) => void) | undefined;
      let unsubscribed = false;
      const hanging = hangFetch();
      const vitals = createChatVitals({
        fetch: hanging.fetch,
        tracerProvider: kit.tracerProvider,
        meterProvider: kit.meterProvider,
        loggerProvider: kit.loggerProvider,
        observeFrames(onSample) {
          push = onSample;
          return () => {
            unsubscribed = true;
          };
        },
        blame() {
          return {
            'react_inp_blame.handler': 'Composer',
            'react_inp_blame.ms': 4,
            'react_inp_blame.bad': Number.NaN,
            'element.text': SECRET,
            other: 1,
          };
        },
      });
      push?.({ kind: 'inp', value: 12, startTime: 1 });
      const pending = vitals.fetch('/api/chat', { body: SECRET });
      push?.({ kind: 'inp', value: 30, startTime: 2 });
      push?.({ kind: 'long-animation-frame', value: 80 });
      push?.({ kind: 'event', value: 10 });
      vitals.stop();
      push?.({ kind: 'inp', value: 99 });
      await assert.rejects(pending);
      const span = kit.spans.getFinishedSpans()[0];
      assert.ok(span);
      const frames = span.events.filter((event) => event.name !== EVENT.userAction);
      assert.equal(frames.length, 3);
      assert.equal(span.events.some((event) => event.attributes[ATTR.userAction] === 'stop'), true);
      const inp = frames.find((event) => event.name === EVENT.inp);
      const loaf = frames.find((event) => event.name === EVENT.loaf);
      const raw = frames.find((event) => event.name === EVENT.event);
      assert.equal(inp?.attributes[ATTR.vitalName], 'inp');
      assert.equal(inp?.attributes[ATTR.vitalValue], 30);
      assert.equal(inp?.attributes['react_inp_blame.handler'], 'Composer');
      assert.equal(inp?.attributes['react_inp_blame.ms'], 4);
      assert.equal(inp?.attributes['react_inp_blame.bad'], undefined);
      assert.equal(inp?.attributes['element.text'], undefined);
      assert.equal(inp?.attributes.other, undefined);
      assert.equal(loaf?.attributes[ATTR.loafDuration], 80);
      assert.equal(raw?.attributes['react_inp_blame.handler'], 'Composer');
      assert.equal(spanText(span).includes(SECRET), false);
      vitals.dispose();
      assert.equal(unsubscribed, true);
    } finally {
      await kit.shutdown();
    }
  });

  it('emits human evaluation only when a response id is known, including after the span ends', async () => {
    const kit = telemetry();
    try {
      const time = clock();
      const script = scripted(time, [{ at: 5, bytes: textOf('ok') }, { at: 10, done: true }], {
        responseId: 'resp-9',
      });
      const vitals = createChatVitals({
        now: () => time.t,
        fetch: script.fetch,
        tracerProvider: kit.tracerProvider,
        meterProvider: kit.meterProvider,
        loggerProvider: kit.loggerProvider,
      });
      assert.equal(vitals.feedback('up', ''), false);
      assert.equal(vitals.feedback('down', '   '), false);
      const response = await vitals.fetch('/api/chat');
      assert.equal(await response.text(), 'ok');
      assert.equal(vitals.feedback('up', 'resp-9'), true);
      assert.equal(vitals.feedback('down', 'other-id'), true);
      const span = kit.spans.getFinishedSpans()[0];
      assert.ok(span);
      const records = kit.logExporter.getFinishedLogRecords();
      assert.equal(records.length, 2);
      const up = records[0];
      assert.ok(up);
      assert.equal(up.eventName, EVENT.evaluation);
      assert.equal(up.attributes[ATTR.evaluationName], 'user_feedback');
      assert.equal(up.attributes[ATTR.evaluationScore], 1);
      assert.equal(up.attributes[ATTR.evaluationLabel], 'up');
      assert.equal(up.attributes[ATTR.evaluatorType], 'human');
      assert.equal(up.attributes[ATTR.responseId], 'resp-9');
      assert.equal(up.spanContext?.spanId, span.spanContext().spanId);
      assert.equal(records[1]?.attributes[ATTR.evaluationScore], 0);
      assert.equal(records[1]?.attributes[ATTR.evaluationLabel], 'down');
      assert.equal(records[1]?.spanContext, undefined);
      vitals.dispose();
    } finally {
      await kit.shutdown();
    }
  });
});

describe('withChatVitals', () => {
  it('wraps chat methods and falls back to the last response id', async () => {
    const kit = telemetry();
    try {
      let mode: 'ok' | 'hang' = 'ok';
      const vitals = createChatVitals({
        fetch: (_input, init) => {
          if (mode === 'hang') {
            return new Promise((_resolve, reject) => {
              const fail = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
              if (init?.signal?.aborted) {
                fail();
                return;
              }
              init?.signal?.addEventListener('abort', fail, { once: true });
            });
          }
          return Promise.resolve(new Response('ok', { headers: { 'x-gen-ai-response-id': 'resp-chat' } }));
        },
        tracerProvider: kit.tracerProvider,
        meterProvider: kit.meterProvider,
        loggerProvider: kit.loggerProvider,
      });
      const order: string[] = [];
      const chat = {
        status: 'ready',
        isLoading: false,
        stop() {
          order.push('stop');
        },
        regenerate() {
          order.push('regenerate');
        },
        reload() {
          order.push('reload');
        },
        sendMessage() {
          const latest = kit.spans.getFinishedSpans().at(-1);
          order.push(latest?.events.at(-1)?.attributes[ATTR.userAction] === 'abandon' ? 'send' : 'send-early');
        },
        append() {
          order.push('append');
        },
        dispose() {
          order.push('dispose');
        },
      };
      const wrapped = withChatVitals(chat, vitals);
      assert.equal(wrapped.feedback('up'), false);
      const response = await vitals.fetch('/api/chat', { method: 'POST', body: SECRET });
      assert.equal(await response.text(), 'ok');
      assert.equal(wrapped.feedback('down'), true);
      mode = 'hang';
      const hanging = vitals.fetch('/api/chat', { method: 'POST' });
      const finishedBeforeStop = kit.spans.getFinishedSpans().length;
      wrapped.stop();
      assert.equal(kit.spans.getFinishedSpans().length, finishedBeforeStop + 1);
      await assert.rejects(hanging);
      mode = 'hang';
      const replaced = vitals.fetch('/api/chat');
      wrapped.sendMessage();
      await assert.rejects(replaced);
      wrapped.regenerate();
      wrapped.reload();
      wrapped.append();
      wrapped.dispose();
      assert.deepEqual(order, ['stop', 'send', 'regenerate', 'reload', 'append', 'dispose']);
      chat.status = 'streaming';
      assert.equal(wrapped.status, 'streaming');
      const log = kit.logExporter.getFinishedLogRecords()[0];
      assert.equal(log?.attributes[ATTR.responseId], 'resp-chat');
      assert.equal(log?.attributes[ATTR.evaluationLabel], 'down');
      vitals.dispose();
    } finally {
      await kit.shutdown();
    }
  });
});
