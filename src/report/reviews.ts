import { existsSync, readFileSync } from 'node:fs';

import { parse } from 'yaml';
import { z } from 'zod';

import type { FailureClass, Review, RunResult, TrialResult, TrialStatus } from '../core/types.ts';
import { orderTrials } from '../metrics/stats.ts';

export const reviewSchema = z
  .object({
    suite: z.string().min(1).optional(),
    taskId: z.string().min(1),
    target: z.string().min(1),
    trial: z.number().int().nonnegative().optional(),
    class: z.enum(['agent', 'grader', 'task', 'infra']),
    annotation: z.string().optional(),
    reviewer: z.string().optional(),
  })
  .strict();

const reviewsFileSchema = z.union([
  z.array(reviewSchema),
  z.object({ reviews: z.array(reviewSchema) }).strict(),
]);

/**
 * Reads the reviews a person wrote after reading the transcripts (YAML or JSON): a list, or a list under `reviews`. A
 * missing or empty file means nothing was reviewed yet.
 */
export function loadReviews(file: string): Review[] {
  if (!existsSync(file)) return [];
  const data: unknown = parse(readFileSync(file, 'utf8'));
  if (data === null || data === undefined) return [];
  const parsed = reviewsFileSchema.safeParse(data);
  if (!parsed.success)
    throw new Error(`${file}: not a valid reviews file:\n${z.prettifyError(parsed.error)}`);
  const list = Array.isArray(parsed.data) ? parsed.data : parsed.data.reviews;
  // Drop the keys zod leaves undefined, so a review reads like its file.
  return list.map(
    (review) =>
      Object.fromEntries(
        Object.entries(review).filter(([, v]) => v !== undefined),
      ) as unknown as Review,
  );
}

/** The review of a trial; one that names the trial beats one for every trial, one that names the suite beats one that doesn't. */
export function classify(trial: TrialResult, reviews: readonly Review[]): Review | undefined {
  let best: Review | undefined;
  let bestRank = -1;
  for (const review of reviews) {
    if (review.taskId !== trial.taskId || review.target !== trial.target) continue;
    if (review.suite !== undefined && review.suite !== trial.suite) continue;
    if (review.trial !== undefined && review.trial !== trial.trial) continue;
    const rank = (review.trial !== undefined ? 2 : 0) + (review.suite !== undefined ? 1 : 0);
    if (rank > bestRank) {
      best = review;
      bestRank = rank;
    }
  }
  return best;
}

export interface FailureRow {
  suite: string;
  taskId: string;
  target: string;
  trial: number;
  status: TrialStatus;
  /** What a person found; an infrastructure error is `infra` without a review. */
  class: FailureClass | 'unreviewed';
  annotation?: string;
  reviewer?: string;
  /** The failed assertions and grader errors, as `grader: assertion (message)`. */
  failing: string[];
  error?: string;
  score: number;
}

/** What failed in a trial: each failed assertion of each failed grader, its errors and Unknown verdicts. */
export function failingAssertions(trial: TrialResult): string[] {
  const failing: string[] = [];
  for (const grade of trial.grades) {
    if (grade.passed) continue;
    const before = failing.length;
    if (grade.error !== undefined) failing.push(`${grade.id}: grader error (${grade.error})`);
    if (grade.unknown) failing.push(`${grade.id}: unknown`);
    for (const assertion of grade.assertions)
      if (!assertion.passed)
        failing.push(
          `${grade.id}: ${assertion.name}${assertion.message ? ` (${assertion.message})` : ''}`,
        );
    // A grader can fail on its score alone, with every assertion passed.
    if (failing.length === before) failing.push(`${grade.id}: failed (score ${grade.score})`);
  }
  return failing;
}

/**
 * Every graded trial that didn't pass, in the run's order, with its failure class. Ungraded trials are left out: no
 * grader ran, so they say nothing about the agent ({@link ungradedTrials} lists them).
 */
export function failureTable(run: RunResult, reviews: readonly Review[]): FailureRow[] {
  return orderTrials(run)
    .filter((trial) => !trial.passed && !trial.ungraded)
    .map((trial) => {
      const review = classify(trial, reviews);
      // An infrastructure error is never the agent's, whatever a review says.
      const failureClass =
        trial.status === 'infra_error' ? 'infra' : (review?.class ?? 'unreviewed');
      const row: FailureRow = {
        suite: trial.suite,
        taskId: trial.taskId,
        target: trial.target,
        trial: trial.trial,
        status: trial.status,
        class: failureClass,
        failing: failingAssertions(trial),
        score: trial.score,
      };
      if (review?.annotation !== undefined) row.annotation = review.annotation;
      if (review?.reviewer !== undefined) row.reviewer = review.reviewer;
      if (trial.error !== undefined) row.error = trial.error;
      return row;
    });
}

export interface UngradedRow {
  suite: string;
  taskId: string;
  target: string;
  trial: number;
  status: TrialStatus;
  /** Why it has no verdict: the grading's error (the judge failed), or `no judge` for its model graders. */
  reason: string;
  error?: string;
}

/**
 * The trials without a verdict (every grader of the task is a model grader and the run had no judge, or the grading
 * failed), in the run's order.
 */
export function ungradedTrials(run: RunResult): UngradedRow[] {
  return orderTrials(run)
    .filter((trial) => trial.ungraded)
    .map((trial) => {
      const row: UngradedRow = {
        suite: trial.suite,
        taskId: trial.taskId,
        target: trial.target,
        trial: trial.trial,
        status: trial.status,
        reason: trial.gradingError ?? 'no judge for its model graders',
      };
      if (trial.error !== undefined) row.error = trial.error;
      return row;
    });
}
