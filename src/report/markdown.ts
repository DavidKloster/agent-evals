import type {
  CalibrationReport,
  FailureClass,
  Review,
  RunResult,
  SuiteKind,
  TrialResult,
} from '../core/types.ts';
import type { RunDiff, TaskDiff } from '../metrics/diff.ts';
import { saturation, type SaturationNote } from '../metrics/lifecycle.ts';
import { orderTrials, summarize, type GroupSummary, type Summary } from '../metrics/stats.ts';
import { failureTable, ungradedTrials, type FailureRow, type UngradedRow } from './reviews.ts';

export interface ReportOptions {
  /** k of pass@k and pass^k (default 3, or the summary's). */
  k?: number;
  /** The run's summary; computed when left out. */
  summary?: Summary;
  /** A comparison with an earlier run. */
  diff?: RunDiff;
  reviews?: readonly Review[];
  /** How well the model judges agree with the human labels. */
  calibration?: CalibrationReport;
  /** How many annotated failure examples to show (default 5). */
  examples?: number;
}

// ---- formatting, shared with the HTML report ----

export const DASH = '–';

export const formatPercent = (value: number | null | undefined): string =>
  value === null || value === undefined ? DASH : `${(value * 100).toFixed(1)}%`;

/** A change of a share, in percentage points with its sign. */
export const formatPoints = (value: number | null | undefined): string =>
  value === null || value === undefined
    ? DASH
    : `${value > 0 ? '+' : ''}${(value * 100).toFixed(1)} pp`;

export const formatUsd = (value: number | null | undefined, complete = true): string =>
  value === null || value === undefined ? DASH : `${complete ? '' : '≥'}$${value.toFixed(4)}`;

export const formatSignedUsd = (value: number | null | undefined): string =>
  value === null || value === undefined
    ? DASH
    : `${value < 0 ? '−' : '+'}$${Math.abs(value).toFixed(4)}`;

export const formatMs = (value: number | null | undefined): string =>
  value === null || value === undefined ? DASH : String(Math.round(value));

export const formatSignedMs = (value: number | null | undefined): string =>
  value === null || value === undefined ? DASH : `${value > 0 ? '+' : ''}${Math.round(value)}`;

export const formatNumber = (value: number | null | undefined, digits = 1): string =>
  value === null || value === undefined ? DASH : value.toFixed(digits);

