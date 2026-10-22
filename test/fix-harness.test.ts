import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { scriptedAdapter } from '../src/adapters/scripted.ts';
import { defineSuite } from '../src/core/loader.ts';
import {
  InfraError,
  type Adapter,
  type ChatClient,
  type ChatRequest,
  type Suite,
} from '../src/core/types.ts';
import { builtinGraders } from '../src/graders/builtin.ts';
import { setJudgeRetryMs } from '../src/graders/judge.ts';
import { regradeRun } from '../src/harness/regrade.ts';
import { runEval } from '../src/harness/run.ts';
import { SimulatedUser } from '../src/harness/simulated-user.ts';
import { summarize } from '../src/metrics/stats.ts';

const suite = (tasks: unknown[], extra: Partial<Suite> = {}): Suite =>
  defineSuite({ name: 'demo', kind: 'capability', tasks, ...extra });

const task = (extra: Record<string, unknown> = {}) => ({
  id: 't',
  input: { turns: ['q'] },
  graders: [{ type: 'facts', facts: ['a'] }],
  ...extra,
});

const answers = scriptedAdapter({ replies: { t: () => ({ text: 'a' }) } });

const judgedTask = task({
  graders: [{ type: 'judge', rubric: { name: 'd', question: 'q?', pass: 'p', fail: 'f' } }],
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('F3: one precedence rule for trials and timeoutMs', () => {
  it("takes the task's trials, then the suite's, then the run's as the default", async () => {
    const count = async (taskTrials?: number, suiteTrials?: number, runTrials?: number) => {
      const run = await runEval({
        suites: [
          suite([task(taskTrials === undefined ? {} : { trials: taskTrials })], {
            defaults: suiteTrials === undefined ? undefined : { trials: suiteTrials },
          }),
        ],
        targets: [{ name: 'a', adapter: answers }],
        trials: runTrials,
      });
      return run.trials.length;
    };
    expect(await count(2, 4, 5)).toBe(2);
    expect(await count(undefined, 4, 5)).toBe(4);
    expect(await count(undefined, undefined, 5)).toBe(5);
    expect(await count()).toBe(3);
  });

  it('forces every task to trialsOverride', async () => {
    const run = await runEval({
      suites: [suite([task({ trials: 4 })], { defaults: { trials: 5 } })],
      targets: [{ name: 'a', adapter: answers }],
      trials: 2,
      trialsOverride: 1,
    });
    expect(run.trials).toHaveLength(1);
  });

  it("keeps the task's time limit over the run's", async () => {
    const run = await runEval({
      suites: [suite([task({ timeoutMs: 20 })])],
      targets: [
        {
          name: 'slow',
          adapter: scriptedAdapter({ replies: { t: [{ text: 'a', delayMs: 500 }] } }),
        },
      ],
      trials: 1,
      timeoutMs: 5_000,
    });
    expect(run.trials[0]!.status).toBe('timeout');
  });
});

describe('F7: the suite records its graduation rule', () => {
  it("copies each suite's graduation rule into the run", async () => {
    const run = await runEval({
      suites: [suite([task()], { graduation: { k: 2, runs: 1 } })],
      targets: [{ name: 'a', adapter: answers }],
      trials: 1,
    });
    expect(run.suites[0]!.graduation).toEqual({ k: 2, runs: 1 });
  });
});

describe('F15: an empty transcript', () => {
  it('is written as an empty file', async () => {
    const out = mkdtempSync(join(tmpdir(), 'agent-evals-'));
    dirs.push(out);
    const silent: ChatClient = { complete: () => Promise.resolve({ text: '<<DONE>>' }) };
    const run = await runEval({
      suites: [suite([task({ input: { user: { persona: 'p', goal: 'g' } } })])],
      targets: [{ name: 'a', adapter: answers }],
      trials: 1,
      outDir: out,
      userSimulator: { client: silent },
    });
    expect(run.trials[0]!.transcript).toEqual([]);
    expect(readFileSync(join(out, run.trials[0]!.transcriptFile!), 'utf8')).toBe('');
  });
});

describe('F17: a synchronous throw never escapes runEval', () => {
  const failing = (session: Record<string, unknown>): Adapter => ({
    start: () =>
      Promise.resolve({
        send: () => Promise.reject(new Error('the agent broke')),
        ...session,
      }),
  });

  it('from outcome() after a failed turn', async () => {
    const run = await runEval({
      suites: [suite([task()])],
      targets: [
        {
          name: 'a',
          adapter: failing({
            outcome: () => {
              throw new Error('no outcome');
            },
          }),
        },
      ],
      trials: 1,
    });
    expect(run.trials[0]).toMatchObject({ status: 'agent_error', error: 'the agent broke' });
  });

  it('from close()', async () => {
    const run = await runEval({
      suites: [suite([task()])],
      targets: [
        {
          name: 'a',
          adapter: failing({
            close: () => {
              throw new Error('no close');
            },
          }),
        },
      ],
      trials: 1,
    });
    expect(run.trials[0]!.status).toBe('agent_error');
  });

  it('from afterTrial', async () => {
    const run = await runEval({
      suites: [suite([task()])],
      targets: [{ name: 'a', adapter: answers }],
      trials: 1,
      hooks: {
        afterTrial: () => {
          throw new Error('no undo');
        },
      },
    });
    expect(run.trials[0]).toMatchObject({ status: 'completed', passed: true });
  });

  it('from beforeTrial', async () => {
    const run = await runEval({
      suites: [suite([task()])],
      targets: [{ name: 'a', adapter: answers }],
      trials: 1,
      retries: 0,
      hooks: {
        beforeTrial: () => {
          throw new Error('no seed');
        },
      },
    });
    expect(run.trials[0]).toMatchObject({
      status: 'infra_error',
      error: 'beforeTrial failed: no seed',
    });
  });
});

describe('F18: fixed turns, firstMessage and the simulated user', () => {
  const recording = (said: string[]): Adapter =>
    scriptedAdapter({
      replies: {
        t: (_c, _turn, message) => {
          said.push(message);
          return { text: 'a' };
        },
      },
    });

  const reference = (...users: string[]) => ({
    transcript: users.flatMap((text) => [
      { type: 'message', role: 'user', text },
      { type: 'message', role: 'assistant', text: 'a' },
    ]),
  });

  it('replays the reference user messages after the fixed turns, never a fixed turn again', async () => {
    const said: string[] = [];
    await runEval({
      suites: [
        suite([
          task({
            input: { turns: ['q'], user: { persona: 'p', goal: 'g' } },
            reference: reference('q', 'second'),
          }),
        ]),
      ],
      targets: [{ name: 'a', adapter: recording(said) }],
      trials: 1,
      userSimulator: 'reference',
    });
    expect(said).toEqual(['q', 'second']);
  });

  it('sends firstMessage after the fixed turns, then replays the rest of the reference', async () => {
    const said: string[] = [];
    await runEval({
      suites: [
        suite([
          task({
            input: { turns: ['q'], user: { persona: 'p', goal: 'g', firstMessage: 'first' } },
            reference: reference('q', 'first', 'third'),
          }),
        ]),
      ],
      targets: [{ name: 'a', adapter: recording(said) }],
      trials: 1,
      userSimulator: 'reference',
    });
    expect(said).toEqual(['q', 'first', 'third']);
  });

  it('sends firstMessage after the fixed turns with a model user, which sees the fixed turns', async () => {
    const said: string[] = [];
    const requests: ChatRequest[] = [];
    const userModel: ChatClient = {
      complete(request) {
        requests.push(request);
        return Promise.resolve({ text: requests.length === 1 ? 'more' : '<<DONE>>' });
      },
    };
    await runEval({
      suites: [
        suite([
          task({
            input: { turns: ['q'], user: { persona: 'p', goal: 'g', firstMessage: 'first' } },
          }),
        ]),
      ],
      targets: [{ name: 'a', adapter: recording(said) }],
      trials: 1,
      userSimulator: { client: userModel },
    });
    expect(said).toEqual(['q', 'first', 'more']);
    expect(requests[0]!.messages.slice(1)).toEqual([
      { role: 'assistant', content: 'q' },
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'first' },
      { role: 'user', content: 'a' },
    ]);
  });

  it('a SimulatedUser opens with firstMessage only once', async () => {
    const user = new SimulatedUser(
      { persona: 'p', goal: 'g', firstMessage: 'hi' },
      { complete: () => Promise.resolve({ text: 'next' }) },
    );
    expect(await user.next(null)).toBe('hi');
    expect(await user.next('reply')).toBe('next');
  });
});

describe('F20: hooks have their own time limit', () => {
  it('ends a beforeTrial that hangs as an infrastructure error', async () => {
    const run = await runEval({
      suites: [suite([task()])],
      targets: [{ name: 'a', adapter: answers }],
      trials: 1,
      retries: 0,
      hookTimeoutMs: 30,
      hooks: { beforeTrial: () => new Promise<void>(() => undefined) },
    });
    expect(run.trials[0]!.status).toBe('infra_error');
    expect(run.trials[0]!.error).toMatch(/beforeTrial took longer than 30 ms/);
  });

  it("doesn't count a slow beforeTrial against the trial's time limit", async () => {
    const run = await runEval({
      suites: [suite([task({ timeoutMs: 40 })])],
      targets: [{ name: 'a', adapter: answers }],
      trials: 1,
      hooks: { beforeTrial: () => new Promise<void>((resolve) => setTimeout(resolve, 80)) },
    });
    expect(run.trials[0]).toMatchObject({ status: 'completed', passed: true });
  });

  it('bounds afterTrial by the hook time limit', async () => {
    const started = Date.now();
    const run = await runEval({
      suites: [suite([task()])],
      targets: [{ name: 'a', adapter: answers }],
      trials: 1,
      hookTimeoutMs: 30,
      hooks: { afterTrial: () => new Promise<void>(() => undefined) },
    });
    expect(run.trials[0]!.status).toBe('completed');
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe('F22, F25: a judge that stays down', () => {
  const judgeDown = async () => {
    setJudgeRetryMs(0);
    return runEval({
      suites: [suite([judgedTask])],
      targets: [{ name: 'a', adapter: answers }],
      trials: 1,
      judge: { complete: () => Promise.reject(new InfraError('HTTP 503')) },
    });
  };

  it('is a grading error, apart from the attempts and their infrastructure errors', async () => {
    const run = await judgeDown();
    const [trial] = run.trials;
    expect(trial).toMatchObject({
      status: 'completed',
      attempts: 1,
      infraErrors: [],
      ungraded: true,
      passed: false,
      score: 0,
    });
    expect(trial!.gradingError).toBe('the judge failed: HTTP 503');
  });

  it('is counted apart in the summary', async () => {
    const run = await judgeDown();
    const summary = summarize(run, { k: 1 });
    expect(summary.tasks[0]).toMatchObject({
      n: 0,
      infraErrors: 0,
      infraErrorRate: 0,
      gradingErrors: 1,
      gradingErrorRate: 1,
    });
    expect(summary.groups[0]).toMatchObject({
      graded: 0,
      infraErrors: 0,
      gradingErrors: 1,
      gradingErrorRate: 1,
    });
    expect(summary.groups[0]!.rates.infraError).toBe(0);
  });

  it('is graded again by regrade once the judge is back', async () => {
    const run = await judgeDown();
    const judge: ChatClient = {
      complete: () => Promise.resolve({ text: JSON.stringify({ reason: 'ok', verdict: 'pass' }) }),
    };
    const regraded = await regradeRun(run, {
      suites: [suite([judgedTask])],
      graders: builtinGraders(),
      judge,
    });
    const [trial] = regraded.trials;
    expect(trial!.gradingError).toBeUndefined();
    expect(trial!.ungraded).toBeUndefined();
    expect(trial!.grades).toHaveLength(1);
  });

  it('keeps the grading error when regrade has the judge still down', async () => {
    const run = await judgeDown();
    const regraded = await regradeRun(run, {
      suites: [suite([judgedTask])],
      graders: builtinGraders(),
      judge: { complete: () => Promise.reject(new InfraError('HTTP 502')) },
    });
    expect(regraded.trials[0]).toMatchObject({
      gradingError: 'the judge failed: HTTP 502',
      ungraded: true,
      passed: false,
    });
  });
});

describe('F23: modelGraders skipped', () => {
  it('is not written when no task has a model grader', async () => {
    const run = await runEval({
      suites: [suite([task()])],
      targets: [{ name: 'a', adapter: answers }],
      trials: 1,
      meta: { purpose: 'test' },
    });
    expect(run.meta).toEqual({ purpose: 'test' });
  });

  it('is written when a model grader was skipped', async () => {
    const run = await runEval({
      suites: [suite([judgedTask])],
      targets: [{ name: 'a', adapter: answers }],
      trials: 1,
    });
    expect(run.meta).toEqual({ modelGraders: 'skipped' });
  });

  it("counts the suite's default graders and only the selected tasks", async () => {
    const withDefault = suite([task(), task({ id: 'other' })], {
      defaults: {
        graders: [{ type: 'judge', rubric: { name: 'd', question: 'q?', pass: 'p', fail: 'f' } }],
      },
    });
    const run = await runEval({
      suites: [withDefault],
      targets: [{ name: 'a', adapter: answers }],
      trials: 1,
    });
    expect(run.meta).toEqual({ modelGraders: 'skipped' });
    const none = await runEval({
      suites: [suite([task(), judgedTask].map((t, i) => ({ ...t, id: `t${i}` })))],
      targets: [{ name: 'a', adapter: scriptedAdapter({ replies: { t0: [{ text: 'a' }] } }) }],
      trials: 1,
      tasks: ['t0'],
    });
    expect(none.meta).toBeUndefined();
  });
});

describe('review: a hand-built suite without graders', () => {
  it('is refused by runEval, as loadSuite and defineSuite refuse it', async () => {
    const { runEval: run } = await import('../src/harness/run.ts');
    const { scriptedAdapter: scripted } = await import('../src/adapters/scripted.ts');
    await expect(
      run({
        suites: [
          {
            name: 's',
            kind: 'regression',
            tasks: [{ id: 't', input: { turns: ['q'] }, graders: [] }],
          },
        ],
        targets: [{ name: 'a', adapter: scripted({ replies: { t: [{ text: 'x' }] } }) }],
      }),
    ).rejects.toThrow(/s\/t: the task has no grader/);
  });
});
