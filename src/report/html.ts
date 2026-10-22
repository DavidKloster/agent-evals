import type {
  Assertion,
  GraderResult,
  RunResult,
  TranscriptEvent,
  TrialResult,
} from '../core/types.ts';
import { orderTrials } from '../metrics/stats.ts';
import {
  comparisonHeader,
  comparisonNotes,
  comparisonRow,
  DASH,
  DIFF_HEADER,
  diffRow,
  FAILURE_CLASSES,
  formatMs,
  formatNumber,
  formatPercent,
  formatPoints,
  formatSignedMs,
  formatSignedUsd,
  formatUsd,
  matrixCell,
  reportData,
  tasksOf,
  toJson,
  truncate,
  type ReportOptions,
} from './markdown.ts';
import { classify } from './reviews.ts';

const TOOL_RESULT_MAX = 2000;
const TEXT_MAX = 20_000;

/** Escapes text for HTML content and attribute values. Transcripts hold untrusted model output: every text goes through this. */
export function escapeHtml(text: unknown): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Markup that is already safe; anything else is escaped on output. */
interface Html {
  html: string;
}
type Content = string | number | Html;

const raw = (html: string): Html => ({ html });
const render = (content: Content): string =>
  typeof content === 'object' ? content.html : escapeHtml(content);

function el(tag: string, attrs: Record<string, string | undefined>, ...children: Content[]): Html {
  const attributes = Object.entries(attrs)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => ` ${name}="${escapeHtml(value)}"`)
    .join('');
  return raw(`<${tag}${attributes}>${children.map(render).join('')}</${tag}>`);
}

const join = (...parts: Content[]): Html => raw(parts.map(render).join(''));

function table(header: Content[], rows: Content[][], className?: string): Html {
  return el(
    'table',
    { class: className },
    el('thead', {}, el('tr', {}, ...header.map((cell) => el('th', {}, cell)))),
    el('tbody', {}, ...rows.map((row) => el('tr', {}, ...row.map((cell) => el('td', {}, cell))))),
  );
}

const badge = (kind: 'pass' | 'fail' | 'unknown' | 'error' | 'info', text: string) =>
  el('span', { class: `badge ${kind}` }, text);
const pre = (text: string, className?: string) => el('pre', { class: className }, text);
const details = (summary: Content, open: boolean, ...children: Content[]) =>
  el('details', { open: open ? '' : undefined }, el('summary', {}, summary), ...children);

const STYLE = `
:root{color-scheme:light dark;--bg:#fff;--fg:#1f2328;--muted:#656d76;--border:#d0d7de;--panel:#f6f8fa;
--pass:#1a7f37;--pass-bg:#dafbe1;--fail:#cf222e;--fail-bg:#ffebe9;--unknown:#9a6700;--unknown-bg:#fff8c5;
--info:#0969da;--info-bg:#ddf4ff;--user:#ddf4ff;--assistant:#f6f8fa}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8d96a0;--border:#30363d;--panel:#161b22;
--pass:#3fb950;--pass-bg:#12261e;--fail:#f85149;--fail-bg:#25171c;--unknown:#d29922;--unknown-bg:#272115;
--info:#4493f8;--info-bg:#121d2f;--user:#121d2f;--assistant:#161b22}}
*{box-sizing:border-box}
body{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1280px;margin:0 auto}
h1{font-size:24px;margin:0 0 8px}h2{font-size:19px;margin:32px 0 8px;border-bottom:1px solid var(--border);padding-bottom:4px}
h3{font-size:16px;margin:20px 0 8px}
.muted{color:var(--muted)}
.scroll{overflow-x:auto}
table{border-collapse:collapse;margin:8px 0;font-variant-numeric:tabular-nums}
th,td{border:1px solid var(--border);padding:4px 8px;text-align:left;vertical-align:top}
th{background:var(--panel);font-weight:600}
pre{white-space:pre-wrap;word-break:break-word;margin:4px 0;padding:8px;background:var(--panel);border-radius:6px;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
details{margin:4px 0}details>summary{cursor:pointer}
details details{margin-left:16px}
.badge{display:inline-block;padding:0 6px;border-radius:10px;font-size:12px;font-weight:600}
.badge.pass{color:var(--pass);background:var(--pass-bg)}.badge.fail,.badge.error{color:var(--fail);background:var(--fail-bg)}
.badge.unknown{color:var(--unknown);background:var(--unknown-bg)}.badge.info{color:var(--info);background:var(--info-bg)}
.event{border-left:3px solid var(--border);padding:2px 8px;margin:6px 0}
.event .head{font-size:12px;color:var(--muted)}
.event.user{border-color:var(--info)}.event.user pre{background:var(--user)}
.event.assistant{border-color:var(--pass)}.event.assistant pre{background:var(--assistant)}
.event.error{border-color:var(--fail);background:var(--fail-bg)}
.event.tool_result.failed{border-color:var(--fail)}
.annotation{border-left:3px solid var(--unknown);padding:4px 8px;background:var(--unknown-bg)}
ul{margin:4px 0;padding-left:20px}
`;

