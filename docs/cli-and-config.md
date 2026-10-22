# CLI and configuration

The `agent-evals` command runs suites against targets, checks tasks, writes and compares reports,
supports judge calibration and serves the local viewer. A run reads a **configuration file** that names
the suites, the targets, the judge and the run's settings.

## Running the CLI

After installing the package, the CLI is the `agent-evals` binary:

```sh
npm install --save-dev @agent-evals/core
npx agent-evals validate evals/regression/suite.yaml
```

The published package is JavaScript and needs Node 22.18 or later. Until it is published, and in
any source checkout, run the CLI file itself after `npm install`: `node src/cli.ts …` in place of
`npx agent-evals …` (Node 22.18 and later strip the TypeScript types themselves, outside
`node_modules`). The examples on this page use the example suites that ship in the repository's
`examples/` folder and run from the package's root.

```text
agent-evals <command> [options]
```

A `<run>` argument is a run folder or the `run.json` in it. Options take a value as `--name value` or
`--name=value`; write a negative number as `--seed=-1`, or it reads as an option. Numeric options are
checked before the command runs: `--trials`, `--concurrency`, `--k`, `--sample` and `--runs` take a
whole number of at least 1, `--seed` any whole number, `--port` a whole number from 0 to 65535, and
`--fail-under` a number from 0 to 1. Any other value (`--trials abc`, `--k 0`) is an error that names
the option, with exit code 1.

Every command accepts the same set of option names and ignores the ones it does not use; an option name
that does not exist at all is an error. `agent-evals`, `agent-evals help` and `agent-evals --help` print
the usage.

## Exit codes

| Code | When                                                                                                                                                                                                                                                                                                                                                                    |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | The command finished. For `run` without `--fail-under`, also when trials failed; for `diff` without `--fail-on-regression`, also when there are regressions.                                                                                                                                                                                                            |
| 1    | A required argument is missing, a numeric option is invalid, `validate` found a problem, `schema --check` found stale files, the command or an option is unknown, a gate failed (`run --fail-under`, `diff --fail-on-regression`), or an error was thrown (a file that does not exist, an invalid suite or task, a missing API key, an invalid reviews or labels file). |

To gate a pipeline on a run, pass `run --fail-under <pass@1>` or `diff --fail-on-regression`. For any
other rule, read `summary.json` (for example the groups' `passHatK`, or the diff's `regressions`) and
decide there.

## Commands

### `run`

```text
agent-evals run --config <file> [--out <dir>] [--task <id,…>] [--trials <n>] [--concurrency <n>]
                [--k <n>] [--baseline <run>] [--reviews <file>] [--labels <file>] [--fail-under <pass@1>]
```

Runs every task of the configuration's suites against every target, grades the trials, and writes
`run.json`, `summary.json`, `report.md`, `report.html` and the transcripts.

| Option          | Default                                                       | Meaning                                                                                                                    |
| --------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `--config`      | required                                                      | The configuration file.                                                                                                    |
| `--out`         | `<config out>/<time>`, else `results/<time>`                  | The run folder. Given, it is used as it is, with no time added.                                                            |
| `--task`        | every task                                                    | Only these task ids, separated by commas.                                                                                  |
| `--trials`      | the task's, the suite's, the configuration's `trials`, else 3 | Trials per task and target, forced for every task over the task's and suite's own `trials` (`runEval`'s `trialsOverride`). |
| `--concurrency` | the configuration's `concurrency`, else 4                     | Trials that run at the same time, over all tasks and targets.                                                              |
| `--k`           | the configuration's `k`, else 3                               | The k of pass@k and pass^k in the reports.                                                                                 |
| `--baseline`    |                                                               | An earlier run to compare with: the reports and `summary.json` get the diff.                                               |
| `--reviews`     |                                                               | A reviews file with the failure classes. `run` reads none unless this is given.                                            |
| `--labels`      |                                                               | A labels file: the reports and `summary.json` get the judge calibration.                                                   |
| `--fail-under`  |                                                               | A pass@1 from 0 to 1: exit 1 when a group falls below it (see below).                                                      |

`<time>` is the start time in UTC with `:` replaced by `-` and no milliseconds, such as
`2026-10-22T11-30-06Z`. The default `results` folder is relative to the current directory; a
configuration's `out` is relative to the configuration file.

