import type { RunResult } from '../core/types.ts';
import { summarize, type GroupSummary, type Summary, type TaskSummary } from './stats.ts';

/**
 * - `regression`: pass^k fell from 1, or pass@1 dropped by at least `minDrop`;
 * - `improvement`: pass^k rose to 1, or pass@1 rose by at least `minDrop`;
 * - `incomparable`: one side has no graded trial (every trial was lost to the infrastructure).
 */
export type ChangeKind =
  'regression' | 'improvement' | 'unchanged' | 'new' | 'removed' | 'incomparable';

export interface TaskSide {
  n: number;
  c: number;
  pass1: number | null;
  passHatK: number | null;
}

export interface TaskDiff {
  suite: string;
  target: string;
  taskId: string;
  kind: ChangeKind;
  before: TaskSide | null;
  after: TaskSide | null;
  /** after − before of pass@1; null when either side has none. */
  pass1Change: number | null;
}

export interface GroupSide {
  pass1: number | null;
  passHatK: number | null;
  /** Mean USD per task. */
  costUsd: number | null;
  replyP50: number | null;
}

export interface GroupDiff {
  suite: string;
  target: string;
  before: GroupSide | null;
  after: GroupSide | null;
  /** after − before; null where either side is missing. */
  delta: {
    pass1: number | null;
    passHatK: number | null;
    costUsd: number | null;
    replyP50: number | null;
  };
}

export interface RunDiff {
  before: string;
  after: string;
  k: number;
  minDrop: number;
  /** Regressions first, then improvements, new, removed, incomparable and unchanged tasks. */
  tasks: TaskDiff[];
  groups: GroupDiff[];
  regressions: number;
  improvements: number;
}

export interface DiffOptions {
  k?: number;
  /** The drop of pass@1 that counts as a regression (default 0.34: more than one trial in three). */
  minDrop?: number;
}

const ORDER: ChangeKind[] = [
  'regression',
  'improvement',
  'new',
  'removed',
  'incomparable',
  'unchanged',
];
// Floating point: 1 − 2/3 must count as a drop of 1/3.
const EPSILON = 1e-9;

const side = (task: TaskSummary): TaskSide => ({
  n: task.n,
  c: task.c,
  pass1: task.pass1,
  passHatK: task.passHatK,
});
const groupSide = (group: GroupSummary): GroupSide => ({
  pass1: group.pass1,
  passHatK: group.passHatK,
  costUsd: group.perTask.costUsd,
  replyP50: group.replyMs.p50,
});
const minus = (a: number | null | undefined, b: number | null | undefined) =>
  a === null || a === undefined || b === null || b === undefined ? null : a - b;

function classify(before: TaskSide, after: TaskSide, minDrop: number): ChangeKind {
  if (before.pass1 === null || after.pass1 === null) return 'incomparable';
  const change = after.pass1 - before.pass1;
  if (before.passHatK === 1 && after.passHatK !== null && after.passHatK < 1) return 'regression';
  if (change <= -minDrop + EPSILON) return 'regression';
  if (after.passHatK === 1 && before.passHatK !== null && before.passHatK < 1) return 'improvement';
  if (change >= minDrop - EPSILON) return 'improvement';
  return 'unchanged';
}

const keyOf = (item: { suite: string; target: string; taskId?: string }) =>
  `${item.suite}\u0000${item.target}\u0000${item.taskId ?? ''}`;

/** Compares two runs task by task (per target and suite) and group by group. */
export function diffRuns(before: RunResult, after: RunResult, options: DiffOptions = {}): RunDiff {
  const k = options.k ?? 3;
  const minDrop = options.minDrop ?? 0.34;
  const a: Summary = summarize(before, { k });
  const b: Summary = summarize(after, { k });

  const beforeTasks = new Map(a.tasks.map((task) => [keyOf(task), task]));
  const afterTasks = new Map(b.tasks.map((task) => [keyOf(task), task]));
  const tasks: TaskDiff[] = [];
  for (const task of b.tasks) {
    const old = beforeTasks.get(keyOf(task));
    const now = side(task);
    const was = old ? side(old) : null;
    tasks.push({
      suite: task.suite,
      target: task.target,
      taskId: task.taskId,
      kind: was ? classify(was, now, minDrop) : 'new',
      before: was,
      after: now,
      pass1Change: minus(now.pass1, was?.pass1),
    });
  }
  for (const task of a.tasks)
    if (!afterTasks.has(keyOf(task)))
      tasks.push({
        suite: task.suite,
        target: task.target,
        taskId: task.taskId,
        kind: 'removed',
        before: side(task),
        after: null,
        pass1Change: null,
      });
  // A stable sort keeps the run's order within a kind.
  tasks.sort((x, y) => ORDER.indexOf(x.kind) - ORDER.indexOf(y.kind));

  const beforeGroups = new Map(a.groups.map((group) => [keyOf(group), group]));
  const afterKeys = new Set(b.groups.map(keyOf));
  const groups: GroupDiff[] = [];
  const pushGroup = (
    suite: string,
    target: string,
    x: GroupSummary | undefined,
    y: GroupSummary | undefined,
  ) => {
    const was = x ? groupSide(x) : null;
    const now = y ? groupSide(y) : null;
    groups.push({
      suite,
      target,
      before: was,
      after: now,
      delta: {
        pass1: minus(now?.pass1, was?.pass1),
        passHatK: minus(now?.passHatK, was?.passHatK),
        costUsd: minus(now?.costUsd, was?.costUsd),
        replyP50: minus(now?.replyP50, was?.replyP50),
      },
    });
  };
  for (const group of b.groups)
    pushGroup(group.suite, group.target, beforeGroups.get(keyOf(group)), group);
  for (const group of a.groups)
    if (!afterKeys.has(keyOf(group))) pushGroup(group.suite, group.target, group, undefined);

  return {
    before: before.id,
    after: after.id,
    k,
    minDrop,
    tasks,
    groups,
    regressions: tasks.filter((task) => task.kind === 'regression').length,
    improvements: tasks.filter((task) => task.kind === 'improvement').length,
  };
}
