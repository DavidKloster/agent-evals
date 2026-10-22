import type { Transcript, TranscriptEvent, TranscriptEventInput, TrialMetrics } from './types.ts';

export type ToolCallEvent = Extract<TranscriptEvent, { type: 'tool_call' }>;
export type ModelCallEvent = Extract<TranscriptEvent, { type: 'model_call' }>;

/** A tool call with its result (the last one when a call has several), in the order the agent made them. */
export interface ToolUse {
  id: string;
  name: string;
  args: unknown;
  at: number;
  result?: unknown;
  error?: string;
}

export function toolUses(transcript: Transcript): ToolUse[] {
  const uses: ToolUse[] = [];
  const byId = new Map<string, ToolUse>();
  for (const event of transcript) {
    if (event.type === 'tool_call') {
      const use: ToolUse = { id: event.id, name: event.name, args: event.args, at: event.at };
      uses.push(use);
      byId.set(event.id, use);
    } else if (event.type === 'tool_result') {
      const use = byId.get(event.id);
      // The last result wins: a retried call that succeeded has no error any more.
      if (use) {
        use.result = event.result;
        if (event.error !== undefined) use.error = event.error;
        else delete use.error;
      }
    }
  }
  return uses;
}

export function messages(transcript: Transcript, role: 'user' | 'assistant'): string[] {
  return transcript.flatMap((e) => (e.type === 'message' && e.role === role ? [e.text] : []));
}

/** Every assistant message joined by blank lines, and the last one. */
export function answerOf(transcript: Transcript): { answer: string; finalAnswer: string } {
  const texts = messages(transcript, 'assistant');
  return { answer: texts.join('\n\n'), finalAnswer: texts.at(-1) ?? '' };
}

/** Fills in missing times, so a reference transcript from a task file grades like a recorded one. */
export function completeTranscript(events: TranscriptEventInput[], start = 0): Transcript {
  return events.map((event, index) => ({ ...event, at: event.at ?? start + index }));
}

/**
 * The trial's numbers from its transcript. A turn starts at a user message and ends at the next assistant message; its
 * time to first token is the reply's first token, or the first model call's first token in the turn, or the reply itself.
 */
export function metricsOf(
  transcript: Transcript,
  startedAt: number,
  endedAt: number,
): TrialMetrics {
  const ttftMs: number[] = [];
  const replyMs: number[] = [];
  let turnStart: number | null = null;
  let firstToken: number | null = null;
  let turns = 0;
  const metrics: TrialMetrics = {
    durationMs: endedAt - startedAt,
    ttftMs,
    replyMs,
    turns: 0,
    modelCalls: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    costComplete: true,
  };
  for (const event of transcript) {
    if (event.type === 'message' && event.role === 'user') {
      turnStart = event.at;
      firstToken = null;
      turns++;
    } else if (event.type === 'model_call') {
      metrics.modelCalls++;
      metrics.inputTokens += event.inputTokens ?? 0;
      metrics.outputTokens += event.outputTokens ?? 0;
      if (event.costUsd === undefined) metrics.costComplete = false;
      else metrics.costUsd += event.costUsd;
      if (turnStart !== null && firstToken === null && event.firstTokenAt !== undefined)
        firstToken = event.firstTokenAt;
    } else if (event.type === 'tool_call') {
      metrics.toolCalls++;
    } else if (event.type === 'message' && event.role === 'assistant' && turnStart !== null) {
      ttftMs.push((event.firstTokenAt ?? firstToken ?? event.at) - turnStart);
      replyMs.push(event.at - turnStart);
      turnStart = null;
    }
  }
  metrics.turns = turns;
  metrics.costUsd = Number(metrics.costUsd.toFixed(8));
  return metrics;
}
