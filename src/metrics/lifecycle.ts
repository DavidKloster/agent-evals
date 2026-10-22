import type { RunResult } from '../core/types.ts';
import { summarize, type Summary } from './stats.ts';

/** A capability suite's pass@1 at which it gives no signal any more (the default). */
export const DEFAULT_SATURATION_THRESHOLD = 0.9;

export interface SaturationNote {
  suite: string;
  target: string;
  /** pass@1 reached the threshold: the suite needs harder tasks. */
  saturated: boolean;
  pass1: number | null;
  threshold: number;
}

/** Per capability suite and target: whether the suite is saturated. A regression suite is meant to pass, so it never is. */
export function saturation(run: RunResult, summary: Summary): SaturationNote[] {
  const thresholds = new Map(run.suites.map((suite) => [suite.name, suite.saturation?.threshold]));
  return summary.groups
    .filter((group) => group.suiteKind === 'capability')
    .map((group) => {
      const threshold = thresholds.get(group.suite) ?? DEFAULT_SATURATION_THRESHOLD;
      return {
        suite: group.suite,
        target: group.target,
        saturated: group.pass1 !== null && group.pass1 >= threshold,
        pass1: group.pass1,
        threshold,
      };
    });
}

export interface GraduationCandidate {
  suite: string;
  taskId: string;
  /** The runs the verdict rests on. */
  runs: number;
  /** The targets that ran the task in the last of those runs. */
  targets: string[];
}

/** The graduation rule when neither the options nor the suite set one. */
export const DEFAULT_GRADUATION = { k: 3, runs: 2 } as const;

/**
 * Capability tasks that every target passed consistently (pass^k = 1) in each of the last `runs` runs the task ran in:
 * candidates to move to the regression suite. `history` is oldest first. Each suite's `graduation` rule (from the newest
 * run that has the suite) applies; `options.k` and `options.runs` override it for every suite when set.
 */
export function graduationCandidates(
  history: readonly RunResult[],
  options: { k?: number; runs?: number } = {},
): GraduationCandidate[] {
  const rules = new Map<string, { k: number; runs: number }>();
  for (const run of history)
    for (const suite of run.suites) if (suite.graduation) rules.set(suite.name, suite.graduation);
  const ruleOf = (suite: string) => ({
    k: options.k ?? rules.get(suite)?.k ?? DEFAULT_GRADUATION.k,
    runs: options.runs ?? rules.get(suite)?.runs ?? DEFAULT_GRADUATION.runs,
  });
  // Per task, the verdict and targets of each run it ran in, oldest first.
  const verdicts = new Map<
    string,
    { suite: string; taskId: string; perRun: { ok: boolean; targets: string[] }[] }
  >();
  for (const run of history) {
    // One summary per k the run's suites need.
    const summaries = new Map<number, Summary>();
    const summaryFor = (k: number) => {
      let summary = summaries.get(k);
      if (!summary) summaries.set(k, (summary = summarize(run, { k })));
      return summary;
    };
    const ks = new Set(run.trials.map((trial) => ruleOf(trial.suite).k));
    const perTask = new Map<string, { ok: boolean; targets: string[] }>();
    for (const k of ks)
      for (const task of summaryFor(k).tasks) {
        // A target whose trials were all lost to the infrastructure didn't run the task.
        if (task.suiteKind !== 'capability' || task.n === 0 || ruleOf(task.suite).k !== k) continue;
        const key = `${task.suite}\u0000${task.taskId}`;
        const entry = perTask.get(key) ?? { ok: true, targets: [] };
        entry.ok &&= task.passHatK === 1;
        entry.targets.push(task.target);
        perTask.set(key, entry);
        if (!verdicts.has(key))
          verdicts.set(key, { suite: task.suite, taskId: task.taskId, perRun: [] });
      }
    for (const [key, entry] of perTask) verdicts.get(key)!.perRun.push(entry);
  }
  const candidates: GraduationCandidate[] = [];
  for (const { suite, taskId, perRun } of verdicts.values()) {
    const { runs } = ruleOf(suite);
    if (perRun.length < runs) continue;
    const last = perRun.slice(-runs);
    if (last.every((entry) => entry.ok))
      candidates.push({ suite, taskId, runs: last.length, targets: last.at(-1)?.targets ?? [] });
  }
  return candidates;
}
