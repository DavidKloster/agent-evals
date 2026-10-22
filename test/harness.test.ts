import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { scriptedAdapter } from '../src/adapters/scripted.ts';
import { defineSuite } from '../src/core/loader.ts';
import type { ChatClient, Suite, TrialContext } from '../src/core/types.ts';
import { runEval } from '../src/harness/run.ts';

const suite = (tasks: unknown[], extra: Partial<Suite> = {}): Suite =>
  defineSuite({ name: 'demo', kind: 'capability', tasks, ...extra });

const lookupTask = {
  id: 'lookup',
  input: { turns: ['Wann ist die Rechnung RE-1 fällig?'] },
  graders: [
    { type: 'tool_called', tool: 'invoices.get', args: { number: 'RE-1' } },
    { type: 'facts', facts: ['11.06.2026'] },
  ],
};

const goodTurn = {
  text: 'Die Rechnung RE-1 ist am 11.06.2026 fällig.',
  events: [
    { type: 'tool_call' as const, id: 'c1', name: 'invoices.get', args: { number: 'RE-1' } },
    { type: 'tool_result' as const, id: 'c1', name: 'invoices.get', result: { due: '2026-06-11' } },
    {
      type: 'model_call' as const,
      model: 'm',
      startedAt: 0,
      endedAt: 1,
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.001,
    },
  ],
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('runEval', () => {
  it('runs every trial of every task and target and grades the transcript', async () => {
    const run = await runEval({
      suites: [suite([lookupTask])],
      targets: [
        { name: 'good', adapter: scriptedAdapter({ replies: { lookup: [goodTurn] } }) },
        {
          name: 'bad',
          adapter: scriptedAdapter({ replies: { lookup: [{ text: 'Das weiß ich nicht.' }] } }),
        },
      ],
      trials: 2,
    });
    expect(run.trials).toHaveLength(4);
    const good = run.trials.filter((t) => t.target === 'good');
    expect(good.every((t) => t.passed && t.score === 1)).toBe(true);
    expect(good[0]!.metrics).toMatchObject({
      turns: 1,
      modelCalls: 1,
      toolCalls: 1,
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.001,
      costComplete: true,
    });
    const bad = run.trials.filter((t) => t.target === 'bad');
    expect(bad.every((t) => !t.passed && t.score === 0)).toBe(true);
  });

  it('retries an infrastructure error, counts it apart and never as the agent failing', async () => {
    let calls = 0;
    const flaky = scriptedAdapter({
      replies: {
        lookup: () => (++calls === 1 ? { text: '', fail: 'infra' } : goodTurn),
      },
    });
    const run = await runEval({
      suites: [suite([lookupTask])],
      targets: [{ name: 'flaky', adapter: flaky }],
      trials: 1,
    });
    const [trial] = run.trials;
    expect(trial).toMatchObject({ status: 'completed', attempts: 2, passed: true });
    expect(trial!.infraErrors).toEqual(['scripted infrastructure error']);
  });

  it('gives up after the retries and reports an infra_error without grades', async () => {
    const run = await runEval({
      suites: [suite([lookupTask])],
      targets: [
        {
          name: 'down',
          adapter: scriptedAdapter({ replies: { lookup: () => ({ text: '', fail: 'infra' }) } }),
        },
      ],
      trials: 1,
      retries: 1,
    });
    expect(run.trials[0]).toMatchObject({
      status: 'infra_error',
      attempts: 2,
      passed: false,
      grades: [],
    });
  });

  it("fails a trial when the agent throws, as the agent's error, and still grades it", async () => {
    const run = await runEval({
      suites: [suite([lookupTask])],
      targets: [
        {
          name: 'x',
          adapter: scriptedAdapter({
            replies: { lookup: [{ text: '', fail: 'TooManyToolRounds' }] },
          }),
        },
      ],
      trials: 1,
    });
    expect(run.trials[0]).toMatchObject({
      status: 'agent_error',
      passed: false,
      error: 'TooManyToolRounds',
    });
    expect(run.trials[0]!.grades.length).toBeGreaterThan(0);
    expect(run.trials[0]!.transcript.at(-1)).toMatchObject({ type: 'error', kind: 'agent' });
  });

  it('aborts a trial at its time limit', async () => {
    const run = await runEval({
      suites: [suite([{ ...lookupTask, timeoutMs: 30 }])],
      targets: [
        {
          name: 'slow',
          adapter: scriptedAdapter({ replies: { lookup: [{ ...goodTurn, delayMs: 5_000 }] } }),
        },
      ],
      trials: 1,
    });
    expect(run.trials[0]).toMatchObject({ status: 'timeout', passed: false });
  });

  it('calls the hooks around every attempt, so each trial starts clean', async () => {
    const log: string[] = [];
    const run = await runEval({
      suites: [suite([lookupTask])],
      targets: [{ name: 'good', adapter: scriptedAdapter({ replies: { lookup: [goodTurn] } }) }],
      trials: 2,
      concurrency: 1,
      hooks: {
        beforeTrial: (c: TrialContext) => void log.push(`before ${c.trial}`),
        afterTrial: (c: TrialContext) => void log.push(`after ${c.trial}`),
      },
    });
    expect(run.trials).toHaveLength(2);
    expect(log).toEqual(['before 0', 'after 0', 'before 1', 'after 1']);
  });

  it('runs no more trials at once than the concurrency', async () => {
    let open = 0;
    let most = 0;
    const adapter = scriptedAdapter({
      replies: {
        lookup: () => ({ ...goodTurn, delayMs: 20 }),
      },
    });
    await runEval({
      suites: [suite([lookupTask])],
      targets: [{ name: 'a', adapter }],
      trials: 6,
      concurrency: 2,
      hooks: {
        beforeTrial: () => void (most = Math.max(most, ++open)),
        afterTrial: () => void open--,
      },
    });
    expect(most).toBe(2);
  });

  it('measures the time to the first token and to the reply per turn', async () => {
    const run = await runEval({
      suites: [suite([lookupTask])],
      targets: [
        {
          name: 'a',
          adapter: scriptedAdapter({ replies: { lookup: [{ ...goodTurn, delayMs: 25 }] } }),
        },
      ],
      trials: 1,
    });
    const { ttftMs, replyMs } = run.trials[0]!.metrics;
    expect(ttftMs[0]).toBeGreaterThanOrEqual(20);
    // The scripted adapter reports its first token at start + delayMs, not measured, and a timer may fire a
    // millisecond early: allow that much (measuring it in the adapter is a follow-up).
    expect(replyMs[0]).toBeGreaterThanOrEqual(ttftMs[0]! - 2);
  });

  it('writes one JSONL transcript per trial', async () => {
    const out = mkdtempSync(join(tmpdir(), 'agent-evals-'));
    dirs.push(out);
    const run = await runEval({
      suites: [suite([lookupTask])],
      targets: [{ name: 'model/a', adapter: scriptedAdapter({ replies: { lookup: [goodTurn] } }) }],
      trials: 1,
      outDir: out,
    });
    const file = run.trials[0]!.transcriptFile!;
    expect(file).toBe('transcripts/demo/model_a/lookup.0.jsonl');
    const lines = readFileSync(join(out, file), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { type: string });
    expect(lines.map((e) => e.type)).toEqual([
      'message',
      'tool_call',
      'tool_result',
      'model_call',
      'message',
    ]);
  });

  it('lets a simulated user carry the conversation until it stops', async () => {
    const said: string[] = [];
    const userModel: ChatClient = {
      complete({ messages }) {
        const fromAgent = messages.filter((m) => m.role === 'user').length;
        return Promise.resolve({ text: fromAgent === 1 ? 'Ich meine RE-1.' : '<<DONE>>' });
      },
    };
    const run = await runEval({
      suites: [
        suite([
          {
            id: 'ambiguous',
            input: {
              turns: ['Wann ist meine Rechnung fällig?'],
              user: { persona: 'Buchhalterin', goal: 'Fälligkeit von RE-1 erfahren' },
            },
            graders: [{ type: 'facts', facts: ['11.06.2026'] }],
          },
        ]),
      ],
      targets: [
        {
          name: 'a',
          adapter: scriptedAdapter({
            replies: {
              ambiguous: (_c, turn, message) => {
                said.push(message);
                return turn === 0 ? { text: 'Welche Rechnung meinen Sie?' } : goodTurn;
              },
            },
          }),
        },
      ],
      trials: 1,
      userSimulator: { client: userModel },
    });
    expect(said).toEqual(['Wann ist meine Rechnung fällig?', 'Ich meine RE-1.']);
    expect(run.trials[0]).toMatchObject({ passed: true });
    expect(run.trials[0]!.metrics.turns).toBe(2);
  });

  it('refuses a task with a simulated user when the run has none', async () => {
    await expect(
      runEval({
        suites: [
          suite([
            {
              id: 'u',
              input: { user: { persona: 'p', goal: 'g' } },
              graders: [{ type: 'no_error' }],
            },
          ]),
        ],
        targets: [{ name: 'a', adapter: scriptedAdapter({}) }],
      }),
    ).rejects.toThrow(/userSimulator/);
  });

  it('applies the suite defaults: graders, trials and scoring with partial credit', async () => {
    const run = await runEval({
      suites: [
        suite([lookupTask], {
          defaults: {
            trials: 1,
            graders: [{ type: 'forbid', patterns: ['re:\\bdu\\b'] }],
            scoring: { mode: 'weighted', threshold: 0.6 },
          },
        }),
      ],
      targets: [
        {
          name: 'half',
          adapter: scriptedAdapter({
            replies: { lookup: [{ ...goodTurn, text: 'Weiß ich nicht, du.' }] },
          }),
        },
      ],
    });
    const [trial] = run.trials;
    expect(trial!.grades.map((g) => g.id)).toEqual(['forbid', 'tool_called', 'facts']);
    expect(trial!.score).toBeCloseTo(1 / 3, 5);
    expect(trial!.passed).toBe(false);
  });
});

describe('runEval: review findings', () => {
  it('closes a session whose start was still pending at the timeout, and ignores what the agent records later', async () => {
    let closed = 0;
    let lateRecord: (() => void) | undefined;
    const slowStart = {
      start: (context: TrialContext) =>
        new Promise<{ send: () => Promise<{ text: string }>; close: () => void }>((resolve) =>
          setTimeout(() => {
            lateRecord = () => context.record({ type: 'note', text: 'late' });
            resolve({ send: () => Promise.resolve({ text: 'x' }), close: () => void closed++ });
          }, 60),
        ),
    };
    const run = await runEval({
      suites: [suite([{ ...lookupTask, timeoutMs: 20 }])],
      targets: [{ name: 'slow', adapter: slowStart }],
      trials: 1,
    });
    expect(run.trials[0]!.status).toBe('timeout');
    expect(closed).toBe(1);
    const before = run.trials[0]!.transcript.length;
    lateRecord!();
    expect(run.trials[0]!.transcript).toHaveLength(before);
  });

  it('counts a failing beforeTrial hook as infrastructure, not as the agent failing', async () => {
    const run = await runEval({
      suites: [suite([lookupTask])],
      targets: [{ name: 'good', adapter: scriptedAdapter({ replies: { lookup: [goodTurn] } }) }],
      trials: 1,
      retries: 0,
      hooks: {
        beforeTrial: () => {
          throw new Error('the seed is gone');
        },
      },
    });
    expect(run.trials[0]).toMatchObject({
      status: 'infra_error',
      error: 'beforeTrial failed: the seed is gone',
    });
  });

  it('marks a trial ungraded when all its graders are model graders and the run has no judge', async () => {
    const run = await runEval({
      suites: [
        suite([
          {
            id: 'judged',
            input: { turns: ['q'] },
            graders: [
              { type: 'judge', rubric: { name: 'd', question: 'q?', pass: 'p', fail: 'f' } },
            ],
          },
        ]),
      ],
      targets: [{ name: 'a', adapter: scriptedAdapter({ replies: { judged: [{ text: 'a' }] } }) }],
      trials: 2,
    });
    expect(run.trials.every((t) => t.ungraded && !t.passed)).toBe(true);
  });

  it("turns a judge that stays down into a grading error of the trial, never the agent's failure", async () => {
    const { setJudgeRetryMs } = await import('../src/graders/judge.ts');
    const { InfraError } = await import('../src/core/types.ts');
    setJudgeRetryMs(0);
    const run = await runEval({
      suites: [
        suite([
          {
            id: 'judged',
            input: { turns: ['q'] },
            graders: [
              { type: 'judge', rubric: { name: 'd', question: 'q?', pass: 'p', fail: 'f' } },
            ],
          },
        ]),
      ],
      targets: [{ name: 'a', adapter: scriptedAdapter({ replies: { judged: [{ text: 'a' }] } }) }],
      trials: 1,
      judge: { complete: () => Promise.reject(new InfraError('HTTP 503')) },
    });
    expect(run.trials[0]).toMatchObject({ status: 'completed', ungraded: true, passed: false });
    expect(run.trials[0]!.gradingError).toMatch(/the judge failed/);
  });
});
