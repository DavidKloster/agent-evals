import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';

import { completeTranscript, metricsOf } from '../core/transcript.ts';
import {
  FORMAT_VERSION,
  InfraError,
  type AgentSession,
  type GraderResult,
  type ChatClient,
  type RunResult,
  type Suite,
  type Target,
  type Task,
  type Transcript,
  type TranscriptEventInput,
  type TrialContext,
  type TrialResult,
  type TrialStatus,
} from '../core/types.ts';
import { builtinGraders } from '../graders/builtin.ts';
import { checkToolResultMaxChars, judgeFailure } from '../graders/judge.ts';
import {
  gradersOf,
  gradeTrial,
  scoreOf,
  scoringOf,
  type GraderRegistry,
} from '../graders/grade.ts';
import { mapPool } from './pool.ts';
import { SimulatedUser, stopToken } from './simulated-user.ts';

export interface RunOptions {
  suites: Suite[];
  targets: Target[];
  /** The graders by type; the built-in ones by default. */
  graders?: GraderRegistry;
  /** Trials per task and target when neither the task nor its suite sets `trials` (default 3). */
  trials?: number;
  /** Trials per task and target for every task, over the task's and the suite's `trials` (the CLI's `--trials`). */
  trialsOverride?: number;
  /** Trials that run at the same time over all tasks and targets (default 4). */
  concurrency?: number;
  /** Retries of a trial after an infrastructure error (default 2). */
  retries?: number;
  /** A trial's time limit when neither the task nor the suite sets one (default 5 minutes). */
  timeoutMs?: number;
  /**
   * The time limit of each hook call, apart from the trial's (default 60 000 ms). A `beforeTrial` that takes longer
   * ends the attempt as an infrastructure error; an `afterTrial` that takes longer is left behind.
   */
  hookTimeoutMs?: number;
  /** Only these tasks (by id). */
  tasks?: string[];
  /**
   * Around every attempt of a trial: reset the environment, seed it, undo a write. `beforeTrial` runs before the trial's
   * clock starts; a throw (synchronous or not) or a time-out is an infrastructure error. `afterTrial`'s failures are
   * ignored.
   */
  hooks?: {
    beforeTrial?(context: TrialContext): Promise<void> | void;
    afterTrial?(context: TrialContext): Promise<void> | void;
  };
  /**
   * The model graders' chat client and the judge models (several for a consensus). Without a judge the model graders
   * are left out of the scores, and the run's meta says so (`modelGraders: 'skipped'`).
   */
  judge?: ChatClient;
  judgeModels?: string[];
  /** How much of each tool result a judge sees, unless its grader says otherwise (default 600 characters). */
  judgeToolResultMaxChars?: number;
  /**
   * The simulated user's chat client and model, for tasks with `input.user`; `reference` replays the user messages of
   * the task's reference solution instead (a dry run without a model).
   */
  userSimulator?: { client: ChatClient; model?: string } | 'reference';
  /** Where the transcripts go, one JSONL file per trial (`transcripts/<suite>/<target>/<task>.<trial>.jsonl`). */
  outDir?: string;
  onTrial?(result: TrialResult): void;
  meta?: Record<string, unknown>;
}

const slug = (value: string) => value.replace(/[^a-zA-Z0-9._-]+/g, '_');

const isInfra = (error: unknown) =>
  error instanceof InfraError || (error instanceof Error && error.name === 'InfraError');

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

class Timeout extends Error {
  override name = 'Timeout';
}

interface Job {
  suite: Suite;
  task: Task;
  target: Target;
  trial: number;
}

/** Runs every task of every suite against every target, several trials each, and grades them. */
export async function runEval(options: RunOptions): Promise<RunResult> {
  const graders = options.graders ?? builtinGraders();
  // A bad limit would fail every judge grader as the agent's failure: refused before anything runs.
  checkToolResultMaxChars(options.judgeToolResultMaxChars, 'judgeToolResultMaxChars');
  const startedAt = new Date().toISOString();
  const jobs: Job[] = [];
  // Without a judge, the model graders of the tasks that run are left out: the meta says so only when there are some.
  let skipsModelGraders = false;
  for (const suite of options.suites)
    for (const task of suite.tasks) {
      if (options.tasks && !options.tasks.includes(task.id)) continue;
      // A suite built by hand (not through loadSuite or defineSuite) gets the same check: no grader, no verdict.
      if (gradersOf(task, suite).length === 0)
        throw new Error(
          `${suite.name}/${task.id}: the task has no grader and the suite no default graders`,
        );
      if (task.input.user && !options.userSimulator)
        throw new Error(
          `${suite.name}/${task.id}: the task has a simulated user, but the run has no userSimulator`,
        );
      // One rule for trials and timeoutMs: the task, then the suite's defaults, then the run's; an override forces it.
      const trials =
        options.trialsOverride ?? task.trials ?? suite.defaults?.trials ?? options.trials ?? 3;
      if (!options.judge && trials > 0 && options.targets.length > 0)
        skipsModelGraders ||= gradersOf(task, suite).some(
          (spec) => graders.get(spec.type)?.kind === 'model',
        );
      for (const target of options.targets)
        for (let trial = 0; trial < trials; trial++) jobs.push({ suite, task, target, trial });
    }

  const trials = await mapPool(jobs, options.concurrency ?? 4, async (job) => {
    const result = await runTrial(job, options, graders);
    options.onTrial?.(result);
    return result;
  });

  return {
    formatVersion: FORMAT_VERSION,
    id: randomUUID(),
    startedAt,
    finishedAt: new Date().toISOString(),
    targets: options.targets.map(({ name, description }) => ({ name, description })),
    suites: options.suites.map((s) => ({
      name: s.name,
      kind: s.kind,
      owner: s.owner,
      tasks: s.tasks.map((t) => t.id),
      saturation: s.saturation,
      graduation: s.graduation,
    })),
    trials,
    meta: skipsModelGraders ? { ...options.meta, modelGraders: 'skipped' } : options.meta,
  };
}

