import type { TranscriptEventInput } from '../core/types.ts';
import type { SseEvent } from '../llm/sse.ts';

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

/**
 * Maps one event of a turn's stream to the transcript and the turn's state; `session` is what `open` returned. The
 * `http-sse` adapter passes each Server-Sent Event; the `command` adapter passes each line of the process's output, its
 * `type` as the event's name and the line as its data.
 */
export type EventMapper<S = unknown> = (
  event: SseEvent,
  data: Record<string, unknown>,
  turn: TurnState,
  record: (event: TranscriptEventInput) => void,
  session: S,
) => void;

/** A field of an event as text: a string as it is, anything else as JSON. */
export const text = (value: unknown, fallback = ''): string =>
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
