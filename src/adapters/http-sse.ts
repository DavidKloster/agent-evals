import {
  InfraError,
  type Adapter,
  type AgentReply,
  type AgentSession,
  type TrialContext,
} from '../core/types.ts';
import { readSse, sseJson } from '../llm/sse.ts';
import { defaultEventMapper, type EventMapper, type TurnState } from './event-mapper.ts';

export interface HttpSseOptions<S = unknown> {
  /** Opens the trial's session on the agent's side (a new conversation) and returns what the turns need. */
  open?: (context: TrialContext) => Promise<S> | S;
  /** The URL of a turn. */
  url: string | ((state: S, context: TrialContext) => string);
  headers?:
    | Record<string, string>
    | ((
        state: S,
        context: TrialContext,
      ) => Record<string, string> | Promise<Record<string, string>>);
  /** The request body of a turn (default `{ message }`). */
  body?: (message: string, state: S, context: TrialContext) => unknown;
  mapEvent?: EventMapper<S>;
  /** Reads the trial's outcome from the agent's side. */
  outcome?: (state: S, context: TrialContext) => unknown;
  /** Removes what the trial left (deletes the conversation). */
  close?: (state: S, context: TrialContext) => Promise<void> | void;
  fetch?: typeof fetch;
}

/**
 * A generic HTTP agent that streams its turn as Server-Sent Events. A connection failure and the statuses 408, 429,
 * 502, 503 and 504 are infrastructure errors; another refusal is the agent's error.
 */
export function httpSseAdapter<S = unknown>(options: HttpSseOptions<S>): Adapter {
  const mapEvent = options.mapEvent ?? defaultEventMapper;
  return {
    async start(context: TrialContext): Promise<AgentSession> {
      const state = (await options.open?.(context)) as S;
      return {
        async send(message: string): Promise<AgentReply> {
          const url = typeof options.url === 'function' ? options.url(state, context) : options.url;
          const headers =
            typeof options.headers === 'function'
              ? await options.headers(state, context)
              : options.headers;
          let response: Response;
          try {
            response = await (options.fetch ?? fetch)(url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Accept: 'text/event-stream',
                ...headers,
              },
              body: JSON.stringify(
                options.body ? options.body(message, state, context) : { message },
              ),
              signal: context.signal,
              // A redirect could carry the session's cookies elsewhere: the agent's URL is exact.
              redirect: 'error',
            });
          } catch (error) {
            if (context.signal.aborted) throw error;
            throw new InfraError(
              `POST ${url} failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          if (!response.ok || !response.body) {
            const message = `HTTP ${response.status} from ${url}: ${(await response.text().catch(() => '')).slice(0, 500)}`;
            throw [408, 429, 502, 503, 504].includes(response.status)
              ? new InfraError(message)
              : new Error(message);
          }
          const turn: TurnState = { text: '', finished: false };
          for await (const event of readSse(response.body)) {
            mapEvent(event, sseJson(event), turn, context.record, state);
            if (turn.finished) break;
          }
          if (turn.error) {
            // Keep what the agent said before it failed: the transcript shows the partial answer.
            if (turn.text) context.record({ type: 'message', role: 'assistant', text: turn.text });
            throw new Error(turn.error);
          }
          if (!turn.finished)
            throw new InfraError(`the stream of ${url} ended without a last event`);
          return { text: turn.text, firstTokenAt: turn.firstTokenAt, done: turn.done };
        },
        outcome: () => options.outcome?.(state, context),
        close: () => options.close?.(state, context),
      };
    },
  };
}
