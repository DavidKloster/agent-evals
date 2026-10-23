# Troubleshooting

Problems you may meet, with the message the package prints and what to do. The messages are quoted
from the code as it is today.

## Setup

### `Unknown file extension ".ts"` or a syntax error on a type

Node runs the package's TypeScript sources directly, by type stripping. That needs **Node 22.18 or
later** (the package's `engines` field says so). Older versions fail on the first `.ts` file. Check
with `node --version` and upgrade.

Your own TypeScript files that Node runs (a `.ts` config, an adapter) must use only erasable syntax:
no `enum`, no `namespace`, no constructor parameter properties (`constructor(private x: X)`), and
imports of types through `import type`.

### Node refuses to run the package from `node_modules`

```text
Error [ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING]: Stripping types is currently unsupported for files under node_modules
```

Node strips types only outside `node_modules`. The published package is compiled JavaScript, so this
error means a copy of the TypeScript sources ended up under `node_modules` (a link to a source
checkout installed as a dependency, or a pre-release copy). Run a source checkout as itself
(`node src/cli.ts …`), or install the published package.

### `the environment variable OPENROUTER_API_KEY holds no API key`

A config names a model behind an OpenAI-compatible API (an `openai-tools` target, a `judge` or a
`userSimulator` with `model`), and the key's variable is empty. `resolveConfig` checks this before
the run starts.

- Export the key: `OPENROUTER_API_KEY=… agent-evals run --config eval.config.yaml`.
- For another provider, set `apiKeyEnv` (and `baseUrl`) next to the model, and export that variable.
- For a run without any model, use the `scripted` adapter, leave out `judge`, and set
  `userSimulator: reference`. See [the CLI and config reference](cli-and-config.md).

`agent-evals validate --config <file>` resolves the config's judge but not its targets, so it needs
the judge's key only.

### `<suite>/<task>: the task has a simulated user, but the run has no userSimulator`

The task has `input.user`, and the run has no simulated user. `runEval` throws this before any trial
starts. Add `userSimulator` to the config: a model (`{ model: … }`), a client in a TypeScript config,
or `reference` to replay the reference solution's user messages without a model. Or leave the task
out with `--task`. See [Judges and calibration](judges-and-calibration.md#the-simulated-user).

### A task or suite file doesn't load

The loader throws an `EvalFileError` that lists every problem at once, as `<file>: <path>: <message>`.
Common ones:

- `input: a task needs turns or a simulated user`: add `input.turns` or `input.user`.
- `id: lower case letters, digits, ".", "_" and "-"`: task ids must match `^[a-z0-9][a-z0-9._-]*$`.
- `Unrecognized key: "…"`: the formats are strict. A typo in a key fails instead of being ignored.
  Grader parameters are the exception: a grader entry accepts any key.
- `<file>: the id <id> is taken by <other file>`: two tasks of a suite share an id.

The JSON Schemas in `schema/` let an editor show these while you type. See
[Task and suite files](task-and-suite-files.md).

## Grading

### `unknown grader type <type>`

A task names a grader the run doesn't know. In a run, the grader fails with this error (a grader
error, counted apart from the agent's failures). `validate` reports it as
`<grader id>: unknown grader type <type>`.

- Check the spelling against [the graders reference](graders.md).
- A project's own grader must be registered. A YAML config can't register graders; use a TypeScript
  config with `graders: [...]`. `agent-evals validate` without `--config` knows only the built-in
  graders.

### `modelGraders: skipped` in the run's meta

The run had no judge, so the model graders (`judge`) did not run. They are left out of the score.
This is how a dry run works without a key. `runEval` writes it only when at least one task of the
run has a model grader (its own or from the suite's defaults).

`validate` prints the same fact as `<n> model graders not run (no judge; pass --config)`. Pass a
config with a judge to run them.

### Trials marked `ungraded`

The trial has no verdict although the task has graders. Either every grader of the task is a model
grader and the run had no judge, or the grading failed: the judge's provider stayed down, and the
trial carries `gradingError: 'the judge failed: …'` (run `regrade` with the judge once it is back).
An ungraded trial has score 0, does not pass, and is left out
of pass@k like an infrastructure error. The reports list it under "Ungraded trials" (and
`summary.json` under `ungraded`), not among the failures. Add a judge, or give the task a code grader
too.

### `graders: the task has no grader and the suite no default graders`

A task with `graders: []` in a suite without default graders would pass every trial (no grader means
nothing failed), so the loader refuses it. Give the task a grader, or the suite a default grader.
A suite built by hand, without `loadSuite` or `defineSuite`, isn't checked: `validate` reports `the
task has no grader`.

### `the grader id <id> is used twice`

Two graders of a task have the same id, the suite's default graders counted: often an explicit
`id: facts` next to an unnamed `facts` grader. Give explicit ids that differ from the types.

### `tasks: <path> does not exist`

A path in the suite's `tasks` (or the default folder `tasks`) is missing, relative to the suite
file.

### `invalid path "<path>": …`

A path in `args`, `expect` or a mock tool's `when` is not one of the forms in
[Paths](graders.md#paths): `a[0]b`, `a..b`, a trailing or leading `.`, an unclosed `[`. Write
`a[0].b`, or `..a.b` for the key `a` anywhere.

A bad path in a mock tool's `when` is refused when the suite loads (`task <id>: mock tool <name>, response <n>: invalid path …`); one in a grader is a grader error that `agent-evals validate` reports.

### `unknown matcher {…} (use { equals: … } for an object)`

An `args`, `expect` or `when` value is an object whose keys are not matcher keys. An object in a
matcher position is read as a set of constraints (`oneOf`, `min`, `max`, `exists`, `absent`,
`contains`, `equals`, `all`, `any`, `not`, `includes`, `length`). To compare a whole object, write
`{ equals: { … } }`. The grader fails with a grader error. See [the graders reference](graders.md).

### The judge's verdicts are all `unknown`

Read the reason in the report or the viewer.

- `unparseable judge answer: …`: the judge model did not answer with the JSON object. Some models
  wrap it in prose; the parser finds a JSON object inside a code fence or between the first `{` and
  the last `}`, but not every answer has one. Try another judge model.
- A real `unknown` with a reason: the judge did not see enough to decide. Add the missing part to
  `include` (often `tools` or `outcome`), or sharpen the rubric.

See [Judges and calibration](judges-and-calibration.md).

### A judge grader with `onUnknown: ignore` failed although a dimension was unknown

With `ignore`, only the unknown dimensions are set aside; a dimension that failed still fails the
grader. The grader passes with weight 0 only when every dimension is unknown. See
[Judges and calibration](judges-and-calibration.md#unknown).

## Errors during a run

### Infrastructure errors and retries

The report notes `<target>: <n> attempt(s) hit an infrastructure error; they are not counted as the
agent's failures.`, and `TrialResult.infraErrors` lists the messages. A trial with an infrastructure
error is retried, `retries` times at most (default 2). If every attempt fails, the trial is
`infra_error` and left out of pass@k.

The messages and their usual causes:

| Message                                                 | Cause                                                                                                                  |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `HTTP 429 from …`, `HTTP 502/503/504 …`, `HTTP 408 …`   | The provider or the agent is busy or down, or the eval account hit a rate limit.                                       |
| `the request to … failed: …`, `POST … failed: …`        | A connection failure: wrong URL, the stack is not up, a network problem.                                               |
| `the stream failed: …`                                  | The provider reported an error with a 5xx code inside the stream.                                                      |
| `the stream of … ended without a last event`            | The `http-sse` agent closed the stream without a `done` or `error` event.                                              |
| `could not start <program>: …`                          | The `command` target's program is not found or not executable: check `command` and `cwd`.                              |
| `the command exited with code 75 before its turn ended` | The `command` agent said a system it needs is down ([exit code 75](python-agents.md#errors-and-the-end-of-a-process)). |
| `beforeTrial failed: …`                                 | The `beforeTrial` hook threw: resetting the environment failed.                                                        |
| `beforeTrial took longer than <n> ms`                   | The `beforeTrial` hook ran past `hookTimeoutMs` (default 60 000 ms).                                                   |
| `the simulated user failed: …`                          | The simulated user's model call failed.                                                                                |

A judge whose provider failed three times is not an attempt's infrastructure error: the trial keeps
its status, is marked ungraded with `gradingError: 'the judge failed: …'`, and is not retried. The
summary counts these trials as `gradingErrors`, apart from `infraErrors`.

What to do:

- For rate limits, lower `concurrency` (default 4) and raise `retries`.
- For a stack that isn't up, check it before the run. `beforeTrial` is a good place for a health
  check that throws.
- Don't report a failure of your own adapter's environment as a plain `Error`: it would count as the
  agent's failure. Throw an `InfraError` (see [Extending](extending.md#an-adapter)).

Note: a `401` or `403` from the model provider (a wrong key, or one without access) is an
infrastructure error too: `HTTP 401 from <baseUrl>: …`. Other HTTP statuses than those and 408, 429,
502, 503 and 504 are **not**: a `400` (often a wrong model name) in an `openai-tools` target fails the
trial as the agent's error, and its message names the model: `HTTP 400 from <baseUrl> (model
<id>): …`. If every trial of a target fails at once, check its key and model name first.

### Timeouts: `the trial took longer than <n> ms`

The attempt ran past its time limit: the task's `timeoutMs`, else the suite's `defaults.timeoutMs`,
else the run's `timeoutMs`, else 5 minutes. The trial's status is `timeout`. It counts as a failure,
and it is not retried.

- Raise the limit for tasks that legitimately take long (in the suite's defaults, or per task).
- Make the adapter honour `context.signal`, so the agent stops when the time is up.
- The time does not include `beforeTrial`: the hooks have a limit of their own (`hookTimeoutMs`,
  default 60 000 ms), and a reset that runs past it is an infrastructure error, not a timeout.
- After the timeout the harness still waits up to 10 seconds each for a pending `start`, for
  `outcome()` and for `close()`, and up to `hookTimeoutMs` for `afterTrial`. A hung agent therefore can't
  hang the run, but it can slow it. See [Architecture](architecture.md#timeouts-and-the-grace-period).

### Agent errors from the built-in adapters

| Message                                                         | Meaning                                                                                                                 |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `no script for task <id>`                                       | The `scripted` adapter has no reply for the task, and `replayReference` is off or the task has no reference transcript. |
| `the script of <id> has no reply for turn <n>`                  | The task sends more user messages than the script has replies.                                                          |
| `no answer after <n> model calls in one turn`                   | The `openai-tools` agent kept calling tools; `maxRounds` (default 8) ran out.                                           |
| `the command exited with code <n> before its turn ended`        | The `command` agent's process ended without a `done` event; the message ends with the last lines of its stderr.         |
| `the command wrote a line to stdout that is not a JSON event …` | The `command` agent printed something other than an event to stdout. Write logs to stderr.                              |
| `unknown tool <name>` (in a tool result)                        | The model called a tool the task's mock tools don't declare. The agent sees it.                                         |
| `no data for these arguments` (in a tool result)                | No mock tool response's `when` matched the arguments. The agent sees it.                                                |

## Results and reports

### pass@k and pass^k are empty for some tasks

The task has fewer than k graded trials: too few trials in the run, or some were lost to
infrastructure errors or are ungraded. Such tasks are left out of the group's pass@k and pass^k; the
report says how many (`tasksBelowK`). Run at least k trials per task. See [Metrics](metrics.md).

### The cost shows as `≥$…`

At least one model call reported no cost, so the sum is a lower bound. The built-in client asks
OpenRouter for the cost; other providers may not report it. Record `costUsd` on `model_call` events
in your adapter when you know it.

### `regrade` kept the old judge verdicts

Without a judge in the config, `regrade` doesn't call the model graders again; it keeps their earlier
results. Add a judge to the config to grade them again.

### `diff` doesn't flag a task that lost one of three trials

By default a pass@1 drop is a regression only from 0.34 on (more than one trial in three). A task
that went from 3/3 to 2/3 is still flagged, because its pass^k fell from 1. A task that went from 2/3
to 1/3 is not. Pass a smaller `minDrop` to `diffRuns` (or in the viewer) for a stricter comparison.
See [Metrics](metrics.md#comparing-two-runs).

## The viewer

The viewer listens on `127.0.0.1` only and checks every request. See [the viewer](viewer.md).

| Status and message                                      | Cause and fix                                                                                                                                                                                                                |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `403 foreign host`                                      | The request's `Host` header is not `127.0.0.1:<port>` or `localhost:<port>`. Open the URL the viewer printed. Behind a port forward (SSH, a container), forward to the **same** port number, or the Host header won't match. |
| `403 the X-Agent-Evals header is missing`               | A write (labelling) came without the header `X-Agent-Evals: 1`. The page sends it; a script must too.                                                                                                                        |
| `403 foreign origin`                                    | A write came from another page's origin. Only the viewer's own page may write.                                                                                                                                               |
| `415 the body must be application/json`                 | A write without `Content-Type: application/json`.                                                                                                                                                                            |
| `400 the id must be a folder inside the results folder` | The run id is absolute or contains `..`.                                                                                                                                                                                     |
| `404 no run <id>`                                       | No `run.json` in that folder under the root, or it is a link out of the root.                                                                                                                                                |
| `422 …`                                                 | The run's `run.json` can't be read as a run.                                                                                                                                                                                 |

The viewer finds runs up to three folders below `--root` (default `results`). It skips `transcripts`,
`node_modules` and hidden folders.

## Development of the package

### `schema/task.schema.json is stale`

A test compares `schema/*.schema.json` with the zod schemas in `src/core/schema.ts`. After a change
of the schemas, write the files again:

```sh
node src/cli.ts schema --write schema
```

`node src/cli.ts schema --check schema` fails with `out of date: … (run the schema script)` when they
differ.

### A doc example fails in `test/docs.test.ts`

The `ts doctest` blocks of the README and `docs/` run as tests, and `yaml task` and `yaml suite`
blocks must load. The test names the failing block by file and line. Fix the example, or the code if
the example shows what the code should do.
