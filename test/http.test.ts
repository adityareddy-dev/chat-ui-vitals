import assert from 'node:assert/strict';
import http from 'node:http';
import { describe, it } from 'node:test';
import { ATTR, SPAN_NAME } from '../src/names.js';
import { createChatVitals } from '../src/index.js';
import { histograms, spanText, telemetry } from './harness.js';

const SECRET = 'SECRET_PROMPT_do_not_record';

describe('mock streaming endpoint', () => {
  it('joins traceparent to the browser span and records loose receive timings', async () => {
    const kit = telemetry();
    const seen: { traceparent?: string; baggage?: string; body: string } = { body: '' };
    const server = http.createServer((req, res) => {
      seen.traceparent = req.headers.traceparent;
      seen.baggage = req.headers.baggage;
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => {
        seen.body += chunk;
      });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/plain', 'x-gen-ai-response-id': 'srv-1' });
        setTimeout(() => {
          res.write('hello');
          setTimeout(() => {
            res.write(' world');
            setTimeout(() => res.end(), 40);
          }, 40);
        }, 80);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected a tcp port');
    try {
      const vitals = createChatVitals({
        sessionId: 'sess-http',
        tracerProvider: kit.tracerProvider,
        meterProvider: kit.meterProvider,
        loggerProvider: kit.loggerProvider,
      });
      const url = `http://127.0.0.1:${address.port}/api/chat`;
      const response = await vitals.fetch(url, { method: 'POST', body: SECRET });
      assert.equal(await response.text(), 'hello world');
      assert.equal(seen.body, SECRET);
      assert.match(seen.baggage ?? '', /session\.id=sess-http/);
      const span = kit.spans.getFinishedSpans()[0];
      assert.ok(span);
      assert.equal(span.name, SPAN_NAME);
      const parts = (seen.traceparent ?? '').split('-');
      assert.equal(parts[1], span.spanContext().traceId);
      assert.equal(parts[2], span.spanContext().spanId);
      assert.equal(span.attributes[ATTR.responseId], 'srv-1');
      assert.equal(span.attributes[ATTR.serverAddress], '127.0.0.1');
      assert.equal(span.attributes[ATTR.serverPort], address.port);
      assert.equal(span.attributes[ATTR.urlFull], url);
      assert.equal(span.attributes[ATTR.chunkCount], 2);
      const ttfc = span.attributes[ATTR.firstChunk];
      assert.equal(typeof ttfc, 'number');
      assert.ok(typeof ttfc === 'number' && ttfc > 0.05 && ttfc < 2, String(ttfc));
      await kit.flush();
      const points = histograms(kit.metricExporter.getMetrics());
      const first = points.find((point) => point.name === 'gen_ai.ui.time_to_first_chunk');
      const cadence = points.find((point) => point.name === 'gen_ai.ui.time_per_output_chunk');
      const duration = points.find((point) => point.name === 'gen_ai.ui.stream.duration');
      assert.equal(first?.count, 1);
      assert.equal(cadence?.count, 1);
      assert.ok(duration && duration.sum >= (first?.sum ?? 0));
      assert.equal(spanText(span).includes(SECRET), false);
      assert.deepEqual(first?.attrs, {});
      vitals.dispose();
    } finally {
      server.close();
      await kit.shutdown();
    }
  });
});
