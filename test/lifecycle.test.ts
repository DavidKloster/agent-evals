import { describe, expect, it } from 'vitest';

import { graduationCandidates, saturation } from '../src/metrics/lifecycle.ts';
import { summarize } from '../src/metrics/stats.ts';
import { runResult, trialsOf } from './fixtures.ts';

describe('saturation', () => {
  it('flags a capability suite whose pass@1 reaches the threshold', () => {
    const run = runResult([
      ...trialsOf(3, 3, { taskId: 'a' }),
      ...trialsOf(3, 3, { taskId: 'b' }),
      ...trialsOf(3, 1, { taskId: 'a', target: 'model-b' }),
      ...trialsOf(3, 3, { taskId: 'a', suite: 'regress', suiteKind: 'regression' }),
    ]);
    const result = saturation(run, summarize(run));
    expect(result).toEqual([
      { suite: 'core', target: 'model-a', saturated: true, pass1: 1, threshold: 0.9 },
      { suite: 'core', target: 'model-b', saturated: false, pass1: 1 / 3, threshold: 0.9 },
    ]);
  });

  it('takes the threshold from the suite', () => {
    const run = runResult(trialsOf(3, 2), [
      { name: 'core', kind: 'capability', tasks: ['task-1'], saturation: { threshold: 0.6 } },
    ]);
    expect(saturation(run, summarize(run))[0]).toMatchObject({ saturated: true, threshold: 0.6 });
  });
});

describe('graduationCandidates', () => {
  const steady = (c: number) =>
    runResult([
      ...trialsOf(3, 3, { taskId: 'steady' }),
      ...trialsOf(3, 3, { taskId: 'steady', target: 'model-b' }),
      ...trialsOf(3, c, { taskId: 'shaky' }),
      ...trialsOf(3, 3, { taskId: 'reg', suite: 'regress', suiteKind: 'regression' }),
    ]);

  it('finds capability tasks with pass^k = 1 for every target in each of the last runs', () => {
    const history = [steady(1), steady(3), steady(3)];
    expect(graduationCandidates(history)).toEqual([
      { suite: 'core', taskId: 'steady', runs: 2, targets: ['model-a', 'model-b'] },
      { suite: 'core', taskId: 'shaky', runs: 2, targets: ['model-a'] },
    ]);
  });

  it('needs the task in enough runs', () => {
    expect(graduationCandidates([steady(3)])).toEqual([]);
    expect(graduationCandidates([steady(3)], { runs: 1 }).map((c) => c.taskId)).toEqual([
      'steady',
      'shaky',
    ]);
  });

  it('drops a task one target failed in one of the last runs', () => {
    const flaky = runResult([
      ...trialsOf(3, 3, { taskId: 'steady' }),
      ...trialsOf(3, 2, { taskId: 'steady', target: 'model-b' }),
    ]);
    expect(graduationCandidates([steady(3), flaky]).map((c) => c.taskId)).toEqual([]);
    expect(graduationCandidates([flaky, steady(3), steady(3)]).map((c) => c.taskId)).toEqual([
      'steady',
      'shaky',
    ]);
  });

  it('counts only the runs a task ran in', () => {
    const other = runResult(trialsOf(3, 0, { taskId: 'elsewhere' }));
    expect(graduationCandidates([steady(3), other, steady(3)]).map((c) => c.taskId)).toEqual([
      'steady',
      'shaky',
    ]);
  });

  it('needs k graded trials', () => {
    const short = runResult(trialsOf(2, 2));
    expect(graduationCandidates([short, short])).toEqual([]);
  });
});
