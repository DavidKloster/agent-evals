import { describe, expect, it } from 'vitest';

import { p50, p90, passAtK, passHatK, percentile, summarize } from '../src/metrics/stats.ts';
import { graderResult, metrics, runResult, trialResult, trialsOf } from './fixtures.ts';

describe('passAtK', () => {
  it('is c/n for k = 1', () => {
    expect(passAtK(10, 5, 1)).toBeCloseTo(0.5, 12);
    expect(passAtK(3, 1, 1)).toBeCloseTo(1 / 3, 12);
  });

  it('matches 1 - C(n-c,k)/C(n,k)', () => {
    // C(5,3)/C(10,3) = 10/120
    expect(passAtK(10, 5, 3)).toBeCloseTo(1 - 10 / 120, 12);
  });

  it('is 1 when fewer than k trials failed', () => {
    expect(passAtK(10, 8, 3)).toBe(1);
  });

  it('is 1 when every trial passed and 0 when none did', () => {
    expect(passAtK(5, 5, 3)).toBe(1);
    expect(passAtK(5, 0, 3)).toBe(0);
  });

  it('is null when there are fewer trials than k', () => {
    expect(passAtK(2, 2, 3)).toBeNull();
    expect(passAtK(0, 0, 1)).toBeNull();
  });

  it('stays finite for large n', () => {
    const value = passAtK(1000, 10, 100);
    expect(value).not.toBeNull();
    expect(value!).toBeGreaterThan(0);
    expect(value!).toBeLessThanOrEqual(1);
  });

  it('rejects impossible counts', () => {
    expect(() => passAtK(3, 4, 1)).toThrow();
    expect(() => passAtK(3, 1, 0)).toThrow();
  });
});

describe('passHatK', () => {
  it('is c/n for k = 1', () => {
    expect(passHatK(10, 5, 1)).toBeCloseTo(0.5, 12);
  });

  it('matches C(c,k)/C(n,k)', () => {
    // C(5,3)/C(10,3) = 10/120
    expect(passHatK(10, 5, 3)).toBeCloseTo(10 / 120, 12);
  });

  it('is 1 for n = k only when all pass', () => {
    expect(passHatK(3, 3, 3)).toBe(1);
    expect(passHatK(3, 2, 3)).toBe(0);
  });

  it('is 1 when every trial passed and 0 when none did', () => {
    expect(passHatK(7, 7, 3)).toBe(1);
    expect(passHatK(7, 0, 3)).toBe(0);
  });

  it('is null when there are fewer trials than k', () => {
    expect(passHatK(2, 2, 3)).toBeNull();
  });
});

describe('percentile', () => {
  it('uses the nearest rank', () => {
    const values = [15, 20, 35, 40, 50];
    expect(percentile(values, 30)).toBe(20);
    expect(percentile(values, 40)).toBe(20);
    expect(percentile(values, 50)).toBe(35);
    expect(percentile(values, 100)).toBe(50);
    expect(percentile(values, 0)).toBe(15);
  });

  it('does not depend on the order and is null for no values', () => {
    expect(p50([5, 1, 3])).toBe(3);
    expect(p90(Array.from({ length: 10 }, (_, i) => 10 - i))).toBe(9);
    expect(p50([])).toBeNull();
  });
});

