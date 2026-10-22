import {
  InfraError,
  type Adapter,
  type AgentReply,
  type AgentSession,
  type TranscriptEventInput,
  type TrialContext,
} from '../core/types.ts';

/** One scripted reply: the events the agent "makes" during the turn, then its answer. */
export interface ScriptedTurn {
  text: string;
  events?: TranscriptEventInput[];
  /** Wait before replying (to test timeouts and latencies). */
  delayMs?: number;
  /** Fail the turn: `infra` throws an InfraError, any other text an agent error with that message. */
  fail?: string;
  /** The agent ends the conversation after this reply. */
  done?: boolean;
}

export interface ScriptedOptions {
  /**
   * The replies per task id: a list (one per user turn) or a function of the trial and the turn, so a test can make
   * trial 2 fail or answer a simulated user.
   */
  replies?: Record<
    string,
    ScriptedTurn[] | ((context: TrialContext, turn: number, message: string) => ScriptedTurn)
  >;
  /** Replay the task's reference solution when the task has no scripted replies. */
  replayReference?: boolean;
  /** The outcome per task id, or of the reference solution when replaying. */
  outcomes?: Record<string, unknown>;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    });
  });

/** The reference transcript cut into turns: the events after each user message up to the assistant's answer. */
export function referenceTurns(events: TranscriptEventInput[]): ScriptedTurn[] {
  const turns: ScriptedTurn[] = [];
  let pending: TranscriptEventInput[] = [];
  for (const event of events) {
    if (event.type === 'message' && event.role === 'user') pending = [];
    else if (event.type === 'message' && event.role === 'assistant') {
      turns.push({ text: event.text, events: pending });
      pending = [];
    } else pending.push(event);
  }
  return turns;
}

/**
 * An agent that replays scripts: the framework's own tests, a check of the reference solutions, and a dry run of a
 * suite before it costs a model call.
 */
export function scriptedAdapter(options: ScriptedOptions): Adapter {
  return {
    start(context: TrialContext): Promise<AgentSession> {
      const { task } = context;
      const script =
        options.replies?.[task.id] ??
        (options.replayReference && task.reference?.transcript
          ? referenceTurns(task.reference.transcript)
          : undefined);
      if (!script) return Promise.reject(new Error(`no script for task ${task.id}`));
      let turn = 0;
      return Promise.resolve({
        async send(message: string): Promise<AgentReply> {
          const step = typeof script === 'function' ? script(context, turn, message) : script[turn];
          turn++;
          if (!step) throw new Error(`the script of ${task.id} has no reply for turn ${turn}`);
          if (step.delayMs) await sleep(step.delayMs, context.signal);
          // Measured, not start + delayMs: a timer can fire late, and the first token must not come after the reply.
          const firstTokenAt = Date.now();
          if (step.fail === 'infra') throw new InfraError('scripted infrastructure error');
          if (step.fail) throw new Error(step.fail);
          for (const event of step.events ?? []) context.record(event);
          return { text: step.text, done: step.done, firstTokenAt };
        },
        outcome() {
          const outcome = options.outcomes?.[task.id];
          if (typeof outcome === 'function')
            return (outcome as (c: TrialContext) => unknown)(context);
          if (outcome !== undefined) return outcome;
          return options.replayReference ? (task.reference?.outcome ?? null) : null;
        },
      });
    },
  };
}
