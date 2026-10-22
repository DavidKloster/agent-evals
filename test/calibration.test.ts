import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type {
  GraderResult,
  HumanLabel,
  RunResult,
  TrialResult,
  Verdict,
} from '../src/core/types.ts';
import {
  calibrate,
  cohensKappa,
  labellingSheet,
  loadLabels,
  writeLabellingSheet,
} from '../src/metrics/calibration.ts';

function judgeGrade(verdicts: Record<string, Verdict>, id = 'judge'): GraderResult {
  return {
    id,
    type: 'judge',
    score: 0,
    passed: false,
    weight: 1,
    required: false,
    assertions: [],
    details: {
      dimensions: Object.entries(verdicts).map(([name, verdict]) => ({
        name,
        question: `Is it ${name}?`,
        verdict,
        reason: `judge says ${verdict}`,
        votes: [],
      })),
    },
  };
}

function trial(taskId: string, n: number, grades: GraderResult[]): TrialResult {
  return {
    suite: 's',
    suiteKind: 'capability',
    taskId,
    target: 'm',
    trial: n,
    status: 'completed',
    attempts: 1,
    infraErrors: [],
    outcome: undefined,
    grades,
    score: 0,
    passed: false,
    metrics: {
      durationMs: 0,
      ttftMs: [],
      replyMs: [],
      turns: 1,
      modelCalls: 0,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      costComplete: true,
    },
    transcript: [
      { type: 'message', at: 1, role: 'user', text: `question ${taskId}` },
      { type: 'message', at: 2, role: 'assistant', text: `answer ${taskId}/${n}` },
    ],
    startedAt: '2026-10-22T00:00:00Z',
  };
}

const run: RunResult = {
  id: 'r',
  startedAt: '',
  finishedAt: '',
  targets: [{ name: 'm' }],
  suites: [],
  trials: [
    trial('a', 0, [judgeGrade({ correct: 'pass', tone: 'pass' })]),
    trial('a', 1, [judgeGrade({ correct: 'fail', tone: 'pass' })]),
    trial('b', 0, [judgeGrade({ correct: 'pass', tone: 'unknown' })]),
    trial('b', 1, [judgeGrade({ correct: 'fail', tone: 'fail' })]),
    trial('c', 0, []),
  ],
};

const label = (taskId: string, n: number, dimension: string, l: Verdict): HumanLabel => ({
  suite: 's',
  taskId,
  target: 'm',
  trial: n,
  grader: 'judge',
  dimension,
  label: l,
});

describe('labellingSheet', () => {
  it('lists every judged dimension with an unknown label and without the judge verdict', () => {
    const sheet = labellingSheet(run);
    expect(sheet).toHaveLength(8);
    expect(sheet[0]).toMatchObject({
      taskId: 'a',
      trial: 0,
      grader: 'judge',
      dimension: 'correct',
      question: 'Is it correct?',
      input: 'question a',
      answer: 'answer a/0',
      label: 'unknown',
    });
    expect(JSON.stringify(sheet)).not.toContain('judge says');
    expect(sheet.some((e) => e.taskId === 'c')).toBe(false);
  });

  it('samples trials deterministically by seed', () => {
    const one = labellingSheet(run, { sample: 2, seed: 7 });
    expect(one).toHaveLength(4);
    expect(labellingSheet(run, { sample: 2, seed: 7 })).toEqual(one);
    const trials = (seed: number) =>
      new Set(labellingSheet(run, { sample: 2, seed }).map((e) => `${e.taskId}/${e.trial}`));
    const seen = new Set([1, 2, 3, 4, 5, 6, 7, 8].map((seed) => [...trials(seed)].join(',')));
    expect(seen.size).toBeGreaterThan(1);
  });

  it('filters by grader id', () => {
    const other: RunResult = {
      ...run,
      trials: [trial('x', 0, [judgeGrade({ d: 'pass' }, 'judge#2')])],
    };
    expect(labellingSheet(other, { grader: 'judge' })).toHaveLength(0);
    expect(labellingSheet(other, { grader: 'judge#2' })).toHaveLength(1);
  });
});