function eventHtml(event: TranscriptEvent, start: number): Html {
  const offset = `+${Math.round(event.at - start)} ms`;
  const head = (...parts: Content[]) => el('div', { class: 'head' }, offset, ' · ', ...parts);
  switch (event.type) {
    case 'message': {
      const ttft =
        event.firstTokenAt !== undefined
          ? ` · first token +${Math.round(event.firstTokenAt - start)} ms`
          : '';
      return el(
        'div',
        { class: `event ${event.role}` },
        head(el('strong', {}, event.role), ttft),
        pre(truncate(event.text, TEXT_MAX)),
      );
    }
    case 'model_call': {
      const facts = [
        event.provider ? `${event.provider}/${event.model}` : event.model,
        `${event.inputTokens ?? '?'} in / ${event.outputTokens ?? '?'} out tokens`,
        event.costUsd !== undefined ? formatUsd(event.costUsd) : 'cost unknown',
        `${Math.round(event.endedAt - event.startedAt)} ms`,
        event.firstTokenAt !== undefined
          ? `TTFT ${Math.round(event.firstTokenAt - event.startedAt)} ms`
          : undefined,
      ].filter((fact): fact is string => fact !== undefined);
      return el(
        'div',
        { class: `event model_call${event.error ? ' error' : ''}` },
        head(el('strong', {}, 'model call'), ' · ', facts.join(' · ')),
        event.error ? join(badge('error', 'error'), ' ', event.error) : '',
      );
    }
    case 'tool_call':
      return el(
        'div',
        { class: 'event tool_call' },
        head(el('strong', {}, `tool call ${event.name}`), ` · ${event.id}`),
        pre(truncate(toJson(event.args, 2), TEXT_MAX)),
      );
    case 'tool_result':
      return el(
        'div',
        { class: `event tool_result${event.error ? ' failed' : ''}` },
        head(el('strong', {}, `tool result ${event.name}`), ` · ${event.id}`),
        event.error ? el('div', {}, badge('error', 'error'), ' ', event.error) : '',
        pre(
          truncate(
            typeof event.result === 'string' ? event.result : toJson(event.result, 2),
            TOOL_RESULT_MAX,
          ),
        ),
      );
    case 'error':
      return el(
        'div',
        { class: 'event error' },
        head(badge('error', `${event.kind} error`)),
        pre(event.message),
      );
    case 'note':
      return el(
        'div',
        { class: 'event note' },
        head(el('strong', {}, 'note'), ' · ', event.text),
        event.data !== undefined ? pre(truncate(toJson(event.data, 2), TOOL_RESULT_MAX)) : '',
      );
  }
}

function assertionHtml(assertion: Assertion): Html {
  const facts: Content[] = [];
  if (assertion.expected !== undefined)
    facts.push(
      el('div', {}, 'expected: ', el('code', {}, truncate(toJson(assertion.expected), 500))),
    );
  if (assertion.actual !== undefined)
    facts.push(el('div', {}, 'actual: ', el('code', {}, truncate(toJson(assertion.actual), 500))));
  if (assertion.message) facts.push(el('div', { class: 'muted' }, assertion.message));
  return el(
    'li',
    {},
    badge(assertion.passed ? 'pass' : 'fail', assertion.passed ? 'pass' : 'fail'),
    ' ',
    assertion.name,
    ...facts,
  );
}