`run` prints one line per finished trial, in the order trials finish, then the four report paths:

```text
1 PASS invoice-desk-regression/due-date model-a #0 score 1.00
2 FAIL invoice-desk-regression/german-formal model-a #1 score 0.50
3 INFRA_ERROR invoice-desk-capability/refuse-delete model-b #0 score 0.00
```

The word is `PASS` for a passed trial, `FAIL` for a completed one that did not pass, `UNGRADED` for a
completed one no grader ran on, and `AGENT_ERROR`, `TIMEOUT` or `INFRA_ERROR` otherwise. The number before the trial is
`#<trial index>`.

**`--fail-under <pass@1>`** is the gate for CI. After the reports are written, `run` checks every
suite × target group of `summary.json`: when a group's `pass1` is below the value, or the group has no
graded trial at all (`pass1` is `null`: every trial was an infrastructure error or ungraded), it prints
the groups to stderr and exits 1:

```text
--fail-under 0.9 failed:
invoice-desk-capability / model-a: pass@1 0.8 is below 0.9
```

The gate is per group, not over the whole run, so one weak suite or model can't hide behind a strong
one. Gate the regression suite near 1 and leave capability suites ungated by running them with a
config of their own.

A dry run of the example suites, which replays each task's reference solution and needs no key:

```sh
npx agent-evals run --config examples/invoice-desk/eval.replay.yaml --out /tmp/evals/replay
```

### `validate`

```text
agent-evals validate <suite file>… [--config <file>]
```