describe('label files', () => {
  const dir = mkdtemp(join(tmpdir(), 'agent-evals-labels-'));
  afterAll(async () => rm(await dir, { recursive: true, force: true }));

  it('writes a sheet a person fills in and reads it back as labels', async () => {
    const file = join(await dir, 'nested', 'labels.yaml');
    writeLabellingSheet(file, labellingSheet(run, { sample: 1, seed: 3 }));
    const text = await readFile(file, 'utf8');
    expect(text).toMatch(/^# Labelling sheet/);
    expect(text).toContain('label: unknown');
    await writeFile(
      file,
      text.replaceAll('label: unknown', 'label: pass').replaceAll('labeller: ""', 'labeller: anna'),
    );
    const labels = loadLabels(file);
    expect(labels).toHaveLength(2);
    expect(labels[0]).toEqual({
      suite: 's',
      taskId: labels[0]!.taskId,
      target: 'm',
      trial: labels[0]!.trial,
      grader: 'judge',
      dimension: 'correct',
      label: 'pass',
      labeller: 'anna',
    });
  });

  it('reads JSON with a labels key and rejects invalid labels', async () => {
    const file = join(await dir, 'labels.json');
    await writeFile(file, JSON.stringify({ labels: [label('a', 0, 'correct', 'fail')] }));
    expect(loadLabels(file)).toEqual([label('a', 0, 'correct', 'fail')]);
    await writeFile(file, JSON.stringify([{ ...label('a', 0, 'correct', 'fail'), label: 'yes' }]));
    expect(() => loadLabels(file)).toThrow(/invalid labels: 0\.label/);
  });
});

describe('calibrate', () => {
  it('computes agreement, kappa, the unknown rate and the confusion per dimension', () => {
    const report = calibrate(run, [
      label('a', 0, 'correct', 'pass'),
      label('a', 1, 'correct', 'fail'),
      label('b', 0, 'correct', 'fail'),
      label('b', 1, 'correct', 'fail'),
      label('a', 0, 'tone', 'pass'),
      label('b', 0, 'tone', 'pass'),
      label('c', 0, 'tone', 'pass'),
    ]);
    const correct = report.dimensions.find((d) => d.dimension === 'correct')!;
    expect(correct).toMatchObject({ grader: 'judge', n: 4, agreement: 0.75, unknownRate: 0 });
    // po = 0.75; judge passes 2/4, human 1/4: pe = 0.5 * 0.25 + 0.5 * 0.75 = 0.5; kappa = 0.5.
    expect(correct.kappa).toBe(0.5);
    expect(correct.confusion).toEqual([
      { judge: 'fail', human: 'fail', count: 2 },
      { judge: 'pass', human: 'fail', count: 1 },
      { judge: 'pass', human: 'pass', count: 1 },
    ]);
    const tone = report.dimensions.find((d) => d.dimension === 'tone')!;
    // The unlabelled trial c has no judge verdict: it stays in the sample, out of n.
    expect(tone).toMatchObject({ n: 2, agreement: 0.5, unknownRate: 0.5, kappa: null });
    expect(report.sample).toHaveLength(7);
    expect(report.sample.find((s) => s.taskId === 'b' && s.dimension === 'tone')).toMatchObject({
      judge: 'unknown',
      judgeReason: 'judge says unknown',
    });
    expect(report.sample.find((s) => s.taskId === 'c')?.judge).toBeNull();
  });

  it('gives nulls for a dimension without judged labels', () => {
    const report = calibrate(run, [label('c', 0, 'correct', 'pass')]);
    expect(report.dimensions[0]).toMatchObject({
      n: 0,
      agreement: null,
      kappa: null,
      unknownRate: null,
      confusion: [],
    });
  });

  it('kappa is 1 for perfect agreement and null when chance agreement is 1', () => {
    expect(
      cohensKappa([
        { judge: 'pass', human: 'pass' },
        { judge: 'fail', human: 'fail' },
      ]),
    ).toBe(1);
    expect(
      cohensKappa([
        { judge: 'pass', human: 'pass' },
        { judge: 'pass', human: 'pass' },
      ]),
    ).toBeNull();
    expect(cohensKappa([{ judge: 'unknown', human: 'pass' }])).toBeNull();
    expect(
      cohensKappa([
        { judge: 'pass', human: 'fail' },
        { judge: 'fail', human: 'pass' },
      ]),
    ).toBe(-1);
  });
});

describe('calibrate: entries nobody filled in', () => {
  it('leaves human unknowns out of n, agreement and kappa, and counts them apart', async () => {
    const { calibrate } = await import('../src/metrics/calibration.ts');
    const { runResult, trialResult } = await import('./fixtures.ts');
    const judged = (trial: number, verdict: 'pass' | 'fail') =>
      trialResult({
        taskId: 't',
        target: 'm',
        trial,
        grades: [
          {
            id: 'judge',
            type: 'judge',
            score: verdict === 'pass' ? 1 : 0,
            passed: verdict === 'pass',
            weight: 1,
            required: false,
            assertions: [],
            details: { dimensions: [{ name: 'd', question: 'q', verdict, reason: '', votes: [] }] },
          },
        ],
      });
    const run = runResult([judged(0, 'pass'), judged(1, 'fail')]);
    const label = (trial: number, value: 'pass' | 'fail' | 'unknown') => ({
      taskId: 't',
      target: 'm',
      trial,
      grader: 'judge',
      dimension: 'd',
      label: value,
    });
    const report = calibrate(run, [label(0, 'pass'), label(1, 'unknown')]);
    expect(report.dimensions[0]).toMatchObject({ n: 1, agreement: 1, humanUnknown: 1 });
  });
});