export const formatInteger = (value: number | null | undefined): string =>
  value === null || value === undefined ? DASH : String(Math.round(value));

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… (${text.length - max} more characters)`;
}

/** JSON for the report; never throws (a cycle or a BigInt in an outcome must not break the report). */
export function toJson(value: unknown, indent?: number): string {
  try {
    return (
      JSON.stringify(
        value,
        (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v),
        indent,
      ) ?? 'undefined'
    );
  } catch {
    return String(value);
  }
}

// ---- the report's data, shared with the HTML report ----

export const FAILURE_CLASSES: (FailureClass | 'unreviewed')[] = [
  'agent',
  'grader',
  'task',
  'infra',
  'unreviewed',
];

export interface FailureExample {
  row: FailureRow;
  trial: TrialResult;
  excerpt: string[];
}

export interface ReportData {
  k: number;
  summary: Summary;
  saturation: SaturationNote[];
  failures: FailureRow[];
  /** Trials no grader ran on: not failures, listed apart. */
  ungraded: UngradedRow[];
  classCounts: Record<FailureClass | 'unreviewed', number>;
  examples: FailureExample[];
  /** The suites in the run's order, with their kind. */
  suites: { name: string; kind: SuiteKind }[];
  targets: string[];
}

/** A few lines that show what happened in a trial: the user's messages, the tool calls, errors and the final answer. */
export function transcriptExcerpt(trial: TrialResult): string[] {
  const lines: string[] = [];
  let answer: string | undefined;
  for (const event of trial.transcript) {
    if (event.type === 'message' && event.role === 'user')
      lines.push(`user: ${truncate(oneLine(event.text), 200)}`);
    else if (event.type === 'message' && event.role === 'assistant') answer = event.text;
    else if (event.type === 'tool_call')
      lines.push(`tool: ${event.name}(${truncate(toJson(event.args), 120)})`);
    else if (event.type === 'tool_result' && event.error !== undefined)
      lines.push(`tool error: ${event.name}: ${truncate(oneLine(event.error), 160)}`);
    else if (event.type === 'error')
      lines.push(`error (${event.kind}): ${truncate(oneLine(event.message), 200)}`);
  }
  lines.push(`answer: ${answer === undefined ? '(none)' : truncate(oneLine(answer), 300)}`);
  return lines;
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

const trialKey = (t: { suite: string; taskId: string; target: string; trial: number }) =>
  `${t.suite}\u0000${t.taskId}\u0000${t.target}\u0000${t.trial}`;

/**
 * The failures to show as examples: annotated reviews first, then reviewed ones, then unreviewed ones; infrastructure
 * errors last, since they say nothing about the agent.
 */
function pickExamples(run: RunResult, failures: FailureRow[], count: number): FailureExample[] {
  const trials = new Map(run.trials.map((trial) => [trialKey(trial), trial]));
  const rank = (row: FailureRow) =>
    row.class === 'infra'
      ? 3
      : row.annotation !== undefined
        ? 0
        : row.class !== 'unreviewed'
          ? 1
          : 2;
  return failures
    .map((row, index) => ({ row, index }))
    .sort((a, b) => rank(a.row) - rank(b.row) || a.index - b.index)
    .slice(0, Math.max(0, count))
    .flatMap(({ row }) => {
      const trial = trials.get(trialKey(row));
      return trial ? [{ row, trial, excerpt: transcriptExcerpt(trial) }] : [];
    });
}

export function reportData(run: RunResult, options: ReportOptions = {}): ReportData {
  const summary = options.summary ?? summarize(run, { k: options.k ?? 3 });
  const k = options.k ?? summary.k;
  const failures = failureTable(run, options.reviews ?? []);
  const classCounts = { agent: 0, grader: 0, task: 0, infra: 0, unreviewed: 0 };
  for (const row of failures) classCounts[row.class]++;
  const suites: ReportData['suites'] = run.suites.map((suite) => ({
    name: suite.name,
    kind: suite.kind,
  }));
  for (const trial of orderTrials(run))
    if (!suites.some((suite) => suite.name === trial.suite))
      suites.push({ name: trial.suite, kind: trial.suiteKind });
  const targets = run.targets.map((target) => target.name);
  for (const trial of run.trials) if (!targets.includes(trial.target)) targets.push(trial.target);
  return {
    k,
    summary,
    saturation: saturation(run, summary),
    failures,
    ungraded: ungradedTrials(run),
    classCounts,
    examples: pickExamples(run, failures, options.examples ?? 5),
    suites,
    targets,
  };
}

/** The columns of the model comparison table, as text; the HTML report uses the same. */
export function comparisonHeader(k: number): string[] {
  return [
    'Target',
    'Tasks',
    'pass@1',
    `pass@${k}`,
    `pass^${k}`,
    'Partial',
    'TTFT p50/p90 ms',
    'Reply p50/p90 ms',
    'Turns',
    'Model calls',
    'Tool calls',
    'Tokens in/out',
    '$/task',
    'Errors agent/timeout/infra',
  ];
}

export function comparisonRow(group: GroupSummary): string[] {
  return [
    group.target,
    String(group.tasks),
    formatPercent(group.pass1),
    formatPercent(group.passAtK),
    formatPercent(group.passHatK),
    formatPercent(group.score),
    `${formatMs(group.ttftMs.p50)} / ${formatMs(group.ttftMs.p90)}`,
    `${formatMs(group.replyMs.p50)} / ${formatMs(group.replyMs.p90)}`,
    formatNumber(group.perTask.turns),
    formatNumber(group.perTask.modelCalls),
    formatNumber(group.perTask.toolCalls),
    `${formatInteger(group.perTask.inputTokens)} / ${formatInteger(group.perTask.outputTokens)}`,
    formatUsd(group.perTask.costUsd, group.costComplete),
    `${formatPercent(group.rates.agentError)} / ${formatPercent(group.rates.timeout)} / ${formatPercent(group.rates.infraError)}`,
  ];
}

/** Notes under a suite's comparison table: what the numbers leave out. */
export function comparisonNotes(groups: GroupSummary[], k: number): string[] {
  const notes: string[] = [];
  for (const group of groups) {
    if (group.tasksBelowK > 0)
      notes.push(
        `${group.target}: ${group.tasksBelowK} task(s) with fewer than ${k} graded trials are left out of pass@${k} and pass^${k}.`,
      );
    if (group.graderErrors > 0)
      notes.push(
        `${group.target}: a grader threw in ${group.graderErrors} trial(s); these are grader errors, not the agent's.`,
      );
    if (group.infraErrors > 0)
      notes.push(
        `${group.target}: ${group.infraErrors} attempt(s) hit an infrastructure error; they are not counted as the agent's failures.`,
      );
    if (!group.costComplete)
      notes.push(`${group.target}: some model calls reported no cost, so $/task is a lower bound.`);
  }
  return notes;
}