interface Attempt {
  status: TrialStatus;
  error?: string;
  transcript: Transcript;
  outcome: unknown;
  startedAt: number;
  endedAt: number;
}

/** How long the end of a trial waits for a pending start, the outcome and `close`, so a hung agent can't hang the run. */
const graceMs = 10_000;

/** Calls `fn` so that a synchronous throw becomes a rejection, handled like an async one's. */
function call<T>(fn: () => T | Promise<T>): Promise<T> {
  return new Promise<T>((resolve) => resolve(fn()));
}

/** The value of `promise`, or undefined when it doesn't settle within `ms` (or rejects). */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([promise.catch(() => undefined), late]);
  } finally {
    clearTimeout(timer);
  }
}

async function attempt(job: Job, options: RunOptions): Promise<Attempt> {
  const { suite, task, target, trial } = job;
  const transcript: Transcript = [];
  // Once the attempt has ended, an agent still running (it ignored the abort) can't change what is graded.
  let ended = false;
  const record = (event: TranscriptEventInput) => {
    if (!ended) transcript.push(...completeTranscript([event], Date.now()));
  };
  const controller = new AbortController();
  const context: TrialContext = {
    suite,
    task,
    target: target.name,
    trial,
    signal: controller.signal,
    record,
  };
  const timeoutMs = task.timeoutMs ?? suite.defaults?.timeoutMs ?? options.timeoutMs ?? 300_000;
  const hookTimeoutMs = options.hookTimeoutMs ?? 60_000;
  let startedAt = Date.now();
  let starting: Promise<AgentSession> | undefined;
  let session: AgentSession | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (options.hooks?.beforeTrial) {
      try {
        // Its own time limit, before the trial's clock starts: a slow reset is never the agent's timeout.
        const late = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new InfraError(`beforeTrial took longer than ${hookTimeoutMs} ms`)),
            hookTimeoutMs,
          );
        });
        await Promise.race([call(() => options.hooks?.beforeTrial?.(context)), late]);
      } catch (error) {
        // Resetting the environment is the eval's job: its failure is never the agent's.
        throw isInfra(error) ? error : new InfraError(`beforeTrial failed: ${message(error)}`);
      } finally {
        clearTimeout(timer);
      }
      startedAt = Date.now();
    }
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(new Timeout(`the trial took longer than ${timeoutMs} ms`));
        reject(new Timeout(`the trial took longer than ${timeoutMs} ms`));
      }, timeoutMs);
    });
    timedOut.catch(() => undefined);
    const run = async () => {
      starting = target.adapter.start(context);
      session = await starting;
      await converse(session, context, options);
      return await session.outcome?.();
    };
    const outcome = await Promise.race([run(), timedOut]);
    return {
      status: 'completed',
      transcript: [...transcript],
      outcome: outcome ?? null,
      startedAt,
      endedAt: Date.now(),
    };
  } catch (error) {
    const status: TrialStatus =
      error instanceof Timeout ? 'timeout' : isInfra(error) ? 'infra_error' : 'agent_error';
    const kind = status === 'timeout' ? 'timeout' : status === 'infra_error' ? 'infra' : 'agent';
    record({ type: 'error', kind, message: message(error) });
    // A start still pending at the timeout gets its session closed too (a conversation the agent opened).
    if (!session && starting) session = await within(starting, graceMs);
    const open = session;
    const outcome = open?.outcome
      ? await within(
          call(() => open.outcome?.()),
          graceMs,
        )
      : undefined;
    return {
      status,
      error: message(error),
      transcript: [...transcript],
      outcome: outcome ?? null,
      startedAt,
      endedAt: Date.now(),
    };
  } finally {
    clearTimeout(timer);
    if (!controller.signal.aborted) controller.abort(new Error('the trial ended'));
    const open = session;
    if (open?.close)
      await within(
        call(() => open.close?.()),
        graceMs,
      );
    ended = true;
    if (options.hooks?.afterTrial)
      await within(
        call(() => options.hooks?.afterTrial?.(context)),
        hookTimeoutMs,
      );
  }
}

/**
 * The fixed turns, then the simulated user's messages until it stops, the agent says it is done, or the turns run out.
 * The simulated user hears every fixed turn and its reply; its first message is `firstMessage` when set, else its own.
 */
