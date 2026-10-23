/** The CLI's interface: the usage it prints and the options it parses (a module of its own, so tests can read them). */

export const usage = `agent-evals <command> [options]

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

/** Every option of every command, for `parseArgs`; each command reads the ones its usage line names. */
export const cliOptions = {
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
} as const;
