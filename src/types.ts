import type { LoggerProvider } from '@opentelemetry/api-logs';
import type { MeterProvider, TracerProvider } from '@opentelemetry/api';

export type Vote = 'up' | 'down';

export type UserAction = 'stop' | 'regenerate' | 'abandon';

/** A sample observed while a chat turn is open. `value` is milliseconds. */
export interface FrameSample {
  readonly kind: 'inp' | 'long-animation-frame' | 'event';
  readonly value: number;
  /** `performance.now()` at the interaction or frame start, when the caller knows it. */
  readonly startTime?: number;
}

/**
 * A node the first painted token is read from. Tests pass `observe`.
 * A real element is used through `MutationObserver` when the page has one.
 */
export interface PaintTarget {
  textContent: string | null;
  nodeType?: number;
  observe?(onChange: () => void): () => void;
}

export interface BlameAttributes {
  [key: string]: string | number;
}

export interface ChatVitalsOptions {
  tracerProvider?: TracerProvider;
  meterProvider?: MeterProvider;
  loggerProvider?: LoggerProvider;
  /** General semconv `session.id`. Also sent as baggage. Not copied to `gen_ai.conversation.id`. */
  sessionId?: string;
  /** Registered `gen_ai.conversation.id`. Omitted when the app has none. The package does not invent one. */
  conversationId?: string;
  /** Registered `gen_ai.request.model`. Omitted when the page does not know it. */
  requestModel?: string;
  /** Registered `gen_ai.provider.name`. Never guessed. */
  providerName?: string;
  /**
   * Host adapter, usually closing over `inpBlameAttributes` from `react-inp-blame/otel`.
   * Only `react_inp_blame.*` strings and finite numbers are copied.
   */
  blame?: (sample: FrameSample) => BlameAttributes;
  /** Replaces the default PerformanceObserver. Return an unsubscribe function. */
  observeFrames?: (onSample: (sample: FrameSample) => void) => () => void;
  now?: () => number;
  fetch?: typeof fetch;
}

export interface ChatVitals {
  /** Chat fetch. Injects `traceparent` for this span and records receive timings. */
  readonly fetch: typeof fetch;
  stop(): void;
  regenerate(): void;
  abandon(): void;
  /** First time assistant text is on screen. Safe to call after the body has ended. */
  markFirstPaintedToken(): void;
  observePaintedToken(target: PaintTarget): () => void;
  /**
   * Emits `gen_ai.evaluation.result` when `responseId` is non-empty.
   * Returns false and emits nothing otherwise.
   */
  feedback(vote: Vote, responseId: string): boolean;
  /** Last `x-gen-ai-response-id` seen on a chat response, if any. */
  lastResponseId(): string | undefined;
  /** Ends an open turn as abandon and detaches the frame listener. Does not shut down the SDK. */
  dispose(): void;
}

/** The bit of AI SDK `useChat` this wrapper touches. v4 `reload` / `append` are optional. */
export interface ChatLike {
  stop?: (...args: never[]) => unknown;
  regenerate?: (...args: never[]) => unknown;
  reload?: (...args: never[]) => unknown;
  sendMessage?: (...args: never[]) => unknown;
  append?: (...args: never[]) => unknown;
  dispose?: (...args: never[]) => unknown;
  status?: string;
  isLoading?: boolean;
}

export interface ChatFeedback {
  feedback(vote: Vote, responseId?: string): boolean;
}