async function converse(
  session: AgentSession,
  context: TrialContext,
  options: RunOptions,
): Promise<void> {
  const { task, record, signal } = context;
  const spec = task.input.user;
  const user =
    !spec || !options.userSimulator
      ? undefined
      : options.userSimulator === 'reference'
        ? new SimulatedUser(spec, referenceUser(task))
        : new SimulatedUser(spec, options.userSimulator.client, options.userSimulator.model);
  let sent = 0;
  const send = async (text: string) => {
    record({ type: 'message', role: 'user', text });
    sent++;
    const reply = await session.send(text);
    record({
      type: 'message',
      role: 'assistant',
      text: reply.text,
      firstTokenAt: reply.firstTokenAt,
    });
    return reply;
  };
  for (const turn of task.input.turns ?? []) {
    signal.throwIfAborted();
    const reply = await send(turn);
    if (reply.done) return;
    user?.heard(turn, reply.text);
  }
  if (!spec || !user) return;
  const maxTurns = spec.maxTurns ?? 6;
  // The agent's reply the simulated user hasn't heard yet.
  let lastReply: string | null = null;
  while (sent < maxTurns) {
    signal.throwIfAborted();
    let next: string | null;
    try {
      next = await user.next(lastReply, signal);
    } catch (error) {
      // The simulated user is part of the evaluation harness: its failure is never the agent's.
      throw new InfraError(`the simulated user failed: ${message(error)}`);
    }
    if (next === null) return;
    record({ type: 'note', text: 'simulated user', data: { turn: sent + 1 } });
    const reply = await send(next);
    if (reply.done) return;
    lastReply = reply.text;
  }
}

/**
 * A user that says the reference solution's user messages that come after the task's fixed turns and its
 * `firstMessage` (which the harness sends itself), then stops.
 */
function referenceUser(task: Task): ChatClient {
  const said = (task.reference?.transcript ?? []).flatMap((e) =>
    e.type === 'message' && e.role === 'user' ? [e.text] : [],
  );
  let next = (task.input.turns?.length ?? 0) + (task.input.user?.firstMessage ? 1 : 0);
  return { complete: () => Promise.resolve({ text: said[next++] ?? stopToken }) };
}

async function runTrial(
  job: Job,
  options: RunOptions,
  graders: GraderRegistry,
): Promise<TrialResult> {
  const retries = options.retries ?? 2;
  const infraErrors: string[] = [];
  let result: Attempt;
  let attempts = 0;
  for (;;) {
    attempts++;
    result = await attempt(job, options);
    if (result.status !== 'infra_error') break;
    infraErrors.push(result.error ?? 'infrastructure error');
    if (attempts > retries) break;
  }
  const { suite, task, target, trial } = job;
  let grades: GraderResult[] = [];
  let gradingError: string | undefined;
  if (result.status !== 'infra_error') {
    try {
      grades = await gradeTrial(task, result.transcript, result.outcome, {
        graders,
        suite,
        target: target.name,
        judge: options.judge,
        judgeModels: options.judgeModels,
        judgeToolResultMaxChars: options.judgeToolResultMaxChars,
        skipModelGraders: !options.judge,
      });
    } catch (error) {
      // The judge's provider failed after its own retries: the trial can't be graded, which is never the agent's fault.
      // It is a grading failure, not an attempt's: the attempt keeps its status and isn't retried.
      gradingError = judgeFailure(error);
      grades = [];
    }
  }
  const ungraded =
    result.status !== 'infra_error' &&
    (gradingError !== undefined || (grades.length === 0 && gradersOf(task, suite).length > 0));
  const { score, passed } = scoreOf(grades, scoringOf(task, suite));
  let transcriptFile: string | undefined;
  if (options.outDir) {
    // Stored in run.json, so it reads the same on every OS.
    transcriptFile = posix.join(
      'transcripts',
      slug(suite.name),
      slug(target.name),
      `${slug(task.id)}.${trial}.jsonl`,
    );
    const file = join(options.outDir, transcriptFile);
    mkdirSync(dirname(file), { recursive: true });
    const lines = result.transcript.map((event) => {
      // The version is the line's first key, and an event can't override it (a reference event may hold any key).
      const line: Record<string, unknown> = { formatVersion: FORMAT_VERSION, ...event };
      line.formatVersion = FORMAT_VERSION;
      return JSON.stringify(line) + '\n';
    });
    writeFileSync(file, lines.join(''));
  }
  return {
    suite: suite.name,
    suiteKind: suite.kind,
    taskId: task.id,
    target: target.name,
    trial,
    status: result.status,
    attempts,
    infraErrors,
    error: result.error,
    outcome: result.outcome,
    grades,
    ...(ungraded ? { ungraded } : {}),
    ...(gradingError !== undefined ? { gradingError } : {}),
    score: result.status === 'completed' && !ungraded ? score : 0,
    passed: result.status === 'completed' && !ungraded && passed,
    metrics: metricsOf(result.transcript, result.startedAt, result.endedAt),
    transcript: result.transcript,
    transcriptFile,
    startedAt: new Date(result.startedAt).toISOString(),
  };
}
