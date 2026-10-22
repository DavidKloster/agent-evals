import type { RunResult, SuiteKind, TrialResult, TrialStatus } from '../core/types.ts';

function checkCounts(n: number, c: number, k: number): void {
  if (!Number.isInteger(n) || !Number.isInteger(c) || !Number.isInteger(k))
    throw new Error(`n, c and k must be integers (n=${n}, c=${c}, k=${k})`);
  if (k < 1) throw new Error(`k must be at least 1 (k=${k})`);
  if (c < 0 || c > n) throw new Error(`c must be between 0 and n (n=${n}, c=${c})`);
}

/**
 * The chance that at least one of k trials passes: the unbiased estimator 1 − C(n−c, k) / C(n, k) of Chen et al. (2021).
 * The product form avoids the huge binomials. Null when there are fewer than k trials.
 */
export function passAtK(n: number, c: number, k: number): number | null {
  checkCounts(n, c, k);
  if (n < k) return null;
  if (n - c < k) return 1;
  // C(n−c, k) / C(n, k) = Π_{i=n−c+1..n} (1 − k / i)
  let fail = 1;
  for (let i = n - c + 1; i <= n; i++) fail *= 1 - k / i;
  return 1 - fail;
}

/**
 * The chance that all of k trials drawn without replacement from the n pass: C(c, k) / C(n, k). The consistency metric,
 * the headline for an agent a customer talks to. Null when there are fewer than k trials.
 */
export function passHatK(n: number, c: number, k: number): number | null {
  checkCounts(n, c, k);
  if (n < k) return null;
  if (c < k) return 0;
  // C(c, k) / C(n, k) = Π_{i=0..k−1} (c − i) / (n − i)
  let all = 1;
  for (let i = 0; i < k; i++) all *= (c - i) / (n - i);
  return all;
}

/** The nearest-rank percentile (p in 0..100): always one of the values. Null for no values. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] ?? null;
}

export const p50 = (values: readonly number[]): number | null => percentile(values, 50);
export const p90 = (values: readonly number[]): number | null => percentile(values, 90);

/** The mean, or null for no values. */
export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export type StatusCounts = Record<TrialStatus, number>;

export interface TaskSummary {
  target: string;
  suite: string;
  suiteKind: SuiteKind;
  taskId: string;
  /** Every trial, the ones lost to infrastructure errors included. */
  trials: number;
  /** Graded trials: infrastructure errors are left out, they say nothing about the agent. */
  n: number;
  /** Passed trials among the n. */
  c: number;
  /** c / n; null when every trial was lost to the infrastructure. */
  pass1: number | null;
  passAtK: number | null;
  passHatK: number | null;
  /** The mean partial credit over the n graded trials. */
  score: number | null;
  statuses: StatusCounts;
  /** Attempts that hit an infrastructure error, the retried ones included. */
  infraErrors: number;
  /** infraErrors over all attempts. */
  infraErrorRate: number;
  /** Trials in which a grader threw. */
  graderErrors: number;
  /** Trials whose grading failed (the judge stayed down): ungraded, and not counted in the attempts' infraErrors. */
  gradingErrors: number;
  /** gradingErrors over the trials. */
  gradingErrorRate: number;
}

