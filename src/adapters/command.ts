import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';

import {
  InfraError,
  type Adapter,
  type AgentReply,
  type AgentSession,
  type TrialContext,
} from '../core/types.ts';
import { defaultEventMapper, text, type TurnState } from './event-mapper.ts';

export interface CommandOptions {
  /** The program and its arguments, started without a shell: `['uv', 'run', 'python', '-m', 'my_agent.eval']`. */
  command: string[];
  /** The process's working directory (default: the current one). */
  cwd?: string;
  /** Variables set over the current environment. */
  env?: Record<string, string>;
}

/** How long `close()` waits for the process to exit by itself after its stdin closed. */
const CLOSE_GRACE_MS = 5_000;
/** How long a process gets between SIGTERM and SIGKILL. Both graces together stay under the harness's 10 s for close. */
const KILL_GRACE_MS = 2_000;
/** The exit code for "try again later" (EX_TEMPFAIL in sysexits.h): the infrastructure failed, not the agent. */
const EX_TEMPFAIL = 75;
/** How much of stderr an error message quotes: its last lines, from a tail of at most so many characters. */
const STDERR_TAIL_LINES = 10;
const STDERR_TAIL_CHARS = 4_000;
/** How much of a stdout line that is not an event an error message quotes. */
const BAD_LINE_CHARS = 200;

/** A turn as the command reports it; `infra` marks its error as the infrastructure's (`{ type: 'error', infra: true }`). */
type Turn = TurnState & { infra?: boolean };

/**
 * An agent in any language, run as a process per trial. The process reads a start record and then one user message per
 * line as JSON on stdin, and writes its events as JSON lines on stdout: the `http-sse` adapter's events (a turn ends at
 * `done` or `error`), `note`, and `outcome`, whose last value is the trial's outcome. A program that can't be started,
 * an `error` event with `infra: true`, and an exit with code 75 before a turn ended are infrastructure errors; any other
 * exit before a turn ended, and a stdout line that is not a JSON event, are the agent's. See docs/python-agents.md.
 */
export function commandAdapter(options: CommandOptions): Adapter {
  const { command } = options;
  // A shell line written as one string would start a program named after its first word and fail every trial.
  if (!Array.isArray(command) || command.length === 0 || command.some((p) => typeof p !== 'string'))
    throw new Error(
      'the command adapter needs `command`: the program and its arguments as a list of strings',
    );
  return {
    async start(context: TrialContext): Promise<AgentSession> {
      context.signal.throwIfAborted();
      const child = await launch(command, options);
      const session = commandSession(child, context);
      child.stdin.write(
        line({
          type: 'start',
          suite: context.suite.name,
          task: { id: context.task.id, input: { context: context.task.input.context ?? {} } },
          target: context.target,
          trial: context.trial,
        }),
      );
      return session;
    },
  };
}

const line = (value: unknown) => `${JSON.stringify(value)}\n`;

