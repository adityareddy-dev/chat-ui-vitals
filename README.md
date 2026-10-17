# chat-ui-vitals

Browser timings for a React LLM chat. The page's span is `gen_ai.ui.chat`. It is not `gen_ai.client.inference`, cause that span belongs to the process that calls the model, `@ai-sdk/otel` or the provider SDK. `traceparent` on the chat fetch is how a server span joins this trace. The app server still has to forward that header when it calls the model, and the Node process needs its OpenTelemetry context manager turned on. Without that, the header shows up and the server span stays on its own trace.

A chunk is one non-empty `ReadableStream` read of the response body. That is what the browser received, not a model token and not an SSE event. Two SSE events that arrive in one read count as one chunk.

`private` is set, so npm will refuse to publish this. `npm view` on 2026-10-17 returned 404 for `chat-ui-vitals`, `chat-vitals`, and `llm-ui-vitals`. None of those names was reserved.

## Use

```ts
const vitals = createChatVitals({
  sessionId,
  conversationId,
  requestModel,
  providerName,
  blame(sample) {
    if (sample.kind !== 'inp' || sample.startTime == null) return {}
    return inpBlameAttributes(sample.startTime)
  },
})

const chat = withChatVitals(useChat({
  transport: new DefaultChatTransport({ api: '/api/chat', fetch: vitals.fetch }),
}), vitals)

chat.feedback('up')
vitals.observePaintedToken(node)
```

`withChatVitals` also wraps `reload` and `append` when those AI SDK v4 methods are present. A new `sendMessage` or `append` while a turn is open abandons that turn. TanStack AI is not wrapped. `react-inp-blame` is not a dependency. Pass `inpBlameAttributes` through `blame` if the page already has it. Only `react_inp_blame.*` strings and finite numbers are copied, so the callback cannot put prompt text on the span.

`FrameSample` is `{ kind: 'inp' | 'long-animation-frame' | 'event', value, startTime? }`. `value` is milliseconds. The app pushes `inp` from its own web-vitals callback. This package does not decide which interaction is the page INP. The default listener subscribes to `long-animation-frame` and `event` only when `PerformanceObserver.supportedEntryTypes` lists them. An `event` entry with an `interactionId` stays kind `event`, not `inp`.

`feedback` returns false and emits nothing when it has no response id. The id comes from the response header `x-gen-ai-response-id`, or from the id passed to `feedback`. A UI message id is not copied into `gen_ai.response.id`.

`session.id` is set on the span, and sent as baggage, only when the caller passes one. It is not turned into `gen_ai.conversation.id`. The package does not invent a conversation id either.

## Signals

Checked against the OpenTelemetry registry on 2026-10-17. "Not in semconv" means the name is this package's, not a registered one. The `gen_ai.ui.` prefix is there so a backend can tell these from inference metrics. Do not copy a browser number into `gen_ai.client.inference.*` or into `gen_ai.response.time_to_first_chunk`. Those measure the model client.

| Signal | What is emitted | Registry |
| --- | --- | --- |
| Time to first chunk, as the page receives it | Histogram `gen_ai.ui.time_to_first_chunk`, unit `s`, from `fetch` to the first non-empty read. Same number on the span. Omitted when the body has no chunk. | Not in semconv. Closest are `gen_ai.client.inference.time_to_first_chunk` and `gen_ai.response.time_to_first_chunk`, both Development, both the model client. |
| Time to first painted token | Histogram `gen_ai.ui.time_to_first_painted_token`, unit `s`, from that same `fetch` to the first time the paint target's text is non-empty. | Not in semconv. |
| Stream duration as received | Histogram `gen_ai.ui.stream.duration`, unit `s`, from `fetch` to body end, cancel, or failure. The span duration matches it. Span attribute `gen_ai.ui.chunk.count` is the non-empty read count. | Not in semconv. `gen_ai.client.inference.duration` is the model call and is not used. |
| Chunk cadence as received | Histogram `gen_ai.ui.time_per_output_chunk`, unit `s`. One sample per read after the first. | Not in semconv. `gen_ai.client.inference.time_per_output_chunk` (Development) has the same shape at the model client. |
| Long Animation Frame while a turn is open | Span event `gen_ai.ui.long_animation_frame`, with `gen_ai.ui.long_animation_frame.duration_ms`, plus any `react_inp_blame.*` strings and numbers. | Not in semconv. `react_inp_blame.*` is outside semconv on purpose. |
| INP while a turn is open | Span event `gen_ai.ui.inp` with `browser.web_vital.name=inp` and `browser.web_vital.value`, plus `react_inp_blame.*`. This does not emit the page's `browser.web_vital` log. | `browser.web_vital.name` and `browser.web_vital.value` are Development, and `inp` is a registered name. Linking that vital to the chat span is not in semconv. |
| Stop, regenerate, abandon | Span event `gen_ai.ui.user_action` with `gen_ai.ui.user_action.name` of `stop`, `regenerate`, or `abandon`. The span ends OK. A caller's bare abort, with no named action, is abandon. | Not in semconv. `gen_ai.response.finish_reasons` is the model's stop reason and is not set. |
| Next request after regenerate | `gen_ai.request.previous_response.id` when the previous response id is known. | Development, recommended. |
| Thumbs up or down | Log `gen_ai.evaluation.result`. `gen_ai.evaluation.name=user_feedback`, `gen_ai.evaluation.score.value` 1 or 0, `gen_ai.evaluation.score.label` `up` or `down`, `gen_ai.response.id`. Also sends `evaluator.type=human`. | The event and those four attributes are Development. `evaluator.type` on this event is not in semconv. Nothing is emitted without a response id. |
| Join to server spans | W3C `traceparent` for this span, set after `propagation.inject`, so a no-op global propagator still leaves the header. | Trace context is stable. |
| Session | `session.id` on the span, and a `session.id` baggage member, when the caller passes one. | General semconv, Development, opt-in. |
| Conversation | `gen_ai.conversation.id` when the caller passes one. | Development. |
| Response id | `gen_ai.response.id` from `x-gen-ai-response-id`, or from the id passed to `feedback`. | The attribute is Development. The header name is this package's contract with the app server, not a convention. |

The span name is `gen_ai.ui.chat`, kind `CLIENT`. `gen_ai.operation.name` is omitted so the span is not counted as a model chat. `gen_ai.provider.name` and `gen_ai.request.model` are set only when the caller passes them. The page usually does not know the provider. `gen_ai.request.stream` is true. `error.type` is the HTTP status string, or `_OTHER` when the failure has no name. Message text is not an attribute.

Histogram buckets match the inference timing buckets: 0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92. Metric attributes are only `gen_ai.provider.name` and `gen_ai.request.model`, and only when the caller set them.

## Tests

`npm test` uses Node's test runner, a scripted fetch clock, and a local HTTP server that dribbles a body. That covers receive timings, `traceparent`, baggage, response id, stop, regenerate, abandon, evaluation logs, blame filtering, and the chat proxy. Prompt text from the request body is asserted absent.

`npm run test:browser` is Playwright against headless Chromium. On 2026-10-17 that run covered `MutationObserver` paint while a turn is open, Long Animation Frames and Event Timing entries while a stream is open, a React `useChat` render through `withChatVitals` (the streamed reply and a thumbs-up log), and `traceparent` from the page becoming the parent of an `@ai-sdk/otel` span in a dev server.

Still unverified: whether the first painted token lines up with a visible glyph. The browser check sees the text node and a non-empty layout box, not the glyph's pixels. Firefox and WebKit are not covered.

## License

MIT.