describe('summarize', () => {
  it('summarizes a task per target and suite', () => {
    const run = runResult([
      ...trialsOf(3, 3, { taskId: 'a' }),
      ...trialsOf(3, 1, { taskId: 'b' }),
      ...trialsOf(3, 0, { taskId: 'a', target: 'model-b' }),
    ]);
    const summary = summarize(run);
    expect(summary.k).toBe(3);
    expect(summary.tasks).toHaveLength(3);
    const b = summary.tasks.find((t) => t.taskId === 'b' && t.target === 'model-a')!;
    expect(b).toMatchObject({ n: 3, c: 1, passHatK: 0, passAtK: 1, suite: 'core' });
    expect(b.pass1).toBeCloseTo(1 / 3, 12);
    expect(b.statuses.completed).toBe(3);

    const groupA = summary.groups.find((g) => g.target === 'model-a')!;
    expect(groupA.tasks).toBe(2);
    expect(groupA.trials).toBe(6);
    expect(groupA.pass1).toBeCloseTo((1 + 1 / 3) / 2, 12);
    expect(groupA.passHatK).toBeCloseTo(0.5, 12);
    expect(groupA.passAtK).toBe(1);
    const groupB = summary.groups.find((g) => g.target === 'model-b')!;
    expect(groupB.pass1).toBe(0);
  });

  it('keeps infrastructure errors out of n and c and reports them apart', () => {
    const run = runResult([...trialsOf(3, 3), trialResult({ trial: 3, status: 'infra_error' })]);
    const summary = summarize(run);
    const task = summary.tasks[0]!;
    expect(task.n).toBe(3);
    expect(task.c).toBe(3);
    expect(task.trials).toBe(4);
    expect(task.passHatK).toBe(1);
    expect(task.infraErrors).toBe(3);
    // 3 failed attempts of 6 attempts in all.
    expect(task.infraErrorRate).toBeCloseTo(0.5, 12);
    expect(task.statuses.infra_error).toBe(1);
    const group = summary.groups[0]!;
    expect(group.pass1).toBe(1);
    expect(group.rates.infraError).toBeCloseTo(0.5, 12);
    expect(group.rates.agentError).toBe(0);
  });

  it('counts agent errors, timeouts and grader errors', () => {
    const run = runResult([
      trialResult({ trial: 0, status: 'agent_error' }),
      trialResult({ trial: 1, status: 'timeout' }),
      trialResult({
        trial: 2,
        passed: false,
        grades: [graderResult({ passed: false, error: 'boom' })],
      }),
      trialResult({ trial: 3 }),
    ]);
    const group = summarize(run).groups[0]!;
    expect(group.rates.agentError).toBeCloseTo(0.25, 12);
    expect(group.rates.timeout).toBeCloseTo(0.25, 12);
    expect(group.graderErrors).toBe(1);
    expect(group.pass1).toBeCloseTo(0.25, 12);
  });

  it('leaves tasks with fewer than k trials out of pass@k and pass^k', () => {
    const run = runResult([...trialsOf(3, 3, { taskId: 'a' }), ...trialsOf(2, 2, { taskId: 'b' })]);
    const summary = summarize(run);
    const group = summary.groups[0]!;
    expect(summary.tasks.find((t) => t.taskId === 'b')!.passHatK).toBeNull();
    expect(group.passHatK).toBe(1);
    expect(group.tasksBelowK).toBe(1);
    expect(group.pass1).toBe(1);
  });

  it('honours k', () => {
    const summary = summarize(runResult(trialsOf(3, 2)), { k: 1 });
    expect(summary.k).toBe(1);
    expect(summary.tasks[0]!.passHatK).toBeCloseTo(2 / 3, 12);
  });

  it('reports latency percentiles, means per task and partial credit', () => {
    const run = runResult([
      trialResult({
        trial: 0,
        score: 0.5,
        passed: false,
        metrics: metrics({
          ttftMs: [100, 300],
          replyMs: [1000, 2000],
          costUsd: 0.01,
          inputTokens: 100,
          toolCalls: 2,
        }),
      }),
      trialResult({
        trial: 1,
        score: 1,
        metrics: metrics({
          ttftMs: [200],
          replyMs: [3000],
          costUsd: 0.03,
          inputTokens: 300,
          toolCalls: 4,
          costComplete: false,
        }),
      }),
    ]);
    const group = summarize(run).groups[0]!;
    expect(group.ttftMs).toEqual({ p50: 200, p90: 300 });
    expect(group.replyMs).toEqual({ p50: 2000, p90: 3000 });
    expect(group.score).toBeCloseTo(0.75, 12);
    expect(group.perTask.costUsd).toBeCloseTo(0.02, 12);
    expect(group.perTask.inputTokens).toBe(200);
    expect(group.perTask.toolCalls).toBe(3);
    expect(group.costComplete).toBe(false);
  });

  it('orders groups by the run suites and targets', () => {
    const run = runResult(
      [
        trialResult({ target: 'b', suite: 's2' }),
        trialResult({ target: 'a', suite: 's1' }),
        trialResult({ target: 'a', suite: 's2' }),
      ],
      [
        { name: 's1', kind: 'capability', tasks: ['task-1'] },
        { name: 's2', kind: 'regression', tasks: ['task-1'] },
      ],
      { targets: [{ name: 'a' }, { name: 'b' }] },
    );
    const groups = summarize(run).groups.map((g) => `${g.suite}/${g.target}`);
    expect(groups).toEqual(['s1/a', 's2/a', 's2/b']);
    expect(summarize(run).groups[1]!.suiteKind).toBe('regression');
  });

  it('suspects a task that no target ever passed', () => {
    const run = runResult([
      ...trialsOf(2, 0, { taskId: 'broken' }),
      ...trialsOf(2, 0, { taskId: 'broken', target: 'model-b' }),
      ...trialsOf(3, 0, { taskId: 'hard' }),
      ...trialsOf(3, 1, { taskId: 'hard', target: 'model-b' }),
      ...trialsOf(2, 0, { taskId: 'few' }),
    ]);
    const suspects = summarize(run).brokenTaskSuspects;
    expect(suspects).toEqual([
      { suite: 'core', taskId: 'broken', trials: 4, targets: ['model-a', 'model-b'] },
    ]);
  });
});
