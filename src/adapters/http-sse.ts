import {
  InfraError,
  type Adapter,
  type AgentReply,
  type AgentSession,
  type TranscriptEventInput,
  type TrialContext,
} from '../core/types.ts';
import { readSse, sseJson, type SseEvent } from '../llm/sse.ts';

/** What a turn's stream has said so far; a mapper adds to it. */
export interface TurnState {
  text: string;
  firstTokenAt?: number;
  /** The stream said the turn is over. */
  finished: boolean;
  /** The stream said the turn failed (an abort, a refusal): the agent's error. */
  error?: string;
  /** The agent ended the conversation. */
  done?: boolean;
}

/** Maps one Server-Sent Event to the transcript and the turn's state; `session` is what `open` returned. */
export type EventMapper<S = unknown> = (
  event: SseEvent,
  data: Record<string, unknown>,
  turn: TurnState,
  record: (event: TranscriptEventInput) => void,
  session: S,
) => void;

/** A field of an event as text: a string as it is, anything else as JSON. */
const text = (value: unknown, fallback = ''): string =>
  value === undefined || value === null
    ? fallback
    : typeof value === 'string'
      ? value
      : JSON.stringify(value);

/**
 * The default event names: `text` (`{ text }`, a delta of the answer), `tool_call` (`{ id, name, args }`),
 * `tool_result` (`{ id, name, result, error? }`), `usage` (`{ model, inputTokens, outputTokens, costUsd, startedAt?,
 * firstTokenAt?, endedAt? }`), `done` and `error` (`{ message }`).
 */
export const defaultEventMapper: EventMapper = (event, data, turn, record) => {
  switch (event.event) {
    case 'text':
      turn.firstTokenAt ??= event.at;
      turn.text += text(data.text);
      break;
    case 'tool_call':
      record({
        type: 'tool_call',
        id: text(data.id),
        name: text(data.name),
        args: data.args ?? null,
        at: event.at,
      });
      break;
    case 'tool_result':
      record({
        type: 'tool_result',
        id: text(data.id),
        name: text(data.name),
        result: data.result ?? null,
        ...(data.error ? { error: text(data.error) } : {}),
        at: event.at,
      });
      break;
    case 'usage':
      record({
        type: 'model_call',
        model: text(data.model),
        startedAt: Number(data.startedAt ?? event.at),
        firstTokenAt: data.firstTokenAt === undefined ? undefined : Number(data.firstTokenAt),
        endedAt: Number(data.endedAt ?? event.at),
        inputTokens: data.inputTokens === undefined ? undefined : Number(data.inputTokens),
        outputTokens: data.outputTokens === undefined ? undefined : Number(data.outputTokens),
        costUsd: data.costUsd === undefined ? undefined : Number(data.costUsd),
        at: event.at,
      });
      break;
    case 'done':
      turn.finished = true;
      break;
    case 'error':
      turn.finished = true;
      turn.error = text(data.message ?? data.raw, 'the agent failed');
      break;
  }
};

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
