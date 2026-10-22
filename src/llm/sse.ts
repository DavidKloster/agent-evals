import { InfraError } from '../core/types.ts';

export interface SseEvent {
  event: string;
  data: string;
  /** When the event's block was complete, in ms since the epoch. */
  at: number;
}

/**
 * Reads Server-Sent Events from a byte stream: blocks split by a blank line, `event:` and `data:` fields, comments (`:`)
 * skipped. An event without a name is `message`, as in the browser's EventSource.
 */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';
  let finished = false;
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        // A connection that drops mid-stream is the infrastructure's failure; an abort (the trial's time limit) isn't.
        if (error instanceof Error && error.name === 'AbortError') throw error;
        throw new InfraError(
          `the stream broke: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const { done, value } = chunk;
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let cut: RegExpExecArray | null;
      while ((cut = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, cut.index);
        buffer = buffer.slice(cut.index + cut[0].length);
        const event = parseBlock(block);
        if (event) yield event;
      }
      if (done) {
        finished = true;
        const event = parseBlock(buffer);
        if (event) yield event;
        return;
      }
    }
  } finally {
    // A consumer that stops early (at `[DONE]` or `done`) closes the connection instead of leaving it open.
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function parseBlock(block: string): SseEvent | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  return data.length === 0 ? null : { event, data: data.join('\n'), at: Date.now() };
}

/** Parses an event's data as JSON, or keeps it as `{ raw }`. */
export function sseJson(event: SseEvent): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(event.data);
    return value !== null && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : { value };
  } catch {
    return { raw: event.data };
  }
}
