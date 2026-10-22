#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { loadConfig, resolveConfig } from './config.ts';
import { loadSuite } from './core/loader.ts';
import { jsonSchemas } from './core/schema.ts';
import { builtinGraders } from './graders/builtin.ts';
import type { RunResult } from './core/types.ts';
import { regradeRun } from './harness/regrade.ts';
import { runEval } from './harness/run.ts';
import { validateSuite } from './harness/validate.ts';
import {
  calibrate,
  labellingSheet,
  loadLabels,
  writeLabellingSheet,
} from './metrics/calibration.ts';
import { diffRuns } from './metrics/diff.ts';
import { graduationCandidates } from './metrics/lifecycle.ts';
import { summarize } from './metrics/stats.ts';
import { readRun, writeReports } from './report/write.ts';
import { startViewer } from './viewer/server.ts';

const usage = `agent-evals <command> [options]

  run --config <file> [--out <dir>] [--task <id,…>] [--trials <n>] [--concurrency <n>] [--k <n>] [--baseline <run>] [--reviews <file>] [--labels <file>] [--fail-under <pass@1>]
      Runs the config's suites against its targets and writes run.json, summary.json, report.md, report.html and the
      transcripts. --trials forces the trials of every task. --fail-under (0 to 1) exits 1 when a suite × target
      group's pass@1 is below it or the group has no graded trial.
  validate <suite.yaml>… [--config <file>]
      Checks every task: known graders, a reference solution, and the reference passes its graders (model graders only
      with --config, whose judge then grades).
  regrade <run> --config <file> [--out <dir>] [--k <n>] [--reviews <file>]
      Grades a run's stored transcripts again with the config's current tasks and graders (after a grader or task fix),
      without calling the agent, and writes the reports again; the judge's earlier verdicts are kept unless the config
      has a judge.
  report <run> [--baseline <run>] [--reviews <file>] [--labels <file>] [--k <n>]
      Writes the reports of a run again (summary.json among them), with the reviews of its failures and the human labels.
  diff <before> <after> [--k <n>] [--fail-on-regression]
      Lists the regressions and improvements between two runs; --fail-on-regression exits 1 when there are regressions.
  label <run> --out <labels.yaml> [--grader <id>] [--sample <n>] [--seed <n>]
      Writes a labelling sheet: a sample of judged trials for a person to label (judge calibration).
  calibrate <run> --labels <labels.yaml>
      Agreement and Cohen's kappa between the judge and the human labels.
  graduate <run>… [--k <n>] [--runs <n>]
      Capability tasks that passed every trial in the last runs: candidates for the regression suite. Each suite's
      graduation rule applies (else k 3 and 2 runs); --k and --runs override it for every suite.
  view [--root <dir>] [--labels <file>] [--port <n>] [--k <n>]
      Serves the local viewer on 127.0.0.1: the runs under the folder (default results), two runs side by side, the
      transcripts with filters, and labelling of the judges' dimensions into the labels file (default <root>/labels.yaml).
  schema [--write <dir>] [--check <dir>]
      Prints, writes or checks the JSON Schemas of the task and suite files.

A <run> is a run folder or its run.json. Options take a value as --name value or --name=value (use the second form
for a negative number). Exit codes: 0 when the command finished, 1 on an error, a failed check (validate,
schema --check) or a failed gate (run --fail-under, diff --fail-on-regression).`;

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

/** The numeric options and what each takes: whole numbers in a range, or `--fail-under`'s share. */
const numberOptions = {
  // Upper bounds keep a typo from queueing millions of trials or opening thousands of connections.
  trials: { min: 1, max: 1000 },
  concurrency: { min: 1, max: 256 },
  k: { min: 1, max: 1000 },
  sample: { min: 1, max: 100_000 },
  seed: {},
  runs: { min: 1, max: 1000 },
  port: { min: 0, max: 65_535 },
  'fail-under': { min: 0, max: 1, fraction: true },
} satisfies Record<string, { min?: number; max?: number; fraction?: boolean }>;

type NumberOption = keyof typeof numberOptions;

/** Reads the numeric options, refusing a value that isn't a number in the option's range. */
function numbers(values: Record<string, unknown>): Partial<Record<NumberOption, number>> {
  const read: Partial<Record<NumberOption, number>> = {};
  for (const [name, rule] of Object.entries(numberOptions) as [
    NumberOption,
    { min?: number; max?: number; fraction?: boolean },
  ][]) {
    const text = values[name];
    if (typeof text !== 'string') continue;
    const pattern = rule.fraction ? /^\d+(\.\d+)?$|^\.\d+$/ : /^-?\d+$/;
    const value = Number(text);
    const kind = rule.fraction ? 'a number' : 'a whole number';
    const range =
      rule.min !== undefined && rule.max !== undefined
        ? ` from ${rule.min} to ${rule.max}`
        : rule.min !== undefined
          ? ` of at least ${rule.min}`
          : '';
    if (
      !pattern.test(text.trim()) ||
      (rule.min !== undefined && value < rule.min) ||
      (rule.max !== undefined && value > rule.max)
    )
      fail(`--${name} takes ${kind}${range}, not "${text}"`);
    read[name] = value;
  }
  return read;
}