function gradeHtml(grade: GraderResult): Html {
  const verdict =
    grade.error !== undefined
      ? badge('error', 'grader error')
      : grade.unknown
        ? badge('unknown', 'unknown')
        : badge(grade.passed ? 'pass' : 'fail', grade.passed ? 'pass' : 'fail');
  const meta = `${grade.type} · score ${formatNumber(grade.score, 2)} · weight ${grade.weight}${grade.required ? ' · required' : ''}`;
  return el(
    'div',
    {},
    el(
      'div',
      {},
      verdict,
      ' ',
      el('strong', {}, grade.id),
      ' ',
      el('span', { class: 'muted' }, meta),
    ),
    grade.error !== undefined ? pre(grade.error) : '',
    grade.assertions.length > 0 ? el('ul', {}, ...grade.assertions.map(assertionHtml)) : '',
    grade.details !== undefined
      ? details('details', false, pre(truncate(toJson(grade.details, 2), TEXT_MAX)))
      : '',
  );
}

function trialHtml(trial: TrialResult, options: ReportOptions): Html {
  const review = classify(trial, options.reviews ?? []);
  const reviewClass = trial.status === 'infra_error' ? 'infra' : review?.class;
  const verdict = trial.passed
    ? badge('pass', 'pass')
    : trial.status === 'infra_error'
      ? badge('unknown', 'infra error')
      : badge('fail', trial.status === 'completed' ? 'fail' : trial.status);
  const m = trial.metrics;
  const start = trial.transcript[0]?.at ?? 0;
  return details(
    join(
      verdict,
      ` trial ${trial.trial} · score ${formatPercent(trial.score)} · ${formatMs(m.durationMs)} ms`,
      !trial.passed && reviewClass ? join(' · ', badge('info', reviewClass)) : '',
    ),
    false,
    el(
      'div',
      { class: 'muted' },
      `${m.turns} turns · ${m.modelCalls} model calls · ${m.toolCalls} tool calls · ${m.inputTokens} / ${m.outputTokens} tokens · ${formatUsd(m.costUsd, m.costComplete)} · TTFT ${m.ttftMs.map(formatMs).join(', ') || DASH} ms · reply ${m.replyMs.map(formatMs).join(', ') || DASH} ms · ${trial.attempts} attempt(s) · ${trial.startedAt}`,
    ),
    review && !trial.passed
      ? el(
          'div',
          { class: 'annotation' },
          el('strong', {}, `Review: ${review.class}`),
          review.reviewer ? ` (${review.reviewer})` : '',
          review.annotation ? pre(review.annotation) : '',
        )
      : '',
    trial.error ? el('div', {}, badge('error', 'error'), ' ', trial.error) : '',
    trial.infraErrors.length > 0
      ? el(
          'div',
          {},
          badge('unknown', 'infrastructure errors'),
          el('ul', {}, ...trial.infraErrors.map((error) => el('li', {}, error))),
        )
      : '',
    el('h4', {}, 'Grades'),
    trial.grades.length > 0
      ? join(...trial.grades.map(gradeHtml))
      : el('p', { class: 'muted' }, 'Not graded.'),
    details('Outcome', false, pre(truncate(toJson(trial.outcome, 2), TEXT_MAX))),
    details(
      `Transcript (${trial.transcript.length} events)`,
      !trial.passed,
      ...trial.transcript.map((event) => eventHtml(event, start)),
    ),
  );
}

