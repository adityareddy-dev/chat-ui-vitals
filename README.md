# chat-ui-vitals

Local prototype of browser-perceived OpenTelemetry for a React LLM chat. Not published. `private` is set, so npm refuses to publish it.

The browser span is `gen_ai.ui.chat`. It is not `gen_ai.client.inference`. Time to first chunk is the time until the page receives bytes. The model client keeps its own clock. `traceparent` on the chat fetch is how a server span from `@ai-sdk/otel` joins this trace. The app server still has to forward that header when it calls the model.

A chunk is one non-empty `ReadableStream` read of the response body.

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

`withChatVitals` also wraps `reload` and `append` when those AI SDK v4 methods are present. TanStack AI is not wrapped. `react-inp-blame` is not a dependency. Pass `inpBlameAttributes` through `blame` if the page already has it.

`npm view` on 2026-10-17 returned 404 for `chat-vitals`, `llm-ui-vitals`, and `chat-ui-vitals`. None of those names was reserved.

## Tests

`npm test` uses Node's test runner, a scripted fetch clock, and a local HTTP server that dribbles a body. That covers receive timings, `traceparent`, baggage, response id, stop, regenerate, abandon, evaluation logs, blame filtering, and the chat proxy.

Still unchecked in a real browser: `MutationObserver` paint, real Long Animation Frames and Event Timing, a React `useChat` render, and `traceparent` through a dev server into `@ai-sdk/otel`.
