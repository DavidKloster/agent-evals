import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { RunResult } from '../src/core/types.ts';
import { markdownReport } from '../src/report/markdown.ts';
import { htmlReport } from '../src/report/html.ts';
import { failureTable, ungradedTrials } from '../src/report/reviews.ts';
import { trialResult } from './fixtures.ts';

/** Fixes F5, F6, F7 (the CLI side) and F13 of the release table. */

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(packageDir, 'src', 'cli.ts');

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function agentEvals(...args: string[]): Promise<CliResult> {
  return new Promise((done) => {
    execFile(
      process.execPath,
      [cli, ...args],
      { cwd: packageDir, timeout: 60_000 },
      (error, stdout, stderr) =>
        done({
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          stdout,
          stderr,
        }),
    );
  });
}

const runOf = (trials: Parameters<typeof trialResult>[0][]): RunResult => ({
  id: 'r',
  startedAt: '2026-10-22T10:00:00.000Z',
  finishedAt: '2026-10-22T10:01:00.000Z',
  suites: [{ name: 'core', kind: 'capability', tasks: ['task-1'] }],
  targets: [{ name: 'model-a' }],
  trials: trials.map((t) => trialResult(t)),
});

let dir: string;

/** A suite of two tasks (`ok` passes, `broken` fails as the agent's error) and a model-graded `judged` task. */
function writeFixture(): void {
  mkdirSync(join(dir, 'suite', 'tasks'), { recursive: true });
  writeFileSync(
    join(dir, 'suite', 'suite.yaml'),
    'name: gate\nkind: capability\ndefaults: { trials: 3 }\n',
  );
  writeFileSync(
    join(dir, 'suite', 'tasks', 'tasks.yaml'),
    [
      '- { id: ok, input: { turns: [hi] }, graders: [{ type: no_error }] }',
      '- { id: broken, input: { turns: [hi] }, graders: [{ type: no_error }] }',
      '- id: judged',
      '  input: { turns: [hi] }',
      '  graders:',
      '    - type: judge',
      '      rubric: [{ name: kind, question: Is it kind?, pass: yes, fail: no }]',
    ].join('\n'),
  );
  const config = (broken: string) =>
    [
      'suites: [suite/suite.yaml]',
      'targets:',
      '  - name: scripted',
      '    adapter: scripted',
      '    options:',
      '      replies:',
      "        ok: [{ text: 'fine' }]",
      `        broken: [${broken}]`,
      "        judged: [{ text: 'fine' }]",
    ].join('\n');
  writeFileSync(join(dir, 'good.yaml'), config("{ text: 'fine' }"));
  writeFileSync(join(dir, 'bad.yaml'), config("{ text: 'x', fail: boom }"));
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-evals-fix-cli-'));
  writeFixture();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('F5: ungraded trials', () => {
  const run = runOf([
    { taskId: 'task-1', trial: 0, passed: false, status: 'completed' },
    { taskId: 'task-1', trial: 1, passed: false, status: 'completed', ungraded: true, grades: [] },
    { taskId: 'task-1', trial: 2, passed: true },
  ]);

  it('are left out of the failure table and listed apart', () => {
    expect(failureTable(run, []).map((row) => row.trial)).toEqual([0]);
    expect(ungradedTrials(run)).toEqual([
      {
        suite: 'core',
        taskId: 'task-1',
        target: 'model-a',
        trial: 1,
        status: 'completed',
        reason: 'no judge for its model graders',
      },
    ]);
    const judgeDown = runOf([
      { passed: false, ungraded: true, grades: [], gradingError: 'the judge failed: HTTP 503' },
    ]);
    expect(ungradedTrials(judgeDown)[0]!.reason).toBe('the judge failed: HTTP 503');
    expect(failureTable(judgeDown, [])).toEqual([]);
  });

  it('get a section of their own in both reports', () => {
    const md = markdownReport(run);
    expect(md).toMatch(/## Ungraded trials/);
    const failures = md.slice(md.indexOf('## Failures'), md.indexOf('## Ungraded trials'));
    expect(failures).not.toMatch(/\| core \| task-1 \| model-a \| 1 \|/);
    expect(htmlReport(run)).toContain('id="ungraded"');
  });

  it('say so instead of "every trial passed" when nothing graded failed', () => {
    const md = markdownReport(runOf([{ passed: false, ungraded: true, grades: [] }]));
    expect(md).not.toContain('Every trial passed.');
    expect(md).toContain('No graded trial failed.');
  });

  it('are listed apart in summary.json', async () => {
    const out = join(dir, 'f5');
    const result = await agentEvals('run', '--config', join(dir, 'good.yaml'), '--out', out);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/UNGRADED gate\/judged scripted #0/);
    const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8')) as {
      failures: unknown[];
      ungraded: { taskId: string }[];
    };
    expect(summary.failures).toEqual([]);
    expect(summary.ungraded.map((t) => t.taskId)).toEqual(['judged', 'judged', 'judged']);
  });
});

describe('F6: exit codes for CI', () => {
  it('run --fail-under exits 1 when a group is below it, 0 otherwise', async () => {
    // `bad`: ok passes 3 of 3, broken 0 of 3, judged is ungraded: the group's pass@1 is 0.5.
    const below = await agentEvals(
      'run',
      '--config',
      join(dir, 'bad.yaml'),
      '--out',
      join(dir, 'f6-below'),
      '--fail-under',
      '0.6',
    );
    expect(below.code).toBe(1);
    expect(below.stderr).toMatch(/gate.*scripted.*pass@1 0\.5.*below 0\.6/);
    // The reports are written before the gate decides.
    expect(readFileSync(join(dir, 'f6-below', 'summary.json'), 'utf8')).toContain('"failures"');

    const at = await agentEvals(
      'run',
      '--config',
      join(dir, 'bad.yaml'),
      '--out',
      join(dir, 'f6-at'),
      '--fail-under',
      '0.5',
    );
    expect(at.code).toBe(0);
  });

  it('run without --fail-under still exits 0 when trials fail', async () => {
    const result = await agentEvals(
      'run',
      '--config',
      join(dir, 'bad.yaml'),
      '--out',
      join(dir, 'f6-plain'),
    );
    expect(result.code).toBe(0);
  });

  it('diff --fail-on-regression exits 1 with regressions, 0 without', async () => {
    const good = join(dir, 'f6-good');
    const bad = join(dir, 'f6-bad');
    expect((await agentEvals('run', '--config', join(dir, 'good.yaml'), '--out', good)).code).toBe(
      0,
    );
    expect((await agentEvals('run', '--config', join(dir, 'bad.yaml'), '--out', bad)).code).toBe(0);

    const regressed = await agentEvals('diff', good, bad, '--fail-on-regression');
    expect(regressed.code).toBe(1);
    expect(JSON.parse(regressed.stdout)).toMatchObject({ regressions: 1 });
    expect((await agentEvals('diff', bad, good, '--fail-on-regression')).code).toBe(0);
    expect((await agentEvals('diff', good, bad)).code).toBe(0);
  });
});

describe('F7: graduate', () => {
  it("applies each suite's own graduation rule unless --k or --runs is given", async () => {
    const graduationDir = join(dir, 'graduation');
    mkdirSync(join(graduationDir, 'suite', 'tasks'), { recursive: true });
    // The suite's rule asks for one run with k 1; the CLI's old defaults (3 and 2) would find nothing in one run.
    writeFileSync(
      join(graduationDir, 'suite', 'suite.yaml'),
      'name: grad\nkind: capability\ngraduation: { k: 1, runs: 1 }\ndefaults: { trials: 1 }\n',
    );
    writeFileSync(
      join(graduationDir, 'suite', 'tasks', 'tasks.yaml'),
      '- { id: ok, input: { turns: [hi] }, graders: [{ type: no_error }] }\n',
    );
    writeFileSync(
      join(graduationDir, 'config.yaml'),
      [
        'suites: [suite/suite.yaml]',
        'targets:',
        "  - { name: scripted, adapter: scripted, options: { replies: { ok: [{ text: 'fine' }] } } }",
      ].join('\n'),
    );
    const out = join(graduationDir, 'run');
    expect(
      (await agentEvals('run', '--config', join(graduationDir, 'config.yaml'), '--out', out)).code,
    ).toBe(0);

    const bySuite = await agentEvals('graduate', out);
    expect(bySuite.code).toBe(0);
    expect(JSON.parse(bySuite.stdout)).toMatchObject([{ suite: 'grad', taskId: 'ok' }]);

    const byOption = await agentEvals('graduate', out, '--runs=2');
    expect(JSON.parse(byOption.stdout)).toEqual([]);
  });
});

describe('F13: CLI numbers and usage', () => {
  it.each([
    ['run', '--trials', 'abc'],
    ['run', '--trials', '0'],
    ['run', '--concurrency', '2x'],
    ['run', '--fail-under', '1.5'],
    ['run', '--fail-under', 'high'],
    ['diff', '--k', '0'],
    ['graduate', '--runs', '-1'],
    ['view', '--port', 'x'],
    ['view', '--port', '70000'],
    ['label', '--sample', '1.5'],
  ])('%s %s %s is refused with a clear error', async (command, option, value) => {
    // `--name=value`, so a negative number isn't read as an option.
    const result = await agentEvals(command, `${option}=${value}`);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(option);
    expect(result.stderr).toContain(value);
    expect(result.stderr).not.toMatch(/\n\s+at /);
  });

  it('refuses an unknown option without a stack trace', async () => {
    const result = await agentEvals('run', '--no-such-option');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--no-such-option');
    expect(result.stderr).not.toMatch(/\n\s+at /);
  });

  it('--trials overrides the trials of every task and suite', async () => {
    const out = join(dir, 'f13-trials');
    const result = await agentEvals(
      'run',
      '--config',
      join(dir, 'good.yaml'),
      '--out',
      out,
      '--trials',
      '1',
    );
    expect(result.code).toBe(0);
    const run = JSON.parse(readFileSync(join(out, 'run.json'), 'utf8')) as RunResult;
    expect(run.trials).toHaveLength(3);
  });

  it('lists every option each command reads, and summary.json', async () => {
    const { stdout } = await agentEvals('help');
    const line = (command: string) =>
      stdout.split('\n').find((l) => l.trimStart().startsWith(`${command} `)) ?? '';
    for (const option of [
      '--config',
      '--out',
      '--task',
      '--trials',
      '--concurrency',
      '--k',
      '--baseline',
      '--reviews',
      '--labels',
      '--fail-under',
    ])
      expect(line('run')).toContain(option);
    for (const option of ['--config', '--out', '--k', '--reviews'])
      expect(line('regrade')).toContain(option);
    for (const option of ['--k', '--fail-on-regression']) expect(line('diff')).toContain(option);
    expect(stdout).toContain('summary.json');
    expect(stdout).toMatch(/exit/i);
  });
});