export interface PerTask {
  turns: number | null;
  modelCalls: number | null;
  toolCalls: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

export interface GroupSummary {
  target: string;
  suite: string;
  suiteKind: SuiteKind;
  tasks: number;
  /** Every trial, the ones lost to infrastructure errors included. */
  trials: number;
  /** Graded trials (n summed over the tasks). */
  graded: number;
  /** The mean of the tasks' pass@1. */
  pass1: number | null;
  /** The mean over the tasks with at least k graded trials. */
  passAtK: number | null;
  passHatK: number | null;
  /** Tasks left out of pass@k and pass^k for having fewer than k graded trials. */
  tasksBelowK: number;
  /** The mean of the tasks' partial credit. */
  score: number | null;
  /** Over every turn of every graded trial. */
  ttftMs: { p50: number | null; p90: number | null };
  replyMs: { p50: number | null; p90: number | null };
  /** Means per graded trial, so per task attempt. */
  perTask: PerTask;
  /** Every graded trial's cost is complete; else the cost is a lower bound. */
  costComplete: boolean;
  /** Over all attempts, the retries after infrastructure errors included. */
  rates: { agentError: number; timeout: number; infraError: number };
  attempts: number;
  infraErrors: number;
  graderErrors: number;
  /** Trials whose grading failed (the judge stayed down), apart from the attempts' infrastructure errors. */
  gradingErrors: number;
  /** gradingErrors over the trials. */
  gradingErrorRate: number;
}

export interface BrokenTaskSuspect {
  suite: string;
  taskId: string;
  /** Graded trials over all targets. */
  trials: number;
  targets: string[];
}

export interface Summary {
  k: number;
  groups: GroupSummary[];
  tasks: TaskSummary[];
  /** Tasks no target passed in at least k trials: a 0 % task is suspected broken before the agents are blamed. */
  brokenTaskSuspects: BrokenTaskSuspect[];
}

// Infrastructure errors and trials no grader ran (model graders without a judge) say nothing about the agent.
const isGraded = (trial: TrialResult) => trial.status !== 'infra_error' && !trial.ungraded;
const hasGraderError = (trial: TrialResult) =>
  trial.grades.some((grade) => grade.error !== undefined);
const gradingErrorsOf = (trials: TrialResult[]) =>
  trials.filter((trial) => trial.gradingError !== undefined).length;
const sumOf = (values: number[]) => values.reduce((sum, value) => sum + value, 0);

/** Groups items by a key, in the order the keys first appear. */
function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const group = groups.get(k);
    if (group) group.push(item);
    else groups.set(k, [item]);
  }
  return groups;
}

/** Sorts trials by the run's order of suites, tasks and targets, so the report follows the configuration. */
export function orderTrials(run: RunResult): TrialResult[] {
  const suiteIndex = new Map(run.suites.map((suite, index) => [suite.name, index]));
  const taskIndex = new Map(
    run.suites.flatMap((suite) =>
      suite.tasks.map((task, index) => [`${suite.name}\u0000${task}`, index] as const),
    ),
  );
  const targetIndex = new Map(run.targets.map((target, index) => [target.name, index]));
  const at = (map: Map<string, number>, key: string) => map.get(key) ?? Number.MAX_SAFE_INTEGER;
  return run.trials
    .map((trial, index) => ({ trial, index }))
    .sort(
      (a, b) =>
        at(suiteIndex, a.trial.suite) - at(suiteIndex, b.trial.suite) ||
        at(targetIndex, a.trial.target) - at(targetIndex, b.trial.target) ||
        at(taskIndex, `${a.trial.suite}\u0000${a.trial.taskId}`) -
          at(taskIndex, `${b.trial.suite}\u0000${b.trial.taskId}`) ||
        a.trial.trial - b.trial.trial ||
        a.index - b.index,
    )
    .map(({ trial }) => trial);
}

function summarizeTask(trials: TrialResult[], k: number, kind: SuiteKind): TaskSummary {
  const first = trials[0]!;
  const graded = trials.filter(isGraded);
  const n = graded.length;
  const c = graded.filter((trial) => trial.passed).length;
  const attempts = sumOf(trials.map((trial) => trial.attempts));
  const infraErrors = sumOf(trials.map((trial) => trial.infraErrors.length));
  const statuses: StatusCounts = { completed: 0, agent_error: 0, timeout: 0, infra_error: 0 };
  for (const trial of trials) statuses[trial.status]++;
  const gradingErrors = gradingErrorsOf(trials);
  return {
    target: first.target,
    suite: first.suite,
    suiteKind: kind,
    taskId: first.taskId,
    trials: trials.length,
    n,
    c,
    pass1: n === 0 ? null : c / n,
    passAtK: passAtK(n, c, k),
    passHatK: passHatK(n, c, k),
    score: mean(graded.map((trial) => trial.score)),
    statuses,
    infraErrors,
    infraErrorRate: attempts === 0 ? 0 : infraErrors / attempts,
    graderErrors: trials.filter(hasGraderError).length,
    gradingErrors,
    gradingErrorRate: gradingErrors / trials.length,
  };
}

const meanOrNull = (values: (number | null)[]) =>
  mean(values.filter((value): value is number => value !== null));

