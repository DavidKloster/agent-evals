import { describe, expect, it } from 'vitest';

import { diffRuns } from '../src/metrics/diff.ts';
import { metrics, runResult, trialResult, trialsOf } from './fixtures.ts';

const kindOf = (diff: ReturnType<typeof diffRuns>, taskId: string, target = 'model-a') =>
  diff.tasks.find((t) => t.taskId === taskId && t.target === target)?.kind;

describe('diffRuns', () => {
  it('classifies regressions, improvements, unchanged, new and removed tasks', () => {
    const before = runResult([
      ...trialsOf(3, 3, { taskId: 'consistent-then-flaky' }),
      ...trialsOf(3, 2, { taskId: 'dropped' }),
      ...trialsOf(3, 0, { taskId: 'fixed' }),
      ...trialsOf(3, 1, { taskId: 'same' }),
      ...trialsOf(3, 3, { taskId: 'gone' }),
    ]);
    const after = runResult([
      ...trialsOf(3, 2, { taskId: 'consistent-then-flaky' }),
      ...trialsOf(3, 0, { taskId: 'dropped' }),
      ...trialsOf(3, 3, { taskId: 'fixed' }),
      ...trialsOf(3, 1, { taskId: 'same' }),
      ...trialsOf(3, 3, { taskId: 'added' }),
    ]);
    const diff = diffRuns(before, after);
    expect(kindOf(diff, 'consistent-then-flaky')).toBe('regression');
    expect(kindOf(diff, 'dropped')).toBe('regression');
    expect(kindOf(diff, 'fixed')).toBe('improvement');
    expect(kindOf(diff, 'same')).toBe('unchanged');
    expect(kindOf(diff, 'added')).toBe('new');
    expect(kindOf(diff, 'gone')).toBe('removed');
    expect(diff.regressions).toBe(2);
    expect(diff.improvements).toBe(1);

    const dropped = diff.tasks.find((t) => t.taskId === 'dropped')!;
    expect(dropped.before?.pass1).toBeCloseTo(2 / 3, 12);
    expect(dropped.after?.pass1).toBe(0);
    expect(dropped.pass1Change).toBeCloseTo(-2 / 3, 12);
    expect(diff.tasks.find((t) => t.taskId === 'added')!.before).toBeNull();
    // Regressions come first.
    expect(diff.tasks[0]!.kind).toBe('regression');
  });

  it('treats a one-in-three drop below 1 as unchanged unless pass^k fell from 1', () => {
    const before = runResult(trialsOf(3, 2));
    const after = runResult(trialsOf(3, 1));
    expect(diffRuns(before, after).tasks[0]!.kind).toBe('unchanged');
    expect(diffRuns(before, after, { minDrop: 0.3 }).tasks[0]!.kind).toBe('regression');
  });

  it('keys tasks by target and suite', () => {
    const before = runResult([...trialsOf(3, 3), ...trialsOf(3, 3, { target: 'model-b' })]);
    const after = runResult([...trialsOf(3, 3), ...trialsOf(3, 0, { target: 'model-b' })]);
    const diff = diffRuns(before, after);
    expect(kindOf(diff, 'task-1', 'model-a')).toBe('unchanged');
    expect(kindOf(diff, 'task-1', 'model-b')).toBe('regression');
  });

  it('marks a task without graded trials on one side as incomparable', () => {
    const before = runResult(trialsOf(3, 3));
    const after = runResult([trialResult({ status: 'infra_error' })]);
    const task = diffRuns(before, after).tasks[0]!;
    expect(task.kind).toBe('incomparable');
    expect(task.pass1Change).toBeNull();
  });

  it('reports group deltas', () => {
    const before = runResult(
      trialsOf(3, 3, { metrics: metrics({ costUsd: 0.01, replyMs: [1000] }) }),
    );
    const after = runResult(
      trialsOf(3, 0, { metrics: metrics({ costUsd: 0.03, replyMs: [1500] }) }),
    );
    const group = diffRuns(before, after).groups[0]!;
    expect(group).toMatchObject({ target: 'model-a', suite: 'core' });
    expect(group.before!.pass1).toBe(1);
    expect(group.after!.pass1).toBe(0);
    expect(group.delta.pass1).toBe(-1);
    expect(group.delta.passHatK).toBe(-1);
    expect(group.delta.costUsd).toBeCloseTo(0.02, 12);
    expect(group.delta.replyP50).toBe(500);
  });
});