Checks every task of each suite: it has graders, every grader type is known, it has a reference
solution, and the reference passes every grader and the task's scoring. See [Reference solutions and
validate](task-and-suite-files.md#reference-solutions-and-validate).

| Option     | Default              | Meaning                                                                                                          |
| ---------- | -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `--config` | the built-in graders | Use the configuration's graders and fact matchers, and its judge for the model graders. Its targets are ignored. |

Without `--config`, model graders are skipped and counted. The output has one line per suite, then
the problems of the failed tasks:

```text
OK   invoice-desk-regression: 5 tasks
OK   invoice-desk-capability: 5 tasks
  2 model graders not run (no judge; pass --config)
```

The exit code is 1 when any task has a problem. `validate` makes no model call unless the configuration
has a judge, so it fits a CI job:

```sh
npx agent-evals validate examples/invoice-desk/regression/suite.yaml examples/invoice-desk/capability/suite.yaml
```

### `regrade`

```text
agent-evals regrade <run> --config <file> [--out <dir>] [--k <n>] [--reviews <file>]
```

Grades a run's stored transcripts and outcomes again with the suites, tasks and graders of the
configuration as they are now, without calling the agent. Use it after you found a grader or a task
unfair while reading transcripts.

| Option      | Default                         | Meaning                                                                                     |
| ----------- | ------------------------------- | ------------------------------------------------------------------------------------------- |
| `--config`  | required                        | Supplies the suites, graders, fact matchers and judge. Its targets are ignored.             |
| `--out`     | the run's folder                | Where the reports go. By default `run.json` and the reports in the run folder are replaced. |
| `--k`       | the configuration's `k`, else 3 | The k of the reports.                                                                       |
| `--reviews` | `<out>/reviews.yaml`            | The reviews file.                                                                           |

- Trials are matched to tasks by suite name and task id. A trial whose suite or task is gone, and a
  trial with status `infra_error`, keeps its grades.
- Without a judge, the model graders' earlier results are kept.
- The run's `meta` gets `regradedAt`. The transcript files are not rewritten.

```sh
npx agent-evals regrade /tmp/evals/replay --config examples/invoice-desk/eval.replay.yaml
```

### `report`

```text
agent-evals report <run> [--baseline <run>] [--reviews <file>] [--labels <file>] [--k <n>]
```

Writes `run.json`, `summary.json`, `report.md` and `report.html` of a run again, into the run's
folder: with the failure classes of the reviews, the human labels, or another baseline.

| Option       | Default                     | Meaning                                      |
| ------------ | --------------------------- | -------------------------------------------- |
| `--baseline` |                             | An earlier run to compare with.              |
| `--reviews`  | `<run folder>/reviews.yaml` | The reviews file. A missing file means none. |
| `--labels`   |                             | A labels file for the judge calibration.     |
| `--k`        | 3                           | The k of pass@k and pass^k.                  |

### `diff`

```text
agent-evals diff <before> <after> [--k <n>] [--fail-on-regression]
```

Compares two runs task by task and prints the comparison as JSON (the [`RunDiff`
format](transcript-format.md#rundiff)). A regression is a task whose pass^k fell from 1, or whose
pass@1 dropped by 0.34 or more. `--k` defaults to 3. The exit code is 0 whatever the result, unless
`--fail-on-regression` is given: then it is 1 when the diff has a regression (`regressions` > 0), with
the count on stderr after the JSON.

```sh
npx agent-evals diff /tmp/evals/before /tmp/evals/replay
```

### `label`

```text
agent-evals label <run> --out <labels.yaml> [--grader <id>] [--sample <n>] [--seed <n>]
```

Writes a labelling sheet: one entry per rubric dimension of each sampled trial a judge graded, for a
person to fill in. The judge's verdict is left out. See [the labels file](transcript-format.md#the-labels-file).

| Option     | Default              | Meaning                                                                        |
| ---------- | -------------------- | ------------------------------------------------------------------------------ |
| `--out`    | required             | The sheet to write (folders are created). An existing file is replaced.        |
| `--grader` | every `judge` grader | Only the grader with this id (any grader whose results hold judge dimensions). |
| `--sample` | every judged trial   | How many trials to draw.                                                       |
| `--seed`   | 1                    | The seed of the draw: the same seed draws the same trials.                     |

It prints `<n> entries to label in <file>`.

### `calibrate`

```text
agent-evals calibrate <run> --labels <labels.yaml>
```

Compares the judge's verdicts in the run with the human labels and prints the [calibration
report](transcript-format.md#calibrationreport) as JSON: agreement, Cohen's kappa, the judge's unknown
rate and the confusion per grader and dimension. `--labels` is required.

### `graduate`

```text
agent-evals graduate <run>… [--k <n>] [--runs <n>]
```

Prints, as JSON, the capability tasks that every target passed consistently (pass^k = 1) in each of
the last `runs` runs the task ran in: candidates to move to the regression suite. Name the runs
oldest first. Each suite's `graduation` rule (`{ k, runs }` in the suite file) applies, else k 3 and
2 runs; `--k` and `--runs`, when given, override it for every suite.

```sh
npx agent-evals graduate /tmp/evals/before /tmp/evals/replay
```

### `view`

```text
agent-evals view [--root <dir>] [--labels <file>] [--port <n>] [--k <n>]
```

Serves the local viewer on `127.0.0.1` until you stop it with Ctrl+C. See [Viewer](viewer.md).

| Option     | Default              | Meaning                                                                 |
| ---------- | -------------------- | ----------------------------------------------------------------------- |
| `--root`   | `results`            | The results folder; run folders up to three levels below it are listed. |
| `--labels` | `<root>/labels.yaml` | The labels file the viewer writes.                                      |
| `--port`   | 4177                 | The port. `0` picks a free one.                                         |
| `--k`      | 3                    | The k of pass@k and pass^k.                                             |

### `schema`

```text
agent-evals schema [--write <dir>] [--check <dir>]
```

Without options, prints `{ "task": …, "suite": … }`, the JSON Schemas of the task and suite files.
`--write <dir>` writes `task.schema.json` and `suite.schema.json` into the folder. `--check <dir>`
compares the files in the folder with the current schemas and exits with 1 when one is missing or
different. See [JSON Schemas for editors](task-and-suite-files.md#json-schemas-for-editors).

```sh
npx agent-evals schema --check node_modules/@agent-evals/core/schema
```

## Configuration

A configuration is either:

- a **YAML or JSON file** (`.json` is read as JSON, any other extension as YAML), for the built-in
  adapters; or
- a **TypeScript or JavaScript module** (`.ts`, `.mts`, `.js` or `.mjs`) whose default export is the
  configuration object, for your own adapters, graders, fact matchers and hooks. Node imports it as an
  ES module; a `.ts` file runs through Node's type stripping.

Paths in the configuration (`suites`, `out`) are relative to the configuration file.

```yaml
# eval.config.yaml
suites: [regression/suite.yaml, capability/suite.yaml]
targets:
  - name: model-a
    adapter: openai-tools
    options: { model: vendor/model-a, temperature: 0, maxRounds: 6 }
  - name: model-b
    adapter: openai-tools
    options: { model: vendor/model-b, temperature: 0, maxRounds: 6 }
judge: { models: [vendor/judge-model] }
userSimulator: { model: vendor/model-a }
trials: 3
k: 3
concurrency: 4
retries: 2
timeoutMs: 120000
out: results
meta: { commit: abc1234 }
```

| Key             | Type                            | Default                            | Meaning                                                                                                                 |
| --------------- | ------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `suites`        | (string \| Suite)[]             | required                           | Suite files, or suites built in code (`defineSuite`, in a module).                                                      |
| `targets`       | (TargetSpec \| Target)[]        | required                           | What the run compares. See [Targets](#targets).                                                                         |
| `judge`         | object                          | none: model graders are skipped    | The judge for model graders. See [Judge and user simulator](#judge-and-user-simulator).                                 |
| `userSimulator` | object \| `reference`           | none                               | Plays the user of tasks with `input.user`. Required when a selected task has one.                                       |
| `trials`        | integer                         | 3                                  | Trials per task and target when neither the task nor its suite sets `trials` (like `timeoutMs`).                        |
| `k`             | integer                         | 3                                  | The k of pass@k and pass^k in the reports.                                                                              |
| `concurrency`   | integer                         | 4                                  | Trials that run at the same time.                                                                                       |
| `retries`       | integer                         | 2                                  | Retries of a trial after an infrastructure error. A trial runs at most `retries + 1` times.                             |
| `timeoutMs`     | integer                         | 300000                             | A trial's time limit when neither its task nor its suite sets one.                                                      |
| `hookTimeoutMs` | number                          | `60000`                            | The time limit of each `beforeTrial` and `afterTrial` call; a hook past it ends the attempt as an infrastructure error. |
| `out`           | string                          | `results` in the current directory | The parent folder of the run folders; `run` adds the time.                                                              |
| `meta`          | object                          |                                    | Copied into `run.json` under `meta` (the commit, the stack, the prompt version).                                        |
| `graders`       | Grader[]                        | module only                        | Your graders next to the built-in ones. A grader with a built-in type replaces the built-in one.                        |
| `factMatchers`  | FactMatcher[]                   | module only                        | Prefixed matchers for the `facts` and `forbid` graders. See [Fact matchers](graders.md#fact-matchers).                  |
| `hooks`         | `{ beforeTrial?, afterTrial? }` | module only                        | Functions of the trial context, run around every attempt. See [Hooks](#hooks).                                          |

Keys outside this table are ignored.

### Targets

A target is an adapter with its options: what a run compares (models, prompts, configurations). In a
YAML or JSON file, a target names a built-in adapter:

| Field         | Type                                       | Required | Meaning                                                           |
| ------------- | ------------------------------------------ | -------- | ----------------------------------------------------------------- |
| `name`        | string                                     | yes      | The target's name in results and reports.                         |
| `adapter`     | `openai-tools` \| `scripted` \| `http-sse` | yes      | The built-in adapter.                                             |
| `options`     | object                                     | yes      | The adapter's options, below.                                     |
| `description` | string                                     | no       | Shown in the report. For `openai-tools` it defaults to the model. |

**`openai-tools`**: a chat-with-tools loop against an OpenAI-compatible chat completions API, with the
task's [mock tools](task-and-suite-files.md#mock-tools). Each user turn calls the model until it
answers without a tool call.

| Option            | Type    | Default                                           | Meaning                                                                             |
| ----------------- | ------- | ------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `model`           | string  | required                                          | The model id at the endpoint.                                                       |
| `baseUrl`         | string  | `https://openrouter.ai/api/v1`                    | The API's base URL; requests go to `<baseUrl>/chat/completions`.                    |
| `apiKeyEnv`       | string  | `OPENROUTER_API_KEY`                              | The environment variable that holds the API key.                                    |
| `system`          | string  |                                                   | The system prompt. A task's `input.context.system` replaces it.                     |
| `maxRounds`       | integer | 8                                                 | Model calls per user turn. A turn that needs more fails as the agent's error.       |
| `temperature`     | number  | the endpoint's                                    | Sent as `temperature`.                                                              |
| `maxTokens`       | integer | the endpoint's                                    | Sent as `max_tokens`.                                                               |
| `extraBody`       | object  |                                                   | Fields merged into every request body (a provider's routing or reasoning settings). |
| `headers`         | object  |                                                   | Extra HTTP headers.                                                                 |
| `openRouterUsage` | boolean | `true` when the base URL contains `openrouter.ai` | Ask for the cost in the usage (`usage: { include: true }`).                         |

The statuses 408, 429, 502, 503 and 504, a lost connection and a provider failure reported inside the
stream with such a status or one of 500 and above are infrastructure errors. So are 401 and 403: the
eval's key is wrong or lacks access, which says nothing about the agent. Other refusals are the
agent's errors; the message of a 400 (often a wrong model id) names the model.

**`scripted`**: replays scripts, with no model. Its options: `replayReference: true` replays each
task's reference solution (the reference's events and answers turn by turn, and its outcome);
`replies` maps task ids to a list of turns (`{ text, events?, delayMs?, fail?, done? }`); `outcomes`
maps task ids to the outcome. `delayMs` waits before the reply; the reply's first token is the clock
when the wait ends, so it never comes after the reply. It is what the package's own tests and the dry
run use. See
[Extending](extending.md) for its full options.

```yaml
targets:
  - { name: reference, adapter: scripted, options: { replayReference: true } }
userSimulator: reference
```

**`http-sse`**: your agent behind HTTP that streams each turn as Server-Sent Events. In a YAML file it
takes `url` (each turn is a `POST` of `{ "message": "<text>" }` to it) and `headers` (static header
values, written into the file as they are). The default event mapper reads the events `text`,
`tool_call`, `tool_result`, `usage`, `done` and `error`. Opening a session, a custom body, a custom
mapper, reading the outcome and closing need a module configuration; see [Extending](extending.md).

In a module configuration, a target can also be any object `{ name, adapter, description? }` whose
`adapter` has a `start(trialContext)` method.

### Judge and user simulator

In a YAML or JSON file, both talk to an OpenAI-compatible endpoint:

| Key             | Fields                                                                                               | Meaning                                                                                                                                                                                                                           |
| --------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `judge`         | `models` (required, string[]), `baseUrl`, `apiKeyEnv`, `extraBody`, `jsonMode`, `toolResultMaxChars` | The judge models; several form a majority vote. A grader's own `models` replaces the list. `toolResultMaxChars` (a positive whole number, default 600) is how much of each tool result the judges see; a grader's own value wins. |
| `userSimulator` | `model` (required), `baseUrl`, `apiKeyEnv`, `extraBody`                                              | The model that plays the user of tasks with `input.user`.                                                                                                                                                                         |

`baseUrl` defaults to `https://openrouter.ai/api/v1` and `apiKeyEnv` to `OPENROUTER_API_KEY`. An
empty `models` list is refused when the configuration is resolved. The judge asks for its verdict
with `response_format: { type: "json_object" }`; set `jsonMode: false` for a provider or model that
rejects the field, and the judge relies on its prompt alone.

`userSimulator: reference` replays the user messages of each task's reference transcript in place of
a model: a dry run of conversational tasks.

In a module configuration, either can instead be `{ client, models?, toolResultMaxChars? }` (judge) or `{ client, model? }`
(user simulator), where `client` is any object with `complete(request) → Promise<{ text }>`. A judge
client's `models`, when given, must not be empty either.

### Environment variables

| Variable                      | Read when                                                                                          |
| ----------------------------- | -------------------------------------------------------------------------------------------------- |
| `OPENROUTER_API_KEY`          | An `openai-tools` target, the `judge` or the `userSimulator` uses an endpoint without `apiKeyEnv`. |
| the name given in `apiKeyEnv` | The same, with `apiKeyEnv` set.                                                                    |

The keys are read when the configuration is resolved, before any trial runs. A variable that is
missing or empty fails the command with `the environment variable <name> holds no API key`. The key is
sent as `Authorization: Bearer <key>` and is never written to a result. `validate --config` and
`regrade` ignore the configuration's targets, so they need only the judge's key, and only when the
configuration has a judge. No other environment variable is read.

### Hooks

`hooks.beforeTrial(context)` runs before every attempt of a trial and `hooks.afterTrial(context)`
after it: reset the environment, seed it, undo a write. A failing `beforeTrial` is an infrastructure
error (the trial is retried), never the agent's. `beforeTrial` runs before the trial's clock starts
and has a time limit of its own (`hookTimeoutMs` in the config or `runEval`'s options, default 60 seconds): one that runs past
it is an infrastructure error too, not a timeout. `afterTrial` runs after the session is closed; the
harness waits for it at most that long and ignores its errors. `context` holds the suite, the task,
the target's name, the 0-based trial index, the abort signal and `record(event)`.

### A module configuration

The fragment below is a configuration module for an agent behind HTTP with a reset hook. It is
illustrative and cannot run here: it needs a running agent and an API key for the judge.

```ts
// eval.config.ts
import { httpSseAdapter, type EvalConfig } from '@agent-evals/core';

const config: EvalConfig = {
  suites: ['regression/suite.yaml'],
  targets: [
    {
      name: 'staging',
      adapter: httpSseAdapter({
        url: 'http://localhost:3000/api/chat',
        headers: { Authorization: `Bearer ${process.env.AGENT_TOKEN}` },
      }),
    },
  ],
  judge: { models: ['vendor/judge-model'] },
  hooks: {
    async beforeTrial() {
      await fetch('http://localhost:3000/test/reset', { method: 'POST' });
    },
  },
  meta: { commit: process.env.GIT_COMMIT },
};

export default config;
```

`loadConfig(file)` reads a configuration file and `resolveConfig(config, baseDir)` turns it into the
options of `runEval`; together with `writeReports` they do what `agent-evals run` does:

```ts doctest
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig, resolveConfig, runEval, writeReports } from '@agent-evals/core';

const dir = mkdtempSync(join(tmpdir(), 'agent-evals-config-'));
mkdirSync(join(dir, 'smoke', 'tasks'), { recursive: true });
writeFileSync(join(dir, 'smoke', 'suite.yaml'), 'name: smoke\nkind: regression\n');
writeFileSync(
  join(dir, 'smoke', 'tasks', 'hello.yaml'),
  `id: hello
input: { turns: [Hello] }
graders: [{ type: facts, facts: [hello] }]
reference:
  transcript:
    - { type: message, role: user, text: Hello }
    - { type: message, role: assistant, text: Hello to you. }
`,
);
writeFileSync(
  join(dir, 'eval.config.yaml'),
  `suites: [smoke/suite.yaml]
targets:
  - { name: reference, adapter: scripted, options: { replayReference: true } }
trials: 2
out: results
meta: { purpose: docs }
`,
);

const { config, baseDir } = await loadConfig(join(dir, 'eval.config.yaml'));
const resolved = resolveConfig(config, baseDir);
assert.equal(resolved.k, 3);
assert.equal(resolved.out, join(dir, 'results'));

const out = join(resolved.out!, 'first-run');
const run = await runEval({ ...resolved, outDir: out });
const paths = writeReports(run, out, { k: resolved.k });

assert.equal(run.trials.length, 2);
assert.ok(run.trials.every((trial) => trial.passed));
// No task has a model grader, so nothing was skipped for want of a judge.
assert.deepEqual(run.meta, { purpose: 'docs' });
assert.ok(existsSync(paths.html));
assert.ok(existsSync(join(out, 'transcripts', 'smoke', 'reference', 'hello.1.jsonl')));
```

## The output folder

```text
<run folder>/
  run.json          the complete result: every trial with its transcript, grades and metrics
  summary.json      the numbers of the reports, the diff, the failures, the ungraded trials and the calibration
  report.md         the report for a pull request or a wiki
  report.html       the same report as a self-contained page
  transcripts/
    <suite>/<target>/<task>.<trial>.jsonl   one transcript per trial
  reviews.yaml      written by you: the classes of the failures (read by report and regrade)
```

The formats are specified in [Transcript and result formats](transcript-format.md). Names in the
transcript paths have every run of characters outside `[a-zA-Z0-9._-]` replaced by `_`. `report` and
`regrade` write the four report files again; the transcripts are written only by `run`. A labels
file can live anywhere; the viewer's default is `labels.yaml` in its root folder.
