import type { ChatFeedback, ChatLike, ChatVitals, Vote } from './types.js';

/** Proxy so `status` and the other getters stay live. Spreading a chat class would copy a stale snapshot. */
export function withChatVitals<T extends ChatLike>(chat: T, vitals: ChatVitals): T & ChatFeedback {
  return new Proxy(chat, {
    get(target, prop, receiver) {
      if (prop === 'feedback') {
        return (vote: Vote, responseId?: string) => vitals.feedback(vote, responseId ?? vitals.lastResponseId() ?? '');
      }
      if (typeof prop !== 'string') return Reflect.get(target, prop, receiver);
      const before = actionBefore(prop, vitals);
      if (!before) return Reflect.get(target, prop, receiver);
      const fn: unknown = Reflect.get(target, prop, receiver);
      if (typeof fn !== 'function') return fn;
      return (...args: unknown[]) => {
        before();
        return Reflect.apply(fn, target, args);
      };
    },
  }) as T & ChatFeedback;
}

function actionBefore(prop: string, vitals: ChatVitals): (() => void) | undefined {
  if (prop === 'stop') return () => vitals.stop();
  if (prop === 'regenerate' || prop === 'reload') return () => vitals.regenerate();
  if (prop === 'sendMessage' || prop === 'append' || prop === 'dispose') return () => vitals.abandon();
  return undefined;
}