/** The suite × target groups whose pass@1 is below the gate, or that have no graded trial. */
function belowGate(run: RunResult, k: number, gate: number): string[] {
  const share = (value: number) => String(Math.round(value * 1000) / 1000);
  return summarize(run, { k })
    .groups.filter((group) => group.pass1 === null || group.pass1 < gate)
    .map(
      (group) =>
        `${group.suite} / ${group.target}: ${group.pass1 === null ? 'no graded trial' : `pass@1 ${share(group.pass1)}`} is below ${gate}`,
    );
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        config: { type: 'string' },
        out: { type: 'string' },
        task: { type: 'string' },
        trials: { type: 'string' },
        concurrency: { type: 'string' },
        baseline: { type: 'string' },
        reviews: { type: 'string' },
        labels: { type: 'string' },
        grader: { type: 'string' },
        sample: { type: 'string' },
        seed: { type: 'string' },
        k: { type: 'string' },
        runs: { type: 'string' },
        root: { type: 'string' },
        port: { type: 'string' },
        write: { type: 'string' },
        check: { type: 'string' },
        'fail-under': { type: 'string' },
        'fail-on-regression': { type: 'boolean' },
      },
    });
  } catch (error) {
    // An unknown option or a missing value: the message names it; the usage lists the options.
    return fail(
      `${error instanceof Error ? error.message : String(error)}\nagent-evals help lists the options.`,
    );
  }
  const { values, positionals } = parsed;
  const n = numbers(values);

  switch (command) {
    case 'run': {
      if (!values.config) fail('run needs --config');
      const { config, baseDir } = await loadConfig(values.config!);
      const resolved = resolveConfig(config, baseDir);
      const stamp = new Date()
        .toISOString()
        .replaceAll(':', '-')
        .replace(/\.\d+Z$/, 'Z');
      const out = resolve(values.out ?? join(resolved.out ?? 'results', stamp));
      mkdirSync(out, { recursive: true });
      let done = 0;
      const run = await runEval({
        ...resolved,
        trialsOverride: n.trials,
        concurrency: n.concurrency ?? resolved.concurrency,
        tasks: values.task?.split(','),
        outDir: out,
        onTrial: (t) =>
          console.log(
            `${++done} ${t.passed ? 'PASS' : t.status !== 'completed' ? t.status.toUpperCase() : t.ungraded ? 'UNGRADED' : 'FAIL'} ${t.suite}/${t.taskId} ${t.target} #${t.trial} score ${t.score.toFixed(2)}`,
          ),
      });
      const labels = values.labels ? loadLabels(values.labels) : undefined;
      const k = n.k ?? resolved.k;
      const paths = writeReports(run, out, {
        k,
        reviewsFile: values.reviews,
        labelsCalibration: labels ? calibrate(run, labels) : undefined,
        baseline: values.baseline ? readRun(values.baseline) : undefined,
      });
      console.log(`\n${Object.values(paths).join('\n')}`);
      if (n['fail-under'] !== undefined) {
        const below = belowGate(run, k, n['fail-under']);
        if (below.length > 0) {
          console.error(`\n--fail-under ${n['fail-under']} failed:\n${below.join('\n')}`);
          process.exitCode = 1;
        }
      }
      return;
    }
    case 'validate': {
      if (positionals.length === 0) fail('validate needs a suite file');
      const resolved = values.config
        ? await loadConfig(values.config).then(({ config, baseDir }) =>
            resolveConfig({ ...config, targets: [] }, baseDir),
          )
        : undefined;
      let ok = true;
      for (const file of positionals) {
        const check = await validateSuite(loadSuite(file), {
          graders: resolved?.graders ?? builtinGraders(),
          judge: resolved?.judge,
          judgeModels: resolved?.judgeModels,
          judgeToolResultMaxChars: resolved?.judgeToolResultMaxChars,
        });
        ok &&= check.ok;
        console.log(`${check.ok ? 'OK  ' : 'FAIL'} ${check.suite}: ${check.tasks.length} tasks`);
        for (const task of check.tasks.filter((t) => !t.ok))
          for (const problem of task.problems) console.log(`  ${task.taskId}: ${problem}`);
        if (check.skippedModelGraders)
          console.log(
            `  ${check.skippedModelGraders} model graders not run (no judge; pass --config)`,
          );
      }
      if (!ok) process.exit(1);
      return;
    }
    case 'regrade': {
      const [runPath] = positionals;
      if (!runPath || !values.config) fail('regrade needs a run and --config');
      const { config, baseDir } = await loadConfig(values.config!);
      const resolved = resolveConfig({ ...config, targets: [] }, baseDir);
      const run = await regradeRun(readRun(runPath!), resolved);
      const dir = resolve(
        values.out ?? (runPath!.endsWith('.json') ? resolve(runPath!, '..') : runPath!),
      );
      const paths = writeReports(run, dir, {
        k: n.k ?? resolved.k,
        reviewsFile: values.reviews ?? join(dir, 'reviews.yaml'),
      });
      console.log(Object.values(paths).join('\n'));
      return;
    }
    case 'report': {
      const [runPath] = positionals;
      if (!runPath) fail('report needs a run');
      const run = readRun(runPath!);
      const dir = runPath!.endsWith('.json') ? resolve(runPath!, '..') : resolve(runPath!);
      const labels = values.labels ? loadLabels(values.labels) : undefined;
      const paths = writeReports(run, dir, {
        k: n.k,
        reviewsFile: values.reviews ?? join(dir, 'reviews.yaml'),
        labelsCalibration: labels ? calibrate(run, labels) : undefined,
        baseline: values.baseline ? readRun(values.baseline) : undefined,
      });
      console.log(Object.values(paths).join('\n'));
      return;
    }
    case 'diff': {
      const [before, after] = positionals;
      if (!before || !after) fail('diff needs two runs');
      const diff = diffRuns(readRun(before!), readRun(after!), { k: n.k ?? 3 });
      console.log(JSON.stringify(diff, null, 2));
      if (values['fail-on-regression'] && diff.regressions > 0) {
        console.error(`--fail-on-regression: ${diff.regressions} regression(s)`);
        process.exitCode = 1;
      }
      return;
    }
    case 'label': {
      const [runPath] = positionals;
      if (!runPath || !values.out) fail('label needs a run and --out');
      const sheet = labellingSheet(readRun(runPath!), {
        grader: values.grader,
        sample: n.sample,
        seed: n.seed,
      });
      writeLabellingSheet(values.out!, sheet);
      console.log(`${sheet.length} entries to label in ${values.out}`);
      return;
    }
    case 'calibrate': {
      const [runPath] = positionals;
      if (!runPath || !values.labels) fail('calibrate needs a run and --labels');
      console.log(
        JSON.stringify(calibrate(readRun(runPath!), loadLabels(values.labels!)), null, 2),
      );
      return;
    }
    case 'graduate': {
      if (positionals.length === 0) fail('graduate needs runs, oldest first');
      // Without --k and --runs, each suite's own graduation rule applies.
      const candidates = graduationCandidates(positionals.map(readRun), {
        k: n.k,
        runs: n.runs,
      });
      console.log(JSON.stringify(candidates, null, 2));
      return;
    }
    case 'view': {
      const viewer = await startViewer({
        root: resolve(values.root ?? 'results'),
        labelsFile: values.labels && resolve(values.labels),
        port: n.port ?? 4177,
        k: n.k,
      });
      console.log(
        `The eval viewer runs on ${viewer.url} (labels: ${viewer.labelsFile}). Ctrl+C stops it.`,
      );
      // The server keeps the process alive until it is stopped.
      return;
    }
    case 'schema': {
      const schemas = jsonSchemas();
      const files = {
        'task.schema.json': `${JSON.stringify(schemas.task, null, 2)}\n`,
        'suite.schema.json': `${JSON.stringify(schemas.suite, null, 2)}\n`,
      };
      if (values.check) {
        const stale = Object.entries(files).filter(([name, text]) => {
          try {
            return readFileSync(join(values.check!, name), 'utf8') !== text;
          } catch {
            return true;
          }
        });
        if (stale.length)
          fail(`out of date: ${stale.map(([n]) => n).join(', ')} (run the schema script)`);
        return;
      }
      if (values.write) {
        mkdirSync(values.write, { recursive: true });
        for (const [name, text] of Object.entries(files))
          writeFileSync(join(values.write, name), text);
        return;
      }
      console.log(JSON.stringify(schemas, null, 2));
      return;
    }
    default:
      console.log(usage);
      if (command && command !== 'help' && command !== '--help') process.exit(1);
  }
}

await main(process.argv.slice(2));