/** Starts the process. A program that can't be started (missing, not executable) is the eval's setup, not the agent. */
async function launch(
  [program, ...args]: string[],
  options: CommandOptions,
): Promise<ChildProcessWithoutNullStreams> {
  try {
    const child = spawn(program!, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      // Its own process group (POSIX only), so ending it also ends what a wrapper such as `uv run` started.
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    await once(child, 'spawn');
    return child;
  } catch (error) {
    throw new InfraError(
      `could not start ${program}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** The session of one process: maps its stdout to turns, keeps its outcome and stderr's tail, and ends it. */
function commandSession(
  child: ChildProcessWithoutNullStreams,
  context: TrialContext,
): AgentSession {
  const { signal, record } = context;
  let turn: Turn = { text: '', finished: false };
  /** Turns that ended before a `send` waited for them. */
  const ended: Turn[] = [];
  let waiting: { resolve: (turn: Turn) => void; reject: (error: unknown) => void } | undefined;
  let outcome: unknown;
  let stderr = '';
  /** Why the process can't answer any more; set once its output has closed. */
  let gone: Error | undefined;
  let terminating = false;
  let closing: Promise<void> | undefined;

  const finishTurn = () => {
    const done = turn;
    turn = { text: '', finished: false };
    if (waiting) waiting.resolve(done);
    else ended.push(done);
    waiting = undefined;
  };
  const onLine = (raw: string) => {
    if (!raw.trim()) return;
    const at = Date.now();
    const data = parseEvent(raw);
    if (!data) {
      // Logs belong on stderr: a stray line could as well be a broken event, so the turn fails loudly.
      turn.finished = true;
      turn.error = `the command wrote a line to stdout that is not a JSON event (write logs to stderr): ${raw.slice(0, BAD_LINE_CHARS)}`;
    } else if (data.type === 'outcome') outcome = data.outcome;
    else if (data.type === 'note')
      record({ type: 'note', text: text(data.text), data: data.data, at });
    else {
      if (data.type === 'error' && data.infra === true) turn.infra = true;
      defaultEventMapper({ event: data.type, data: raw, at }, data, turn, record, undefined);
    }
    if (turn.finished) finishTurn();
  };

  /** Sends SIGTERM, then SIGKILL after a grace, to the process and what it started. */
  const terminate = () => {
    if (terminating || gone) return;
    terminating = true;
    kill(child, 'SIGTERM');
    const timer = setTimeout(() => kill(child, 'SIGKILL'), KILL_GRACE_MS);
    child.once('close', () => clearTimeout(timer));
  };
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
  /** Ends stdin, so the process can clean up and exit; it is terminated when it doesn't within the grace. */
  const close = () =>
    (closing ??= (async () => {
      child.stdin.end();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<'late'>((resolve) => {
        timer = setTimeout(() => resolve('late'), CLOSE_GRACE_MS);
      });
      if ((await Promise.race([exited, late])) === 'late') {
        terminate();
        await exited;
      }
      clearTimeout(timer);
    })());
  // The harness also aborts when a trial ends normally, just before `close()`: only a running turn is cut short then.
  const onAbort = () => {
    if (waiting) {
      waiting.reject(signal.reason);
      waiting = undefined;
      terminate();
    } else void close();
  };

  // After the start, the process reports only a failed kill as an error; the SIGKILL and the harness's grace cover it.
  child.on('error', () => undefined);
  // Writing to a process that has exited fails with EPIPE; the exit itself is what a turn reports.
  child.stdin.on('error', () => undefined);
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS);
  });
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', onLine);
  child.once('close', (code: number | null, killedBy: NodeJS.Signals | null) => {
    gone = exitError(code, killedBy, stderr);
    waiting?.reject(gone);
    waiting = undefined;
    signal.removeEventListener('abort', onAbort);
  });
  if (signal.aborted) void close();
  else signal.addEventListener('abort', onAbort, { once: true });

  const nextTurn = () =>
    new Promise<Turn>((resolve, reject) => {
      const done = ended.shift();
      if (done) resolve(done);
      else if (gone) reject(gone);
      else waiting = { resolve, reject };
    });

  return {
    async send(message: string): Promise<AgentReply> {
      signal.throwIfAborted();
      child.stdin.write(line({ type: 'user', text: message }));
      const done = await nextTurn();
      if (done.error) {
        // Keep what the agent said before it failed: the transcript shows the partial answer.
        if (done.text) record({ type: 'message', role: 'assistant', text: done.text });
        throw done.infra ? new InfraError(done.error) : new Error(done.error);
      }
      return { text: done.text, firstTokenAt: done.firstTokenAt };
    },
    outcome: () => outcome,
    close,
  };
}

/** A stdout line as an event: a JSON object with a string `type`, or null. */
function parseEvent(raw: string): (Record<string, unknown> & { type: string }) | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  return value !== null &&
    typeof value === 'object' &&
    typeof (value as { type?: unknown }).type === 'string'
    ? (value as Record<string, unknown> & { type: string })
    : null;
}

/** Signals the process's group (POSIX), so a wrapper's children end too; on Windows, the process itself. */
function kill(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  try {
    if (process.platform === 'win32' || child.pid === undefined) child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    // The group has already ended (ESRCH).
  }
}

/** Why a process that exited can't finish its turn. Code 75 (EX_TEMPFAIL) says the infrastructure failed. */
function exitError(code: number | null, killedBy: NodeJS.Signals | null, stderr: string): Error {
  const tail = stderr.trimEnd().split(/\r?\n/).slice(-STDERR_TAIL_LINES).join('\n');
  const message =
    `the command ${code === null ? `was killed by ${killedBy}` : `exited with code ${code}`} before its turn ended` +
    (tail ? `; the end of its stderr:\n${tail}` : '');
  return code === EX_TEMPFAIL ? new InfraError(message) : new Error(message);
}
