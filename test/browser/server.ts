import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { context, propagation, ROOT_CONTEXT } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { InMemorySpanExporter, BasicTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OpenTelemetry } from '@ai-sdk/otel';
import { generateText, registerTelemetry, simulateReadableStream, streamText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import * as esbuild from 'esbuild';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const port = Number(process.env.CHAT_VITALS_PORT || 4178);

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
// context.with is a no-op until a context manager is enabled, so the server span would ignore traceparent.
const contextManager = new AsyncLocalStorageContextManager();
contextManager.enable();
context.setGlobalContextManager(contextManager);
propagation.setGlobalPropagator(new W3CTraceContextPropagator());
registerTelemetry(new OpenTelemetry({ tracer: provider.getTracer('gen_ai') }));

const model = new MockLanguageModelV4({
  doGenerate: async () => ({
    content: [{ type: 'text', text: 'Hello from the server' }],
    finishReason: { unified: 'stop', raw: undefined },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 20, text: 20, reasoning: undefined },
    },
    warnings: [],
  }),
  doStream: async () => ({
    stream: simulateReadableStream({
      chunks: [
        { type: 'text-start', id: 'text-1' },
        { type: 'text-delta', id: 'text-1', delta: 'Hello' },
        { type: 'text-delta', id: 'text-1', delta: ' from the chat' },
        { type: 'text-end', id: 'text-1' },
        {
          type: 'finish',
          finishReason: { unified: 'stop', raw: undefined },
          logprobs: undefined,
          usage: {
            inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 10, text: 10, reasoning: undefined },
          },
        },
      ],
    }),
  }),
});

const page = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>chat-ui-vitals</title></head>
<body>
<div id="root"></div>
<script src="/app.js"></script>
</body>
</html>
`;

function resolveTypeScriptJs(args: esbuild.OnResolveArgs): esbuild.OnResolveResult | null {
  if (!args.importer || !args.path.startsWith('.') || !args.path.endsWith('.js')) return null;
  const candidate = path.resolve(path.dirname(args.importer), `${args.path.slice(0, -3)}.ts`);
  if (!existsSync(candidate)) return null;
  return { path: candidate };
}

async function bundle(): Promise<Uint8Array> {
  const result = await esbuild.build({
    absWorkingDir: root,
    entryPoints: [path.join(root, 'test/browser/client.tsx')],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [
      {
        name: 'ts-js-specifier',
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) => resolveTypeScriptJs(args));
        },
      },
    ],
  });
  const output = result.outputFiles[0];
  if (!output) throw new Error('esbuild produced no bundle');
  return output.contents;
}

async function drain(req: IncomingMessage): Promise<void> {
  for await (const _chunk of req) {
    // The chat body is not telemetry. Drop it.
  }
}

function headerMap(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers[key] = value;
  }
  return headers;
}

async function writeWeb(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  for (;;) {
    const step = await reader.read();
    if (step.done) break;
    res.write(step.value);
  }
  res.end();
}

async function handleOtel(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await drain(req);
  const headers = headerMap(req);
  const parent = propagation.extract(ROOT_CONTEXT, headers);
  const before = exporter.getFinishedSpans().length;
  await context.with(parent, () =>
    generateText({
      model,
      prompt: 'hi',
      telemetry: { isEnabled: true, functionId: 'chat-ui-vitals-browser' },
    }),
  );
  const spans = exporter
    .getFinishedSpans()
    .slice(before)
    .map((span) => ({
      name: span.name,
      traceId: span.spanContext().traceId,
      parentSpanId: span.parentSpanContext?.spanId ?? null,
    }));
  const body = JSON.stringify({ traceparent: headers.traceparent ?? null, spans });
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await drain(req);
  const result = streamText({
    model,
    prompt: 'hi',
    telemetry: { isEnabled: false },
  });
  await writeWeb(
    res,
    result.toUIMessageStreamResponse({
      headers: { 'x-gen-ai-response-id': 'resp-browser' },
    }),
  );
}

function handleHang(_req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/plain; charset=utf-8',
    'x-gen-ai-response-id': 'resp-hang',
  });
}

const server = createServer((req, res) => {
  void (async () => {
    try {
      const url = req.url ?? '/';
      if (req.method === 'GET' && url === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page);
        return;
      }
      if (req.method === 'GET' && url === '/app.js') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
        res.end(await bundle());
        return;
      }
      if (req.method === 'POST' && url === '/api/hang') {
        handleHang(req, res);
        return;
      }
      if (req.method === 'POST' && url === '/api/chat') {
        await handleChat(req, res);
        return;
      }
      if (req.method === 'POST' && url === '/api/otel') {
        await handleOtel(req, res);
        return;
      }
      res.writeHead(404);
      res.end('not found');
    } catch (err) {
      const message = err instanceof Error ? err.stack ?? err.message : String(err);
      console.error(message);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(message);
    }
  })();
});

await bundle();
server.listen(port, '127.0.0.1', () => {
  console.log(`chat-ui-vitals browser server http://127.0.0.1:${port}`);
});
