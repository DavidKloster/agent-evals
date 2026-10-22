import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  FORMAT_VERSION,
  type CalibrationReport,
  type Review,
  type RunResult,
} from '../src/core/types.ts';
import { diffRuns } from '../src/metrics/diff.ts';
import { summarize } from '../src/metrics/stats.ts';
import { escapeHtml, htmlReport } from '../src/report/html.ts';
import { escapeCell, markdownReport } from '../src/report/markdown.ts';
import { readRun, writeReports } from '../src/report/write.ts';
import { graderResult, metrics, runResult, trialResult, trialsOf } from './fixtures.ts';

const dir = mkdtempSync(join(tmpdir(), 'agent-evals-report-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const XSS = '<script>alert("pwned")</script>';

function sampleRun(): RunResult {
  return runResult(
    [
      ...trialsOf(3, 3, {
        taskId: 'find-invoice',
        metrics: metrics({ costUsd: 0.0123, ttftMs: [250], replyMs: [1200] }),
      }),
      trialResult({ taskId: 'sum-totals', trial: 0 }),
      trialResult({
        taskId: 'sum-totals',
        trial: 1,
        passed: false,
        score: 0.5,
        grades: [
          graderResult({
            id: 'answer',
            passed: false,
            score: 0.5,
            assertions: [
              {
                name: 'mentions | the total',
                passed: false,
                expected: 1190,
                actual: 1000,
                message: 'wrong total',
              },
            ],
          }),
        ],
        transcript: [
          { type: 'message', at: 0, role: 'user', text: 'What is the total?' },
          {
            type: 'tool_call',
            at: 10,
            id: 'c1',
            name: 'search_documents',
            args: { query: 'invoice', vendor: XSS },
          },
          {
            type: 'tool_result',
            at: 20,
            id: 'c1',
            name: 'search_documents',
            result: { hits: ['x'.repeat(5000)] },
          },
          {
            type: 'model_call',
            at: 30,
            model: 'model-a',
            startedAt: 0,
            firstTokenAt: 15,
            endedAt: 30,
            inputTokens: 10,
            outputTokens: 5,
            costUsd: 0.001,
          },
          { type: 'message', at: 40, role: 'assistant', text: `The total is 1000. ${XSS}` },
        ],
      }),
      trialResult({ taskId: 'sum-totals', trial: 2, status: 'infra_error' }),
      trialResult({ taskId: 'sum-totals', trial: 3, status: 'timeout' }),
      ...trialsOf(3, 1, { taskId: 'find-invoice', target: 'model-b' }),
      ...trialsOf(3, 0, { taskId: 'impossible' }),
      ...trialsOf(3, 3, { taskId: 'login', suite: 'regress', suiteKind: 'regression' }),
    ],
    undefined,
    {
      targets: [{ name: 'model-a', description: 'the small model' }, { name: 'model-b' }],
      meta: { commit: 'abc123' },
    },
  );
}

const reviews: Review[] = [
  {
    taskId: 'sum-totals',
    target: 'model-a',
    trial: 1,
    class: 'agent',
    annotation: 'Added the net amounts | ignored VAT.',
  },
];

const calibration: CalibrationReport = {
  dimensions: [
    {
      grader: 'judge',
      dimension: 'helpful',
      n: 10,
      agreement: 0.9,
      kappa: 0.78,
      unknownRate: 0.1,
      humanUnknown: 0,
      confusion: [],
    },
  ],
  sample: [
    {
      taskId: 'find-invoice',
      target: 'model-a',
      trial: 0,
      grader: 'judge',
      dimension: 'helpful',
      label: 'pass',
      judge: 'fail',
      judgeReason: 'too short',
    },
  ],
};

describe('escapeCell', () => {
  it('escapes pipes and joins lines', () => {
    expect(escapeCell('a | b\nc')).toBe('a \\| b c');
  });
});

describe('markdownReport', () => {
  const run = sampleRun();
  const md = markdownReport(run, { k: 3, summary: summarize(run), reviews, calibration });

  it('has a title, the run meta and a comparison table per suite', () => {
    expect(md).toMatch(/^# Agent eval report\n/);
    expect(md).toContain('commit: abc123');
    expect(md).toContain('### `core` (capability)');
    expect(md).toContain('### `regress` (regression)');
    expect(md).toContain('| Target | Tasks | pass@1 | pass@3 | pass^3 | Partial |');
    // model-b ran one task with 1 of 3 passing.
    expect(md).toMatch(/\| model-b \| 1 \| 33\.3% \| 100\.0% \| 0\.0% \|/);
    expect(md).toContain('$0.0');
  });

  it('formats percentages, dollars and milliseconds', () => {
    const row = md.split('\n').find((line) => line.startsWith('| model-a | 3 |'))!;
    expect(row).toBeDefined();
    expect(row).toMatch(/\| \d+\.\d% \|/);
    expect(row).toMatch(/\$\d\.\d{4}/);
    expect(row).toMatch(/\| \d+ \/ \d+ \|/);
  });

  it('lists suspected broken tasks and the task matrix', () => {
    expect(md).toContain('## Suspected broken tasks');
    expect(md).toContain('`core/impossible`: 0 passes in 3 trials');
    expect(md).toContain('| find-invoice | 3/3 · pass^3 100.0% | 1/3 · pass^3 0.0% |');
    expect(md).toContain('(+1 infra)');
  });

  it('notes a saturated regression-free suite only for capability suites', () => {
    expect(md).toContain('## Saturation');
    expect(md).not.toMatch(/`regress` × .*saturated/);
  });

  it('counts failure classes and shows the annotated example first', () => {
    expect(md).toMatch(/\| agent \| 1 \|/);
    expect(md).toMatch(/\| infra \| 1 \|/);
    expect(md).toMatch(/\| unreviewed \| \d+ \|/);
    const examples = md.slice(md.indexOf('## Failure examples'));
    expect(examples).toMatch(
      /^## Failure examples\n\n### 1\. `core\/sum-totals` · `model-a` · trial 1 · agent/,
    );
    expect(examples).toContain('> Added the net amounts | ignored VAT.');
    expect(examples).toContain('answer: mentions \\| the total (wrong total)'.replace('\\|', '|'));
    expect(examples).toContain('user: What is the total?');
    expect(examples).toContain('tool: search_documents(');
    expect(examples).toContain('answer: The total is 1000.');
  });

  it('escapes pipes in table cells', () => {
    const failing = md
      .split('\n')
      .find((line) => line.startsWith('| core | sum-totals | model-a | 1 |'))!;
    expect(failing).toContain('mentions \\| the total');
  });

  it('shows at most `examples` examples', () => {
    const short = markdownReport(run, { reviews, examples: 1 });
    expect(short.match(/^### \d+\. /gm)).toHaveLength(1);
    expect(markdownReport(run, { reviews, examples: 0 })).not.toContain('## Failure examples');
  });

  it('has the calibration section with its sample', () => {
    expect(md).toContain('## Judge calibration');
    expect(md).toContain('| judge | helpful | 10 | 90.0% | 0.78 | 10.0% |');
    expect(md).toContain(
      '| find-invoice | model-a | 0 | judge | helpful | pass | fail | too short |',
    );
  });

  it('has the diff section with regressions first', () => {
    const before = runResult([
      ...trialsOf(3, 3, { taskId: 'find-invoice' }),
      ...trialsOf(3, 3, { taskId: 'find-invoice', target: 'model-b' }),
      ...trialsOf(3, 0, { taskId: 'gone' }),
    ]);
    const diffMd = markdownReport(run, { diff: diffRuns(before, run) });
    const section = diffMd.slice(diffMd.indexOf('## Changes since'));
    expect(section).toContain('regression(s)');
    const rows = section
      .split('\n')
      .filter((line) => /^\| (regression|improvement|new|removed) \|/.test(line));
    expect(rows[0]).toMatch(/^\| regression \| core \| find-invoice \| model-b \|/);
    expect(rows.some((row) => row.startsWith('| removed | core | gone |'))).toBe(true);
    expect(section).toContain('1 regression(s)');
  });

  it('works without options', () => {
    expect(markdownReport(runResult(trialsOf(3, 3)))).toContain('Every trial passed.');
  });
});

describe('htmlReport', () => {
  const run = sampleRun();
  const html = htmlReport(run, { k: 3, reviews, calibration });

  it('escapes the text of transcripts and answers', () => {
    expect(html).not.toContain(XSS);
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain(escapeHtml(XSS));
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
  });

  it('is self-contained', () => {
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('<style>');
    expect(html).toContain('prefers-color-scheme:dark');
    expect(html).not.toMatch(/<link|src=|https?:\/\//);
  });

  it('has the report sections', () => {
    for (const heading of [
      'Model comparison',
      'Saturation',
      'Suspected broken tasks',
      'Tasks',
      'Failures',
      'Failure examples',
      'Judge calibration',
      'Transcripts',
    ])
      expect(html).toContain(`>${heading}</h2>`);
  });

  it('renders every trial with its grades, outcome and review', () => {
    const trials = html.match(/ trial \d+ · score /g) ?? [];
    expect(trials).toHaveLength(run.trials.length);
    expect(html).toContain('tool call search_documents');
    expect(html).toContain('&quot;query&quot;: &quot;invoice&quot;');
    expect(html).toContain('mentions | the total');
    expect(html).toContain('expected: <code>1190</code>');
    expect(html).toContain('Review: agent');
    expect(html).toContain('<summary>Outcome</summary>');
    expect(html).toContain('model-a · 10 in / 5 out tokens · $0.0010');
    expect(html).toContain('timeout');
  });

  it('truncates long tool results', () => {
    expect(html).not.toContain('x'.repeat(2500));
    expect(html).toMatch(/more characters\)/);
  });

  it('escapes the run meta and annotations', () => {
    const evil = runResult(trialsOf(3, 0), undefined, { meta: { note: XSS } });
    const page = htmlReport(evil, {
      reviews: [{ taskId: 'task-1', target: 'model-a', class: 'agent', annotation: XSS }],
    });
    expect(page).not.toMatch(/<script/i);
  });
});

describe('writeReports and readRun', () => {
  it('writes the four files and reads the run back', () => {
    const run = sampleRun();
    const reviewsFile = join(dir, 'reviews.yaml');
    writeFileSync(
      reviewsFile,
      '- taskId: sum-totals\n  target: model-a\n  trial: 1\n  class: agent\n  annotation: Ignored VAT.\n',
    );
    const out = join(dir, 'out');
    const paths = writeReports(run, out, {
      reviewsFile,
      baseline: runResult(trialsOf(3, 3, { taskId: 'find-invoice' })),
      labelsCalibration: calibration,
    });
    for (const path of Object.values(paths) as string[]) expect(existsSync(path)).toBe(true);
    // A run built without a version is written, and read back, in today's format.
    expect(readRun(out)).toEqual({
      ...JSON.parse(JSON.stringify(run)),
      formatVersion: FORMAT_VERSION,
    });
    expect(readRun(paths.run).id).toBe(run.id);

    const summary = JSON.parse(readFileSync(paths.summary, 'utf8')) as {
      summary: { k: number };
      saturation: unknown;
      diff: { tasks: unknown[] };
      failures: { trial: number; taskId: string; class: string }[];
    };
    expect(summary.summary.k).toBe(3);
    expect(summary.saturation).toBeInstanceOf(Array);
    expect(summary.diff.tasks.length).toBeGreaterThan(0);
    expect(summary.failures.find((f) => f.taskId === 'sum-totals' && f.trial === 1)?.class).toBe(
      'agent',
    );
    expect(readFileSync(paths.markdown, 'utf8')).toContain('> Ignored VAT.');
    expect(readFileSync(paths.html, 'utf8')).toContain('Ignored VAT.');
  });

  it('rejects a file that is not a run', () => {
    const file = join(dir, 'not-a-run.json');
    writeFileSync(file, '{"hello": 1}');
    expect(() => readRun(file)).toThrow(/not a run/);
  });
});
