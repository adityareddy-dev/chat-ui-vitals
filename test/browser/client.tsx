import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { createChatVitals, withChatVitals } from '../../src/index.ts';
import { browserProviders, recordedLogs, recordedMetrics, recordedSpans } from './recorder.ts';

const vitals = createChatVitals({
  ...browserProviders(),
  sessionId: 'sess-browser',
  conversationId: 'conv-browser',
});

function textOf(message: UIMessage): string {
  return message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

function burn(ms: number): void {
  const start = performance.now();
  while (performance.now() - start < ms) {
    void document.body.getBoundingClientRect();
  }
}

function ChatPane() {
  const chat = withChatVitals(
    useChat({
      transport: new DefaultChatTransport({ api: '/api/chat', fetch: vitals.fetch }),
    }),
    vitals,
  );

  useEffect(() => {
    const button = document.querySelector('#slow');
    const onClick = () => burn(180);
    button?.addEventListener('click', onClick);
    return () => button?.removeEventListener('click', onClick);
  }, []);

  return (
    <>
      <button id="send" type="button" onClick={() => void chat.sendMessage({ text: 'hi' })}>
        send
      </button>
      <button id="up" type="button" onClick={() => chat.feedback('up')}>
        up
      </button>
      <button id="slow" type="button">
        slow
      </button>
      <div id="status">{chat.status}</div>
      <div id="out">{chat.messages.map((message) => textOf(message)).join('\n')}</div>
      <div id="paint" />
    </>
  );
}

const paintNode = () => document.querySelector('#paint');

let stopPaint: (() => void) | undefined;

window.__chatVitals = {
  supported: () => PerformanceObserver.supportedEntryTypes.slice(),
  startPaint: () => {
    const node = paintNode();
    if (!node) throw new Error('paint node is missing');
    stopPaint = vitals.observePaintedToken(node);
  },
  paintAttr: () => {
    for (const span of recordedSpans()) {
      const value = span.attributes['gen_ai.ui.time_to_first_painted_token'];
      if (typeof value === 'number') return value;
    }
    return null;
  },
  stopPaint: () => stopPaint?.(),
  hang: () => {
    void vitals.fetch('/api/hang', { method: 'POST' }).catch(() => {});
  },
  frameEvents: () => recordedSpans().flatMap((span) => span.events.map((event) => event.name)),
  burnFrame: () =>
    new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        burn(80);
        requestAnimationFrame(() => resolve());
      });
    }),
  otel: async () => {
    const response = await vitals.fetch('/api/otel', { method: 'POST', body: 'hi' });
    return response.json() as Promise<{
      traceparent: string | null;
      spans: Array<{ name: string; traceId: string; parentSpanId: string | null }>;
    }>;
  },
  logs: () => recordedLogs().map((record) => ({ eventName: record.eventName, attributes: record.attributes })),
  metrics: () => recordedMetrics(),
};

const root = document.querySelector('#root');
if (!root) throw new Error('root is missing');
createRoot(root).render(<ChatPane />);

declare global {
  interface Window {
    __chatVitals: {
      supported: () => string[];
      startPaint: () => void;
      paintAttr: () => number | null;
      stopPaint: () => void;
      hang: () => void;
      frameEvents: () => string[];
      burnFrame: () => Promise<void>;
      otel: () => Promise<{
        traceparent: string | null;
        spans: Array<{ name: string; traceId: string; parentSpanId: string | null }>;
      }>;
      logs: () => Array<{ eventName: string | undefined; attributes: Record<string, unknown> }>;
      metrics: () => Array<{ name: string; value: number }>;
    };
  }
}