/** The cell of the task matrix: passes over graded trials, pass^k, and the trials lost to the infrastructure. */
export function matrixCell(
  summary: Summary,
  suite: string,
  taskId: string,
  target: string,
): string {
  const task = summary.tasks.find(
    (t) => t.suite === suite && t.taskId === taskId && t.target === target,
  );
  if (!task) return DASH;
  const infra = task.statuses.infra_error > 0 ? ` (+${task.statuses.infra_error} infra)` : '';
  return `${task.c}/${task.n} · pass^${summary.k} ${formatPercent(task.passHatK)}${infra}`;
}

/** The tasks of a suite in the run's order, the ones only the trials know of appended. */
export function tasksOf(run: RunResult, suite: string): string[] {
  const tasks = [...(run.suites.find((s) => s.name === suite)?.tasks ?? [])];
  for (const trial of run.trials)
    if (trial.suite === suite && !tasks.includes(trial.taskId)) tasks.push(trial.taskId);
  return tasks.filter((task) =>
    run.trials.some((trial) => trial.suite === suite && trial.taskId === task),
  );
}

export const DIFF_HEADER = (k: number) => [
  'Change',
  'Suite',
  'Task',
  'Target',
  'pass@1 before',
  'pass@1 after',
  'Δ pass@1',
  `pass^${k} before`,
  `pass^${k} after`,
];

export const diffRow = (task: TaskDiff): string[] => [
  task.kind,
  task.suite,
  task.taskId,
  task.target,
  formatPercent(task.before?.pass1),
  formatPercent(task.after?.pass1),
  formatPoints(task.pass1Change),
  formatPercent(task.before?.passHatK),
  formatPercent(task.after?.passHatK),
];

// ---- markdown ----

/** A table cell: no line breaks, and a `|` that doesn't end the cell. */
export const escapeCell = (text: string): string =>
  text.replace(/\r?\n/g, ' ').replace(/\\/g, '\\\\').replace(/\|/g, '\\|');

function table(header: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.map(escapeCell).join(' | ')} |`;
  return [line(header), `| ${header.map(() => '---').join(' | ')} |`, ...rows.map(line)].join('\n');
}

/** A fence longer than any run of backticks in the text, so model output can't close it. */
function fenced(text: string, lang = 'text'): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${lang}\n${text}\n${fence}`;
}

const code = (text: string) => `\`${text.replace(/`/g, "'")}\``;

