import { describe, expect, it } from 'vitest';

import { graduationCandidates } from '../src/metrics/lifecycle.ts';
import { runResult, trialsOf } from './fixtures.ts';

describe('F7: graduationCandidates reads each suite rule', () => {
  const run = (graduation?: { k: number; runs: number }) =>
    runResult(trialsOf(2, 2, { taskId: 'two' }), [
      { name: 'core', kind: 'capability', tasks: ['two'], ...(graduation ? { graduation } : {}) },
    ]);

  it("uses the suite's k and runs when the options leave them out", () => {
    expect(graduationCandidates([run({ k: 2, runs: 1 })]).map((c) => c.taskId)).toEqual(['two']);
    expect(graduationCandidates([run({ k: 2, runs: 1 })], {}).map((c) => c.runs)).toEqual([1]);
  });

  it('defaults to k 3 and 2 runs without a rule', () => {
    expect(graduationCandidates([run(), run()])).toEqual([]);
  });

  it("lets the options override the suite's rule", () => {
    expect(graduationCandidates([run({ k: 2, runs: 1 })], { k: 3 })).toEqual([]);
    expect(graduationCandidates([run({ k: 2, runs: 1 })], { runs: 2 })).toEqual([]);
    expect(
      graduationCandidates([run({ k: 2, runs: 1 })], { k: undefined, runs: undefined }),
    ).toHaveLength(1);
  });

  it('takes the rule from the newest run that has the suite', () => {
    expect(graduationCandidates([run({ k: 3, runs: 1 }), run({ k: 2, runs: 1 })])).toHaveLength(1);
    expect(graduationCandidates([run({ k: 2, runs: 1 }), run({ k: 3, runs: 1 })])).toEqual([]);
  });

  it('applies each suite its own rule within one run', () => {
    const mixed = runResult(
      [
        ...trialsOf(2, 2, { taskId: 'a', suite: 'easy' }),
        ...trialsOf(2, 2, { taskId: 'b', suite: 'strict' }),
      ],
      [
        { name: 'easy', kind: 'capability', tasks: ['a'], graduation: { k: 2, runs: 1 } },
        { name: 'strict', kind: 'capability', tasks: ['b'], graduation: { k: 3, runs: 1 } },
      ],
    );
    expect(graduationCandidates([mixed]).map((c) => c.suite)).toEqual(['easy']);
  });
});
