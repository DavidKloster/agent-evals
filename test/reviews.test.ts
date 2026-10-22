import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { Review } from '../src/core/types.ts';
import { classify, failureTable, loadReviews } from '../src/report/reviews.ts';
import { graderResult, runResult, trialResult } from './fixtures.ts';

const dir = mkdtempSync(join(tmpdir(), 'agent-evals-reviews-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('loadReviews', () => {
  it('reads a YAML list', () => {
    const file = join(dir, 'reviews.yaml');
    writeFileSync(
      file,
      [
        '- taskId: find-invoice',
        '  target: model-a',
        '  trial: 1',
        '  class: agent',
        '  annotation: Searched the wrong vendor.',
        '- taskId: find-invoice',
        '  target: model-b',
        '  class: grader',
      ].join('\n'),
    );
    expect(loadReviews(file)).toEqual([
      {
        taskId: 'find-invoice',
        target: 'model-a',
        trial: 1,
        class: 'agent',
        annotation: 'Searched the wrong vendor.',
      },
      { taskId: 'find-invoice', target: 'model-b', class: 'grader' },
    ]);
  });

  it('reads JSON and a list under `reviews`', () => {
    const file = join(dir, 'reviews.json');
    writeFileSync(file, JSON.stringify({ reviews: [{ taskId: 't', target: 'a', class: 'task' }] }));
    expect(loadReviews(file)).toEqual([{ taskId: 't', target: 'a', class: 'task' }]);
  });

  it('returns no reviews for a missing or empty file', () => {
    expect(loadReviews(join(dir, 'missing.yaml'))).toEqual([]);
    const empty = join(dir, 'empty.yaml');
    writeFileSync(empty, '');
    expect(loadReviews(empty)).toEqual([]);
  });

  it('rejects an unknown class with the file in the message', () => {
    const file = join(dir, 'bad.yaml');
    writeFileSync(file, '- taskId: t\n  target: a\n  class: model\n');
    expect(() => loadReviews(file)).toThrow(/bad\.yaml/);
  });
});

describe('classify', () => {
  const reviews: Review[] = [
    { taskId: 'task-1', target: 'model-a', class: 'grader', annotation: 'all trials' },
    { taskId: 'task-1', target: 'model-a', trial: 2, class: 'agent', annotation: 'trial 2' },
    { taskId: 'task-1', target: 'model-a', suite: 'other', trial: 0, class: 'task' },
  ];

  it('prefers the review of the trial', () => {
    expect(classify(trialResult({ trial: 2 }), reviews)?.annotation).toBe('trial 2');
    expect(classify(trialResult({ trial: 1 }), reviews)?.annotation).toBe('all trials');
  });

  it('matches the suite when the review names one', () => {
    expect(classify(trialResult({ trial: 0 }), reviews)?.class).toBe('grader');
    expect(classify(trialResult({ trial: 0, suite: 'other' }), reviews)?.class).toBe('task');
  });

  it('returns undefined without a matching review', () => {
    expect(classify(trialResult({ target: 'model-b' }), reviews)).toBeUndefined();
  });
});

describe('failureTable', () => {
  it('lists every trial that did not pass with its class', () => {
    const run = runResult([
      trialResult({ trial: 0 }),
      trialResult({
        trial: 1,
        passed: false,
        grades: [
          graderResult({
            id: 'answer',
            passed: false,
            assertions: [{ name: 'mentions the total', passed: false, message: 'no total' }],
          }),
          graderResult({ id: 'tools', passed: true }),
        ],
      }),
      trialResult({ trial: 2, status: 'timeout' }),
      trialResult({ trial: 3, status: 'infra_error' }),
    ]);
    const rows = failureTable(run, [
      {
        taskId: 'task-1',
        target: 'model-a',
        trial: 1,
        class: 'agent',
        annotation: 'Forgot the total.',
      },
    ]);
    expect(rows.map((row) => [row.trial, row.class])).toEqual([
      [1, 'agent'],
      [2, 'unreviewed'],
      [3, 'infra'],
    ]);
    expect(rows[0]).toMatchObject({ annotation: 'Forgot the total.', status: 'completed' });
    expect(rows[0]!.failing).toEqual(['answer: mentions the total (no total)']);
  });

  it('classifies an infrastructure error as infra whatever a review says', () => {
    const run = runResult([trialResult({ status: 'infra_error' })]);
    expect(
      failureTable(run, [{ taskId: 'task-1', target: 'model-a', class: 'agent' }])[0]!.class,
    ).toBe('infra');
  });
});
