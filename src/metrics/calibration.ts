import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { parse, stringify } from 'yaml';
import { z } from 'zod';

import { answerOf, messages } from '../core/transcript.ts';
import type {
  CalibrationReport,
  GraderResult,
  HumanLabel,
  RunResult,
  TrialResult,
  Verdict,
} from '../core/types.ts';

/**
 * Human grading and judge calibration. A person labels a sample of trials per rubric dimension in a YAML file; the
 * labels are the gold standard the model judge is measured against (agreement and Cohen's kappa), so a judge is
 * trusted only as far as it agrees with people.
 */

const verdictSchema = z.enum(['pass', 'fail', 'unknown']);

export const humanLabelSchema = z.object({
  suite: z.string().optional(),
  taskId: z.string().min(1),
  target: z.string().min(1),
  trial: z.number().int().nonnegative(),
  grader: z.string().min(1),
  dimension: z.string().min(1),
  label: verdictSchema,
  labeller: z.string().optional(),
  note: z.string().optional(),
});

/** The labels from a YAML or JSON file: a list, or `{ labels: [...] }`. The sheet's helper fields are dropped. */
export function loadLabels(file: string): HumanLabel[] {
  const data: unknown = parse(readFileSync(file, 'utf8'));
  const list =
    data !== null && typeof data === 'object' && !Array.isArray(data)
      ? (data as { labels?: unknown }).labels
      : data;
  const result = z.array(humanLabelSchema).safeParse(list ?? []);
  if (!result.success) {
    throw new Error(
      `${file}: invalid labels: ${result.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
    );
  }
  // Empty optional strings from the sheet mean "not given".
  return result.data.map((label) => {
    const clean: HumanLabel = { ...label };
    if (!clean.labeller) delete clean.labeller;
    if (!clean.note) delete clean.note;
    return clean;
  });
}

/** One entry of the labelling sheet: a label to fill in, with what the person needs to decide it. */
export interface LabellingEntry extends HumanLabel {
  /** The dimension's question. */
  question?: string;
  /** What the user asked, shortened. */
  input?: string;
  /** The agent's answer, shortened. */
  answer?: string;
}

export interface LabellingOptions {
  /** Only this judge grader's id (default: every judge grader). */
  grader?: string;
  /** How many trials to sample (default: all). */
  sample?: number;
  seed?: number;
}

interface JudgeDimension {
  name: string;
  question?: string;
  verdict: Verdict;
  reason?: string;
}

/** The dimensions a judge grader result holds in its details (see judge.ts). */
function dimensionsOf(grade: GraderResult): JudgeDimension[] {
  const details = grade.details as { dimensions?: unknown } | undefined;
  if (!Array.isArray(details?.dimensions)) return [];
  return details.dimensions.filter(
    (d): d is JudgeDimension =>
      d !== null && typeof d === 'object' && typeof (d as JudgeDimension).name === 'string',
  );
}

function judgeGrades(trial: TrialResult, grader?: string): GraderResult[] {
  return trial.grades.filter(
    (g) => (grader ? g.id === grader : g.type === 'judge') && dimensionsOf(g).length > 0,
  );
}

/** A small seeded generator (mulberry32), so the same seed draws the same sample. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

const trialKey = (t: { suite?: string; taskId: string; target: string; trial: number }) =>
  `${t.suite ?? ''}\u0000${t.taskId}\u0000${t.target}\u0000${t.trial}`;

/**
 * The sheet a person fills in: a seeded sample of the trials a judge graded, one entry per dimension with `label:
 * unknown` to replace. The judge's verdict is left out so the person isn't anchored on it.
 */
export function labellingSheet(run: RunResult, options: LabellingOptions = {}): LabellingEntry[] {
  const trials = run.trials
    .filter((t) => judgeGrades(t, options.grader).length > 0)
    .sort((x, y) => trialKey(x).localeCompare(trialKey(y)));
  const next = random(options.seed ?? 1);
  for (let i = trials.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [trials[i], trials[j]] = [trials[j]!, trials[i]!];
  }
  const picked = trials
    .slice(0, options.sample ?? trials.length)
    .sort((x, y) => trialKey(x).localeCompare(trialKey(y)));
  return picked.flatMap((trial) => {
    const input = cut(messages(trial.transcript, 'user').join('\n\n'), 600);
    const answer = cut(answerOf(trial.transcript).answer, 1500);
    return judgeGrades(trial, options.grader).flatMap((grade) =>
      dimensionsOf(grade).map((d) => ({
        suite: trial.suite,
        taskId: trial.taskId,
        target: trial.target,
        trial: trial.trial,
        grader: grade.id,
        dimension: d.name,
        ...(d.question ? { question: d.question } : {}),
        input,
        answer,
        label: 'unknown' as const,
        labeller: '',
        note: '',
      })),
    );
  });
}

const sheetHeader = `# Labelling sheet for the model judge's calibration.
# For each entry, read the trial (input and answer here, the whole transcript in the run's report.html), answer the
# question yourself and set "label" to pass or fail. Keep "unknown" only when the transcript doesn't let you decide
# either. Add your name as "labeller" and, where useful, a "note". Do not look at the judge's verdict first.
# Then: agent-evals calibrate <run> --labels <this file>
`;

export function writeLabellingSheet(file: string, sheet: LabellingEntry[]): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${sheetHeader}\n${stringify(sheet, { lineWidth: 0 })}`, 'utf8');
}

function findTrial(run: RunResult, label: HumanLabel): TrialResult | undefined {
  return run.trials.find(
    (t) =>
      (label.suite === undefined || t.suite === label.suite) &&
      t.taskId === label.taskId &&
      t.target === label.target &&
      t.trial === label.trial,
  );
}

/** Cohen's kappa over pass/fail pairs; null without pairs or when chance agreement is already 1. */
export function cohensKappa(pairs: { judge: Verdict; human: Verdict }[]): number | null {
  const decided = pairs.filter((p) => p.judge !== 'unknown' && p.human !== 'unknown');
  const n = decided.length;
  if (n === 0) return null;
  const observed = decided.filter((p) => p.judge === p.human).length / n;
  const share = (who: 'judge' | 'human') => decided.filter((p) => p[who] === 'pass').length / n;
  const expected = share('judge') * share('human') + (1 - share('judge')) * (1 - share('human'));
  if (expected === 1) return null;
  return Number(((observed - expected) / (1 - expected)).toFixed(6));
}

/**
 * How well the judge agrees with the human labels, per grader and dimension. A label whose trial or dimension the run
 * doesn't have stays in the sample with judge null and out of the numbers.
 */
export function calibrate(run: RunResult, labels: HumanLabel[]): CalibrationReport {
  const sample: CalibrationReport['sample'] = labels.map((label) => {
    const grade = findTrial(run, label)?.grades.find((g) => g.id === label.grader);
    const dimension = grade
      ? dimensionsOf(grade).find((d) => d.name === label.dimension)
      : undefined;
    return dimension
      ? {
          ...label,
          judge: dimension.verdict,
          ...(dimension.reason ? { judgeReason: dimension.reason } : {}),
        }
      : { ...label, judge: null };
  });
  const groups = new Map<string, CalibrationReport['sample']>();
  for (const entry of sample) {
    const key = `${entry.grader}\u0000${entry.dimension}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  const dimensions = [...groups.values()].map((entries) => {
    const pairs = entries.flatMap((e) =>
      e.judge === null ? [] : [{ judge: e.judge, human: e.label }],
    );
    // A sheet's entry nobody filled in reads `unknown`: agreement counts only the entries a person decided.
    const decided = pairs.filter((p) => p.human !== 'unknown');
    const n = decided.length;
    const confusion = new Map<string, { judge: Verdict; human: Verdict; count: number }>();
    for (const p of pairs) {
      const key = `${p.judge}/${p.human}`;
      const cell = confusion.get(key) ?? { judge: p.judge, human: p.human, count: 0 };
      cell.count++;
      confusion.set(key, cell);
    }
    const ratio = (count: number) => (n === 0 ? null : Number((count / n).toFixed(6)));
    const first = entries[0]!;
    return {
      grader: first.grader,
      dimension: first.dimension,
      n,
      agreement: ratio(decided.filter((p) => p.judge === p.human).length),
      kappa: cohensKappa(decided),
      unknownRate: ratio(decided.filter((p) => p.judge === 'unknown').length),
      humanUnknown: pairs.length - n,
      confusion: [...confusion.values()].sort((x, y) =>
        `${x.judge}/${x.human}`.localeCompare(`${y.judge}/${y.human}`),
      ),
    };
  });
  return { dimensions, sample };
}