function summarizeGroup(
  trials: TrialResult[],
  tasks: TaskSummary[],
  kind: SuiteKind,
): GroupSummary {
  const first = trials[0]!;
  const graded = trials.filter(isGraded);
  const attempts = sumOf(trials.map((trial) => trial.attempts));
  const infraErrors = sumOf(trials.map((trial) => trial.infraErrors.length));
  const rate = (count: number) => (attempts === 0 ? 0 : count / attempts);
  const withK = tasks.filter((task) => task.passHatK !== null);
  const ttft = graded.flatMap((trial) => trial.metrics.ttftMs);
  const reply = graded.flatMap((trial) => trial.metrics.replyMs);
  const perTrial = (pick: (trial: TrialResult) => number) => mean(graded.map(pick));
  const gradingErrors = gradingErrorsOf(trials);
  return {
    target: first.target,
    suite: first.suite,
    suiteKind: kind,
    tasks: tasks.length,
    trials: trials.length,
    graded: graded.length,
    pass1: meanOrNull(tasks.map((task) => task.pass1)),
    passAtK: meanOrNull(withK.map((task) => task.passAtK)),
    passHatK: meanOrNull(withK.map((task) => task.passHatK)),
    tasksBelowK: tasks.length - withK.length,
    score: meanOrNull(tasks.map((task) => task.score)),
    ttftMs: { p50: p50(ttft), p90: p90(ttft) },
    replyMs: { p50: p50(reply), p90: p90(reply) },
    perTask: {
      turns: perTrial((trial) => trial.metrics.turns),
      modelCalls: perTrial((trial) => trial.metrics.modelCalls),
      toolCalls: perTrial((trial) => trial.metrics.toolCalls),
      inputTokens: perTrial((trial) => trial.metrics.inputTokens),
      outputTokens: perTrial((trial) => trial.metrics.outputTokens),
      costUsd: perTrial((trial) => trial.metrics.costUsd),
    },
    costComplete: graded.every((trial) => trial.metrics.costComplete),
    rates: {
      agentError: rate(trials.filter((trial) => trial.status === 'agent_error').length),
      timeout: rate(trials.filter((trial) => trial.status === 'timeout').length),
      infraError: rate(infraErrors),
    },
    attempts,
    infraErrors,
    graderErrors: trials.filter(hasGraderError).length,
    gradingErrors,
    gradingErrorRate: gradingErrors / trials.length,
  };
}

/**
 * The run's numbers per task and per group (target × suite). Trials lost to infrastructure errors are left out of n and
 * c and counted apart, so a flaky eval stack never reads as a failing agent.
 */
export function summarize(run: RunResult, { k = 3 }: { k?: number } = {}): Summary {
  if (!Number.isInteger(k) || k < 1) throw new Error(`k must be a positive integer (k=${k})`);
  const ordered = orderTrials(run);
  // The run's suite list is the authority on a suite's kind; a trial's copy is the fallback.
  const kinds = new Map(run.suites.map((suite) => [suite.name, suite.kind]));
  const kindOf = (trial: TrialResult) => kinds.get(trial.suite) ?? trial.suiteKind;
  const byTask = groupBy(
    ordered,
    (trial) => `${trial.suite}\u0000${trial.target}\u0000${trial.taskId}`,
  );
  const tasks = [...byTask.values()].map((trials) => summarizeTask(trials, k, kindOf(trials[0]!)));
  const tasksByGroup = groupBy(tasks, (task) => `${task.suite}\u0000${task.target}`);
  const trialsByGroup = groupBy(ordered, (trial) => `${trial.suite}\u0000${trial.target}`);
  const groups = [...trialsByGroup.entries()].map(([key, trials]) =>
    summarizeGroup(trials, tasksByGroup.get(key) ?? [], kindOf(trials[0]!)),
  );

  const brokenTaskSuspects: BrokenTaskSuspect[] = [];
  for (const summaries of groupBy(tasks, (task) => `${task.suite}\u0000${task.taskId}`).values()) {
    const first = summaries[0]!;
    const trials = sumOf(summaries.map((task) => task.n));
    const passes = sumOf(summaries.map((task) => task.c));
    if (passes === 0 && trials >= k)
      brokenTaskSuspects.push({
        suite: first.suite,
        taskId: first.taskId,
        trials,
        targets: summaries.map((task) => task.target),
      });
  }
  return { k, groups, tasks, brokenTaskSuspects };
}