/** One static, self-contained page: the report's sections and every trial's transcript. Needs no script. */
export function htmlReport(run: RunResult, options: ReportOptions = {}): string {
  const data = reportData(run, options);
  const { k, summary } = data;
  const sections: Content[] = [];

  sections.push(el('h1', {}, 'Agent eval report'));
  const metaRows: Content[][] = [
    ['Run', run.id],
    ['Started', run.startedAt],
    ['Finished', run.finishedAt],
    [
      'Targets',
      run.targets
        .map((t) => (t.description ? `${t.name} (${t.description})` : t.name))
        .join(', ') || DASH,
    ],
    [
      'Suites',
      run.suites.map((s) => `${s.name} (${s.kind}, ${s.tasks.length} tasks)`).join(', ') || DASH,
    ],
    ['Trials', `${run.trials.length}; k = ${k}`],
    ...Object.entries(run.meta ?? {}).map(([key, value]): Content[] => [
      key,
      typeof value === 'string' ? value : toJson(value),
    ]),
  ];
  sections.push(table(['', ''], metaRows, 'meta'));

  sections.push(el('h2', { id: 'comparison' }, 'Model comparison'));
  for (const suite of data.suites) {
    const groups = summary.groups.filter((group) => group.suite === suite.name);
    if (groups.length === 0) continue;
    sections.push(el('h3', {}, `${suite.name} (${suite.kind})`));
    sections.push(
      el('div', { class: 'scroll' }, table(comparisonHeader(k), groups.map(comparisonRow))),
    );
    const notes = comparisonNotes(groups, k);
    if (notes.length > 0)
      sections.push(el('ul', { class: 'muted' }, ...notes.map((note) => el('li', {}, note))));
  }

  sections.push(el('h2', { id: 'saturation' }, 'Saturation'));
  const saturated = data.saturation.filter((note) => note.saturated);
  if (data.saturation.length === 0) sections.push(el('p', {}, 'No capability suite in this run.'));
  else if (saturated.length === 0) sections.push(el('p', {}, 'No capability suite is saturated.'));
  else
    sections.push(
      el(
        'ul',
        {},
        ...saturated.map((note) =>
          el(
            'li',
            {},
            `${note.suite} × ${note.target}: pass@1 ${formatPercent(note.pass1)} reaches ${formatPercent(note.threshold)}. The suite is saturated and gives little signal: add harder tasks.`,
          ),
        ),
      ),
    );

  sections.push(el('h2', { id: 'broken' }, 'Suspected broken tasks'));
  if (summary.brokenTaskSuspects.length === 0)
    sections.push(el('p', {}, `None: every task with at least ${k} trials passed at least once.`));
  else
    sections.push(
      el(
        'p',
        {},
        'No target passed these tasks. Check the task and its graders before blaming the agents.',
      ),
      el(
        'ul',
        {},
        ...summary.brokenTaskSuspects.map((s) =>
          el(
            'li',
            {},
            `${s.suite}/${s.taskId}: 0 passes in ${s.trials} trials (${s.targets.join(', ')})`,
          ),
        ),
      ),
    );

  sections.push(el('h2', { id: 'tasks' }, 'Tasks'));
  for (const suite of data.suites) {
    const tasks = tasksOf(run, suite.name);
    if (tasks.length === 0) continue;
    const targets = data.targets.filter((target) =>
      run.trials.some((t) => t.suite === suite.name && t.target === target),
    );
    sections.push(el('h3', {}, suite.name));
    sections.push(
      el(
        'div',
        { class: 'scroll' },
        table(
          ['Task', ...targets],
          tasks.map((task) => [
            task,
            ...targets.map((target) => matrixCell(summary, suite.name, task, target)),
          ]),
        ),
      ),
    );
  }

  sections.push(el('h2', { id: 'failures' }, 'Failures'));
  if (data.failures.length === 0)
    sections.push(
      el('p', {}, data.ungraded.length === 0 ? 'Every trial passed.' : 'No graded trial failed.'),
    );
  else {
    sections.push(
      table(
        ['Class', 'Trials'],
        FAILURE_CLASSES.map((c) => [c, data.classCounts[c]]),
      ),
    );
    sections.push(
      el(
        'div',
        { class: 'scroll' },
        table(
          ['Suite', 'Task', 'Target', 'Trial', 'Status', 'Class', 'Failing', 'Annotation'],
          data.failures.map((row) => [
            row.suite,
            row.taskId,
            row.target,
            row.trial,
            row.status,
            badge(row.class === 'unreviewed' ? 'unknown' : 'info', row.class),
            row.failing.length > 0
              ? el('ul', {}, ...row.failing.map((line) => el('li', {}, truncate(line, 300))))
              : (row.error ?? DASH),
            row.annotation ?? '',
          ]),
        ),
      ),
    );
  }

  if (data.ungraded.length > 0) {
    sections.push(el('h2', { id: 'ungraded' }, 'Ungraded trials'));
    sections.push(
      el(
        'p',
        {},
        'These trials have no verdict (every grader of their task is a model grader and the run had no judge, or the judge failed), so they are neither passes nor failures. Regrade the run with a config that has a judge.',
      ),
      el(
        'div',
        { class: 'scroll' },
        table(
          ['Suite', 'Task', 'Target', 'Trial', 'Status', 'Reason'],
          data.ungraded.map((row) => [
            row.suite,
            row.taskId,
            row.target,
            row.trial,
            row.status,
            truncate(row.reason, 300),
          ]),
        ),
      ),
    );
  }

  if (data.examples.length > 0) {
    sections.push(el('h2', { id: 'examples' }, 'Failure examples'));
    data.examples.forEach(({ row, excerpt }, index) => {
      sections.push(
        el(
          'h3',
          {},
          `${index + 1}. ${row.suite}/${row.taskId} · ${row.target} · trial ${row.trial} · `,
          badge(row.class === 'unreviewed' ? 'unknown' : 'info', row.class),
        ),
        row.annotation ? el('div', { class: 'annotation' }, row.annotation) : '',
        row.error ? el('p', {}, badge('error', 'error'), ' ', row.error) : '',
        row.failing.length > 0
          ? el('ul', {}, ...row.failing.map((line) => el('li', {}, truncate(line, 300))))
          : '',
        pre(excerpt.join('\n')),
      );
    });
  }

  if (options.calibration) {
    const { dimensions, sample } = options.calibration;
    sections.push(el('h2', { id: 'calibration' }, 'Judge calibration'));
    sections.push(
      table(
        ['Grader', 'Dimension', 'n', 'Agreement', 'Kappa', 'Unknown'],
        dimensions.map((d) => [
          d.grader,
          d.dimension,
          d.n,
          formatPercent(d.agreement),
          formatNumber(d.kappa, 2),
          formatPercent(d.unknownRate),
        ]),
      ),
    );
    if (sample.length > 0)
      sections.push(
        details(
          `Labelled sample (${sample.length})`,
          false,
          el(
            'div',
            { class: 'scroll' },
            table(
              ['Task', 'Target', 'Trial', 'Grader', 'Dimension', 'Human', 'Judge', 'Note'],
              sample.map((s) => [
                s.suite ? `${s.suite}/${s.taskId}` : s.taskId,
                s.target,
                s.trial,
                s.grader,
                s.dimension,
                s.label,
                s.judge === null ? DASH : badge(s.judge === s.label ? 'pass' : 'fail', s.judge),
                [s.note, s.judgeReason].filter(Boolean).join(' · '),
              ]),
            ),
          ),
        ),
      );
  }

  if (options.diff) {
    const diff = options.diff;
    sections.push(el('h2', { id: 'diff' }, `Changes since ${diff.before}`));
    sections.push(
      el(
        'p',
        {},
        `${diff.regressions} regression(s), ${diff.improvements} improvement(s); a drop of pass@1 by ${formatPercent(diff.minDrop)} or of pass^${diff.k} from 100% counts as a regression.`,
      ),
    );
    const changed = diff.tasks.filter((task) => task.kind !== 'unchanged');
    if (changed.length > 0)
      sections.push(
        el(
          'div',
          { class: 'scroll' },
          table(
            DIFF_HEADER(diff.k),
            changed.map((task) => {
              const [kind = '', ...rest] = diffRow(task);
              return [
                badge(
                  task.kind === 'regression'
                    ? 'fail'
                    : task.kind === 'improvement'
                      ? 'pass'
                      : 'info',
                  kind,
                ),
                ...rest,
              ];
            }),
          ),
        ),
      );
    sections.push(
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
    );
  }

  // Every transcript, suite → task → target → trial.
  sections.push(el('h2', { id: 'transcripts' }, 'Transcripts'));
  const ordered = orderTrials(run);
  for (const suite of data.suites) {
    const tasks = tasksOf(run, suite.name);
    if (tasks.length === 0) continue;
    const taskBlocks = tasks.map((taskId) => {
      const trials = ordered.filter((t) => t.suite === suite.name && t.taskId === taskId);
      const passed = trials.filter((t) => t.passed).length;
      const targetBlocks = data.targets
        .map((target) => trials.filter((t) => t.target === target))
        .filter((list) => list.length > 0)
        .map((list) => {
          const first = list[0]!;
          const passes = list.filter((t) => t.passed).length;
          return details(
            `${first.target} · ${passes}/${list.length} passed`,
            false,
            ...list.map((trial) => trialHtml(trial, options)),
          );
        });
      return details(
        join(el('strong', {}, taskId), ` · ${passed}/${trials.length} passed`),
        false,
        ...targetBlocks,
      );
    });
    sections.push(
      details(join(el('strong', {}, suite.name), ` (${suite.kind})`), true, ...taskBlocks),
    );
  }

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(`Agent eval report ${run.id}`)}</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    `<body><main>${sections.map(render).join('\n')}</main></body>`,
    '</html>',
    '',
  ].join('\n');
}