export function markdownReport(run: RunResult, options: ReportOptions = {}): string {
  const data = reportData(run, options);
  const { k, summary } = data;
  const out: string[] = [];

  out.push('# Agent eval report', '');
  out.push(`- Run: ${code(run.id)}`);
  out.push(`- Started: ${run.startedAt}, finished: ${run.finishedAt}`);
  out.push(
    `- Targets: ${run.targets.map((t) => (t.description ? `${code(t.name)} (${t.description})` : code(t.name))).join(', ') || DASH}`,
  );
  out.push(
    `- Suites: ${run.suites.map((s) => `${code(s.name)} (${s.kind}, ${s.tasks.length} tasks)`).join(', ') || DASH}`,
  );
  out.push(`- Trials: ${run.trials.length}; k = ${k}`);
  const ungraded = run.trials.filter((t) => t.ungraded).length;
  if (ungraded > 0)
    out.push(
      `- **${ungraded} trial(s) ungraded**: no grader could run (the task has only model graders and the run had no judge, or the judge failed); they are left out of pass@k and listed under "Ungraded trials".`,
    );
  for (const [key, value] of Object.entries(run.meta ?? {}))
    out.push(`- ${key}: ${typeof value === 'string' ? value : toJson(value)}`);
  out.push('');

  out.push('## Model comparison', '');
  for (const suite of data.suites) {
    const groups = summary.groups.filter((group) => group.suite === suite.name);
    if (groups.length === 0) continue;
    out.push(`### ${code(suite.name)} (${suite.kind})`, '');
    out.push(table(comparisonHeader(k), groups.map(comparisonRow)), '');
    for (const note of comparisonNotes(groups, k)) out.push(`- ${note}`);
    if (comparisonNotes(groups, k).length > 0) out.push('');
  }

  out.push('## Saturation', '');
  const saturated = data.saturation.filter((note) => note.saturated);
  if (data.saturation.length === 0) out.push('No capability suite in this run.');
  else if (saturated.length === 0) out.push('No capability suite is saturated.');
  else
    for (const note of saturated)
      out.push(
        `- ${code(note.suite)} × ${code(note.target)}: pass@1 ${formatPercent(note.pass1)} reaches ${formatPercent(note.threshold)}. The suite is saturated and gives little signal: add harder tasks.`,
      );
  out.push('');

  out.push('## Suspected broken tasks', '');
  if (summary.brokenTaskSuspects.length === 0)
    out.push(`None: every task with at least ${k} trials passed at least once.`);
  else {
    out.push(
      'No target passed these tasks. Check the task and its graders before blaming the agents.',
      '',
    );
    for (const suspect of summary.brokenTaskSuspects)
      out.push(
        `- ${code(`${suspect.suite}/${suspect.taskId}`)}: 0 passes in ${suspect.trials} trials (${suspect.targets.join(', ')})`,
      );
  }
  out.push('');

  out.push('## Tasks', '');
  for (const suite of data.suites) {
    const tasks = tasksOf(run, suite.name);
    if (tasks.length === 0) continue;
    const targets = data.targets.filter((target) =>
      run.trials.some((t) => t.suite === suite.name && t.target === target),
    );
    out.push(`### ${code(suite.name)}`, '');
    out.push(
      table(
        ['Task', ...targets],
        tasks.map((task) => [
          task,
          ...targets.map((target) => matrixCell(summary, suite.name, task, target)),
        ]),
      ),
    );
    out.push('');
  }

  out.push('## Failures', '');
  if (data.failures.length === 0)
    out.push(data.ungraded.length === 0 ? 'Every trial passed.' : 'No graded trial failed.');
  else {
    out.push(
      table(
        ['Class', 'Trials'],
        FAILURE_CLASSES.map((c) => [c, String(data.classCounts[c])]),
      ),
      '',
    );
    if (data.classCounts.unreviewed > 0)
      out.push(
        `${data.classCounts.unreviewed} failure(s) are unreviewed: read their transcripts and classify them in the reviews file.`,
        '',
      );
    out.push(
      table(
        ['Suite', 'Task', 'Target', 'Trial', 'Status', 'Class', 'Failing'],
        data.failures.map((row) => [
          row.suite,
          row.taskId,
          row.target,
          String(row.trial),
          row.status,
          row.class,
          truncate(row.failing.join('; ') || row.error || DASH, 200),
        ]),
      ),
      '',
    );
  }

  if (data.ungraded.length > 0) {
    out.push(
      '## Ungraded trials',
      '',
      'These trials have no verdict (every grader of their task is a model grader and the run had no judge, or the judge failed), so they are neither passes nor failures. `regrade` the run with a config that has a judge.',
      '',
      table(
        ['Suite', 'Task', 'Target', 'Trial', 'Status', 'Reason'],
        data.ungraded.map((row) => [
          row.suite,
          row.taskId,
          row.target,
          String(row.trial),
          row.status,
          truncate(row.reason, 200),
        ]),
      ),
      '',
    );
  }

  if (data.examples.length > 0) {
    out.push('## Failure examples', '');
    data.examples.forEach(({ row, excerpt }, index) => {
      out.push(
        `### ${index + 1}. ${code(`${row.suite}/${row.taskId}`)} · ${code(row.target)} · trial ${row.trial} · ${row.class}`,
        '',
      );
      if (row.annotation) out.push(...row.annotation.split(/\r?\n/).map((line) => `> ${line}`), '');
      if (row.error) out.push(`Error: ${truncate(oneLine(row.error), 300)}`, '');
      if (row.failing.length > 0)
        out.push(
          'Failing:',
          '',
          ...row.failing.map((line) => `- ${truncate(oneLine(line), 300)}`),
          '',
        );
      out.push(fenced(excerpt.join('\n')), '');
    });
  }

  if (options.calibration) {
    const { dimensions, sample } = options.calibration;
    out.push('## Judge calibration', '');
    out.push(
      table(
        ['Grader', 'Dimension', 'n', 'Agreement', 'Kappa', 'Unknown'],
        dimensions.map((d) => [
          d.grader,
          d.dimension,
          String(d.n),
          formatPercent(d.agreement),
          formatNumber(d.kappa, 2),
          formatPercent(d.unknownRate),
        ]),
      ),
      '',
    );
    if (sample.length > 0) {
      out.push('### Labelled sample', '');
      out.push(
        table(
          ['Task', 'Target', 'Trial', 'Grader', 'Dimension', 'Human', 'Judge', 'Note'],
          sample.map((s) => [
            s.suite ? `${s.suite}/${s.taskId}` : s.taskId,
            s.target,
            String(s.trial),
            s.grader,
            s.dimension,
            s.label,
            s.judge ?? DASH,
            truncate([s.note, s.judgeReason].filter(Boolean).join(' · '), 200),
          ]),
        ),
        '',
      );
    }
  }

  if (options.diff) {
    const diff = options.diff;
    out.push(`## Changes since ${code(diff.before)}`, '');
    out.push(
      `${diff.regressions} regression(s), ${diff.improvements} improvement(s); a drop of pass@1 by ${formatPercent(diff.minDrop)} or of pass^${diff.k} from 100% counts as a regression.`,
      '',
    );
    const changed = diff.tasks.filter((task) => task.kind !== 'unchanged');
    if (changed.length > 0) out.push(table(DIFF_HEADER(diff.k), changed.map(diffRow)), '');
    out.push(
      table(
        ['Suite', 'Target', 'Δ pass@1', `Δ pass^${diff.k}`, 'Δ $/task', 'Δ reply p50 ms'],
        diff.groups.map((g) => [
          g.suite,
          g.target,
          formatPoints(g.delta.pass1),
          formatPoints(g.delta.passHatK),
          formatSignedUsd(g.delta.costUsd),
          formatSignedMs(g.delta.replyP50),
        ]),
      ),
      '',
    );
  }

  return `${out.join('\n').trimEnd()}\n`;
}
