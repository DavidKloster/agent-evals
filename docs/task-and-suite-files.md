# Task and suite files

A **suite** is a set of tasks with one goal: a capability suite (a hill to climb) or a regression
suite (meant to stay near 100 %). A **task** is one test: its input, the graders that decide success,
and a reference solution that proves the task can be solved. Both are written as YAML or JSON files;
a suite can also be built in code.

This page is the reference of both formats, of the defaults the loader and the harness apply, of the
JSON Schemas for editors, of reference solutions and `validate`, and of the mock tools a task can
declare.

## Files and folders

A typical layout:

```text
evals/
  eval.config.yaml           # the run's configuration (see CLI and configuration)
  tools.yaml                 # shared context: mock tools and the system prompt
  regression/
    suite.yaml
    tasks/
      due-date.yaml
      open-invoices.yaml
  capability/
    suite.yaml
    tasks/
      ...
```

- A file whose name ends in `.json` (any case) is read as JSON; every other file is read as YAML.
- A **task file** holds one task (an object) or a list of tasks.
- A **suite file** names its task files or folders in `tasks`, relative to the suite file. The default
  is the folder `tasks`. A folder contributes every file directly in it whose name ends in `.yaml`,
  `.yml` or `.json` (any case), sorted by name. Sub-folders are not read.
- A path in `tasks` that does not exist is a problem of the suite, reported with the others:
  `<suite file>: tasks: <path> does not exist`.

## The task file

```yaml task
# yaml-language-server: $schema=../../node_modules/@agent-evals/core/schema/task.schema.json
id: due-date
description: A plain lookup by number; the date must come from the tool, not from a guess.
source: support ticket pattern "guessed a due date", synthetic rewrite
tags: [lookup]
input:
  turns: ['When is invoice RE-1001 due?']
graders:
  - { type: tool_called, tool: get_invoice, args: { number: RE-1001 } }
  - { type: tool_not_called, tool: pay_invoice }
  - { type: facts, facts: [['2026-06-11', 'June 11', '11 June', '11.06.2026']] }
trials: 5
timeoutMs: 60000
reference:
  transcript:
    - { type: message, role: user, text: 'When is invoice RE-1001 due?' }
    - { type: tool_call, id: c1, name: get_invoice, args: { number: RE-1001 } }
    - { type: message, role: assistant, text: 'RE-1001 is due on June 11, 2026.' }
  outcome: { writes: [], state: null }
```

Unknown keys are errors at every level except inside a grader (graders take their own parameters),
inside `input.context` (passed through as is) and inside `reference.outcome` and reference events.

| Field         | Type                                     | Required | Default                    | Meaning                                                                                                                     |
| ------------- | ---------------------------------------- | -------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `id`          | string matching `^[a-z0-9][a-z0-9._-]*$` | yes      |                            | Unique within the suite. Also the name of the trial's transcript files.                                                     |
| `description` | string                                   | no       |                            | What the task checks, in one or two sentences.                                                                              |
| `source`      | string                                   | no       |                            | Where the task comes from: the issue or the real failure.                                                                   |
| `tags`        | string[]                                 | no       |                            | Free labels.                                                                                                                |
| `input`       | [input](#input)                          | yes      |                            | What the agent gets.                                                                                                        |
| `graders`     | [grader](#graders)`[]`                   | yes      |                            | The task's own graders. They run after the suite's default graders. The schema allows an empty list; `validate` reports it. |
| `scoring`     | `{ mode, threshold? }`                   | no       | the suite's, else `binary` | How the grader results become one verdict. See [Scoring](graders.md#scoring).                                               |
| `trials`      | integer ≥ 1                              | no       | see [Defaults](#defaults)  | Trials per target.                                                                                                          |
| `timeoutMs`   | integer ≥ 1                              | no       | see [Defaults](#defaults)  | A trial's time limit in milliseconds.                                                                                       |
| `reference`   | `{ transcript?, outcome? }`              | no       |                            | A solution that passes every grader. See [Reference solutions](#reference-solutions-and-validate).                          |

### `input`

| Field     | Type                    | Required | Meaning                                                                                                                                                   |
| --------- | ----------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `turns`   | non-empty string[]      | see note | What the user types, one message per turn, in order.                                                                                                      |
| `user`    | [simulated user](#user) | see note | A second model that plays the user, after the fixed turns.                                                                                                |
| `context` | object                  | no       | Anything the adapter needs for this task (the page to start on, who asks, the [mock tools](#mock-tools), the system prompt), passed to the adapter as is. |

A task needs at least one turn or a simulated user. The harness first sends every fixed turn, then,
with a `user`, the simulated user's messages: `firstMessage` first when it is set (also after fixed
turns), then the ones the simulated user writes. The simulated user sees the fixed turns and the
agent's replies to them. The conversation ends early when the agent's reply says it is done (an
adapter sets `done: true`).

#### `user`

| Field          | Type             | Required | Default | Meaning                                                                                         |
| -------------- | ---------------- | -------- | ------- | ----------------------------------------------------------------------------------------------- |
| `persona`      | non-empty string | yes      |         | Who the user is and how they write.                                                             |
| `goal`         | non-empty string | yes      |         | What the user wants to reach. The simulated user stops when it is reached or cannot be reached. |
| `firstMessage` | string           | no       |         | The simulated user's first message, after any fixed turns. Without it, the model writes it.     |
| `maxTurns`     | integer ≥ 1      | no       | 6       | The most user messages in the conversation, the fixed turns and the first message included.     |

A run that contains a task with `user` needs a user simulator (`userSimulator` in the
configuration, see [CLI and configuration](cli-and-config.md#configuration)); without one, the run
fails before any trial starts. With `userSimulator: reference`, the simulated user replays the `user`
messages of the task's reference transcript instead of calling a model. The reference's user messages
are read as the whole conversation: one per fixed turn, then `firstMessage` (if set), then the
replayed ones. So it skips as many as there are fixed turns (plus one for `firstMessage`), says the
rest in order, and stops when they run out; a fixed turn is never sent twice.

### Graders

Each entry names a grader by its `type` and carries the grader's parameters next to these common
fields:

| Field      | Type             | Required | Default                      | Meaning                                                             |
| ---------- | ---------------- | -------- | ---------------------------- | ------------------------------------------------------------------- |
| `type`     | non-empty string | yes      |                              | A built-in grader or one your configuration registers.              |
| `id`       | non-empty string | no       | the type, `type#2`, `type#3` | The grader's name in results, reports and label files; unique.      |
| `weight`   | number ≥ 0       | no       | 1                            | The weight in the weighted mean.                                    |
| `required` | boolean          | no       | `false`                      | In hybrid scoring, the grader must pass whatever the weighted mean. |

A task needs at least one grader, its own or the suite's default graders: `graders: []` is allowed
only in a suite with default graders. The schema of a task file can't know its suite, so it accepts
an empty list, and the loader (`loadSuite`, `defineSuite`) refuses a task left without a grader:
`<file>: task <id>: graders: the task has no grader and the suite no default graders`. Grader ids
must be unique within a task, the suite's default graders counted; the loader refuses a repeated id:
`<file>: task <id>: the grader id <id> is used twice`.

The parameters of each built-in grader, the id rules and the scoring modes are in [Graders](graders.md).

## The suite file

```yaml suite
# yaml-language-server: $schema=../node_modules/@agent-evals/core/schema/suite.schema.json
name: invoice-desk-regression
kind: regression
owner: the invoice team
description: What the invoice assistant must keep doing. Run on every prompt, tool or model change.
tasks: [tasks]
defaults:
  context: ../tools.yaml
  trials: 3
  timeoutMs: 120000
  scoring: { mode: binary }
  graders:
    - { type: no_error }
    - { type: no_placeholder_args }
    - { type: limits, maxModelCalls: 6 }
```

| Field         | Type                                    | Required | Default   | Meaning                                                                                                                            |
| ------------- | --------------------------------------- | -------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | non-empty string                        | yes      |           | The suite's name in results and reports.                                                                                           |
| `kind`        | `capability` \| `regression`            | yes      |           | A capability suite is a hill to climb; a regression suite should pass nearly always.                                               |
| `description` | string                                  | no       |           |                                                                                                                                    |
| `owner`       | string                                  | no       |           | Who keeps the tasks and graders up to date. Shown in `run.json`.                                                                   |
| `tasks`       | string[]                                | no       | `[tasks]` | Task files or folders, relative to the suite file.                                                                                 |
| `defaults`    | [defaults](#defaults-of-a-suite)        | no       |           | What every task of the suite gets.                                                                                                 |
| `saturation`  | `{ threshold: 0..1 }`                   | no       | 0.9       | A capability suite whose pass@1 reaches the threshold is reported as saturated: add harder tasks.                                  |
| `graduation`  | `{ k: integer ≥ 1, runs: integer ≥ 1 }` | no       |           | The suite's graduation rule (default k 3, 2 runs). The run records it and `graduate` applies it unless `--k` or `--runs` is given. |

### Defaults of a suite

| Field       | Type                                  | Meaning                                                                                                                                                                       |
| ----------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `graders`   | grader[]                              | Graders every task gets **before** its own.                                                                                                                                   |
| `scoring`   | `{ mode, threshold? }`                | The scoring of a task that sets none. A task's `scoring` replaces it as a whole.                                                                                              |
| `trials`    | integer ≥ 1                           | The trials of a task that sets none.                                                                                                                                          |
| `timeoutMs` | integer ≥ 1                           | The time limit of a task that sets none.                                                                                                                                      |
| `context`   | object, or a path to a YAML/JSON file | Merged under every task's `input.context`. A string is a file path relative to the suite file; the file holds the object (often the shared mock tools and the system prompt). |

**The context merge is shallow: a task's key wins.** Each task's context becomes
`{ ...suiteContext, ...taskContext }`. A task that sets `tools` replaces the suite's whole `tools`
list; it does not add to it. A task without `context` gets the suite's context.

## Defaults

The loader and the harness apply these rules. "Run option" means the CLI option or the configuration
key of the same name.

| Setting                | Where it comes from, first match wins                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Trials of a task       | `--trials` (`trialsOverride`), then the task's `trials`, then `defaults.trials`, then the run's `trials`, then **3** |
| Time limit of a trial  | the task's `timeoutMs`, then `defaults.timeoutMs`, then the run option `timeoutMs`, then **300000** ms (5 minutes)   |
| Scoring                | the task's `scoring`, then `defaults.scoring`, then `{ mode: binary }`                                               |
| Scoring threshold      | the `threshold` of the chosen scoring, then **1**                                                                    |
| Graders of a task      | `defaults.graders`, then the task's `graders`                                                                        |
| Context of a task      | `{ ...defaults.context, ...input.context }`                                                                          |
| Task files of a suite  | `tasks`, then the folder **`tasks`**                                                                                 |
| Simulated user's turns | `input.user.maxTurns`, then **6**                                                                                    |
| A grader's weight      | `weight`, then **1**                                                                                                 |

Trials and time limits follow one rule: the task, then the suite's defaults, then the run's value as
the fallback. Only the CLI's `--trials` (`runEval`'s `trialsOverride`) forces a number on every task,
so you can run a whole suite once for a quick check.

## Validation errors

The loader checks every file against its schema and reports **every** problem at once, as an
`EvalFileError` whose message has one line per problem: the file (with `[index]` for an entry of a
task list), the path inside it (`(root)` for the top level) and the problem.

```text
tasks/bad.yaml[0]: id: lower case letters, digits, ".", "_" and "-"
tasks/bad.yaml[0]: input: a task needs turns or a simulated user
tasks/bad.yaml[0]: graders.0.type: Too small: expected string to have >=1 characters
tasks/bad.yaml[0]: (root): Unrecognized key: "extra"
tasks/bad.yaml[1]: scoring.threshold: Too big: expected number to be <=1
```

A suite whose tasks reuse an id fails with `<file>: the id <id> is taken by <first file>`. A YAML or
JSON syntax error fails with the parser's message. The CLI prints the error and exits with code 1.

The schema checks the shape of a grader (`type`, `id`, `weight`, `required`) but not its parameters.
A wrong parameter shows up when the grader runs: as a grader error in a trial, or as a problem in
`validate`.

## JSON Schemas for editors

The package ships the JSON Schemas of both formats, `schema/task.schema.json` and
`schema/suite.schema.json` (JSON Schema draft 2020-12). They are generated from the same definitions
the loader uses, so an editor checks a file the way the loader does. `agent-evals schema` prints them,
`--write <dir>` writes them and `--check <dir>` fails when the files in a folder are out of date (see
[CLI](cli-and-config.md#schema)).

With the YAML language server (the YAML extension of VS Code and other editors), point a file at its
schema with a comment on the first line. The path is relative to the file:

```yaml
# yaml-language-server: $schema=../../node_modules/@agent-evals/core/schema/task.schema.json
```

```yaml
# yaml-language-server: $schema=../node_modules/@agent-evals/core/schema/suite.schema.json
```

Once the package is published, a URL also works, without a path into `node_modules`:

```yaml
# yaml-language-server: $schema=https://unpkg.com/@agent-evals/core@0.1/schema/task.schema.json
```

The package also exports both files (`@agent-evals/core/schema/task.schema.json` and
`@agent-evals/core/schema/suite.schema.json`) for tools that resolve schemas through Node.

## Suites in code

`defineSuite` builds a suite from objects, for tasks generated from another data set. It checks each
task like the loader, rejects duplicate ids and merges `defaults.context` (which must be an object
here, not a path). `parseTasks(data, file?)` checks the content of one task file. `loadSuite(file)`
loads a suite file with its tasks.

```ts doctest
import assert from 'node:assert/strict';

import { EvalFileError, defineSuite, gradersOf } from '@agent-evals/core';

const suite = defineSuite({
  name: 'generated',
  kind: 'capability',
  defaults: {
    graders: [{ type: 'no_error' }, { type: 'facts', facts: ['EUR'] }],
    context: { system: 'You are terse.', tools: [{ name: 'list_invoices' }] },
  },
  tasks: [
    {
      id: 'q1',
      input: { turns: ['How much is open?'] },
      graders: [{ type: 'facts', facts: ['240'] }],
    },
    {
      id: 'q2',
      input: { turns: ['Anything due?'], context: { tools: [] } },
      graders: [{ type: 'tool_calls', max: 0 }],
    },
  ],
});

// The suite's graders come first; a second unnamed grader of a type gets "#2".
assert.deepEqual(
  gradersOf(suite.tasks[0]!, suite).map((grader) => grader.id),
  ['no_error', 'facts', 'facts#2'],
);

// The context merge is shallow: q2's tools replace the suite's tools.
assert.deepEqual(suite.tasks[0]!.input.context, {
  system: 'You are terse.',
  tools: [{ name: 'list_invoices' }],
});
assert.deepEqual(suite.tasks[1]!.input.context, { system: 'You are terse.', tools: [] });

// Every problem at once, as an EvalFileError.
assert.throws(
  () =>
    defineSuite({
      name: 'broken',
      kind: 'regression',
      tasks: [
        { id: 'a', input: { turns: ['x'] }, graders: [] },
        { id: 'a', input: {}, graders: [] },
      ],
    }),
  (error) => error instanceof EvalFileError && error.message.includes('a task needs turns'),
);
```

## Reference solutions and `validate`

A reference solution is a trial that passes every grader: it proves the task can be solved and that
its graders are fair. It has two optional parts:

- `transcript`: the events of a correct trial. The messages of the answer and the tool calls the
  graders look at are enough; tool results, model calls and times can be left out. The events use the
  [transcript format](transcript-format.md#events). Times that are missing become `0, 1, 2, …` by
  position.
- `outcome`: the environment's final state after a correct trial, as the adapter would read it. For
  the built-in mock tools that is `{ writes: [...], failedWrites: [...], state: ... }` (a reference
  that leaves out `failedWrites` is fine when no grader reads it). Without it the outcome is `null`.

`agent-evals validate <suite.yaml>…` (and `validateSuite` in code) checks each task of each suite and
reports these problems:

| Problem                                              | When                                                                                     |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `the task has no grader`                             | Neither the suite nor the task has a grader.                                             |
| `<id>: unknown grader type <type>`                   | No built-in or registered grader has that type.                                          |
| `the grader id <id> is used twice`                   | Two graders of the task (the suite's defaults counted) have the same id.                 |
| `the task has no reference solution`                 | The task has no `reference`.                                                             |
| `<id>: <error>`                                      | The grader threw on the reference (a missing parameter, an unknown matcher, a bad path). |
| `<id>: the reference fails <assertions>`             | The grader ran and the reference does not pass it; the failed assertions follow.         |
| `the reference does not reach the scoring threshold` | Every grader is fine, but the task's scoring does not pass (a weighted threshold).       |

Model graders (`judge`) run only when a judge is configured (`validate --config <file>`, whose
`judge` is used; its targets are ignored). Without one they are skipped and counted:
`2 model graders not run (no judge; pass --config)`. The reference is graded with an empty target
name, as a trial of no target.

The scripted adapter can also replay the reference solutions as a full run (`replayReference: true`):
a dry run of a suite that costs nothing. See [CLI and configuration](cli-and-config.md).

```ts doctest
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { builtinGraders, loadSuite, validateSuite } from '@agent-evals/core';

const dir = mkdtempSync(join(tmpdir(), 'agent-evals-suite-'));
mkdirSync(join(dir, 'tasks'));
writeFileSync(join(dir, 'shared.yaml'), 'system: Answer briefly.\n');
writeFileSync(
  join(dir, 'suite.yaml'),
  'name: demo\nkind: regression\ndefaults:\n  context: shared.yaml\n',
);
writeFileSync(
  join(dir, 'tasks', 'tasks.yaml'),
  `
- id: good
  input: { turns: ['What is 2 + 2?'] }
  graders: [{ type: facts, facts: ['4'] }]
  reference:
    transcript:
      - { type: message, role: user, text: 'What is 2 + 2?' }
      - { type: message, role: assistant, text: 'It is 4.' }
- id: unfair
  input: { turns: ['What is 2 + 2?'] }
  graders: [{ type: facts, facts: ['four'] }]
  reference:
    transcript:
      - { type: message, role: assistant, text: 'It is 4.' }
`,
);

const suite = loadSuite(join(dir, 'suite.yaml'));
assert.equal(suite.tasks[0]!.input.context!.system, 'Answer briefly.');
assert.equal(suite.tasks[0]!.file, 'tasks/tasks.yaml');

const check = await validateSuite(suite, { graders: builtinGraders() });
assert.equal(check.ok, false);
assert.deepEqual(
  check.tasks.map((task) => [task.taskId, task.ok]),
  [
    ['good', true],
    ['unfair', false],
  ],
);
assert.match(check.tasks[1]!.problems[0]!, /^facts: the reference fails states four/);
```

## Mock tools

The `openai-tools` adapter (a chat-with-tools loop against an OpenAI-compatible API) gives the model
the task's **mock tools**: tool definitions with canned responses, declared in the task's
`input.context` or, shared by every task, in the suite's `defaults.context`. Other adapters ignore
these keys unless they read them themselves; `mockEnvironment(trialContext)` builds the same
environment for your own adapter.

| `input.context` key | Type           | Meaning                                                                                                                   |
| ------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `tools`             | mock tool[]    | The tools the agent may call.                                                                                             |
| `state`             | any JSON value | Returned as `state` in the outcome. It is deep-copied per trial, so trials share nothing; the mock tools never change it. |
| `system`            | string         | The system prompt. It replaces the adapter's `system` option for this task.                                               |

A mock tool:

| Field         | Type                 | Required | Meaning                                                                                                                                         |
| ------------- | -------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | string               | yes      | The tool's name. The agent's calls are matched by exact name.                                                                                   |
| `description` | string               | no       | Sent to the model.                                                                                                                              |
| `parameters`  | object (JSON Schema) | no       | The arguments' schema, sent to the model. Default `{ type: object, properties: {} }`. Not checked against calls.                                |
| `write`       | boolean              | no       | The tool changes the environment. A call that succeeded is recorded in the outcome's `writes`; a failed call in `failedWrites`, with its error. |
| `responses`   | response[]           | no       | The canned responses, tried in order.                                                                                                           |

A response:

| Field    | Type                    | Meaning                                                                                                                                                                               |
| -------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `when`   | `{ <path>: <matcher> }` | The response answers when every path of the call's arguments matches, in the [matcher language](graders.md#the-matcher-language). Without `when` (or with `{}`), it answers any call. |
| `result` | any JSON value          | What the tool returns (deep-copied). Default `null`.                                                                                                                                  |
| `error`  | string                  | The tool fails with this message instead.                                                                                                                                             |

How a call is answered:

1. A call of a name that no mock tool has fails with `unknown tool <name>`.
2. The first response whose `when` matches answers. When none matches, the call fails with
   `no data for these arguments`.
3. A response with `error` fails the call with that message; otherwise the call returns `result`.
4. A call of a write tool that returned its `result` is appended to `writes` as `{ tool, args }`. A
   call of a write tool that failed (step 2 or 3) is appended to `failedWrites` as
   `{ tool, args, error }`: it changed nothing, so it is not a write.

A failed call is not the agent's error: `openai-tools` records a `tool_result` with `result: null` and
the `error`, and shows the model `{"error": "<message>"}`, as it would see a failed API call. A
successful result is sent to the model as JSON, cut to 20,000 characters.

**The outcome** of the trial is `{ writes, failedWrites, state }`: the successful and the failed calls
of the write tools, each in the order they were made, and the copy of `state`. `writes` holds only
writes that succeeded, so `writes: { length: 0 }` means the agent changed nothing; to check that the
agent didn't even try, also expect `failedWrites: { length: 0 }`. Grade it with the `outcome` grader:

```yaml task
id: pay-the-right-invoice
input:
  turns: ['Pay invoice RE-1007, please.']
  context:
    system: You are the invoice desk assistant. Pay only what the user asks for.
    tools:
      - name: get_invoice
        description: One invoice by its number.
        parameters:
          type: object
          properties: { number: { type: string } }
          required: [number]
        responses:
          - when: { number: RE-1007 }
            result: { number: RE-1007, amount: 89.9, status: open }
          - error: no invoice with this number
      - name: pay_invoice
        description: Pays an open invoice.
        write: true
        parameters:
          type: object
          properties: { number: { type: string } }
          required: [number]
        responses:
          - when: { number: 're:^RE-100[17]$' }
            result: { paid: true }
          - error: only an open invoice can be paid
graders:
  - type: outcome
    expect:
      writes: { length: 1 }
      'writes[0].tool': pay_invoice
      'writes[0].args.number': RE-1007
reference:
  transcript:
    - { type: message, role: user, text: 'Pay invoice RE-1007, please.' }
    - { type: tool_call, id: c1, name: pay_invoice, args: { number: RE-1007 } }
    - { type: message, role: assistant, text: 'Done: RE-1007 is paid.' }
  outcome: { writes: [{ tool: pay_invoice, args: { number: RE-1007 } }], state: null }
```

Quote a path key that contains `[` or starts with `.` (`'writes[0].tool'`, `'..number'`), so YAML
reads it as a plain string.

The example below drives the mock environment directly, the way an adapter does:

```ts doctest
import assert from 'node:assert/strict';

import { mockEnvironment, ToolError } from '@agent-evals/core';

// The part of a trial's context the mock environment reads: the task's input.context.
const trial = {
  task: {
    input: {
      context: {
        state: { balance: 100 },
        tools: [
          {
            name: 'pay_invoice',
            write: true,
            responses: [
              { when: { number: 're:^RE-1' }, result: { paid: true } },
              { error: 'only an open invoice can be paid' },
            ],
          },
        ],
      },
    },
  },
};

const environment = mockEnvironment(trial as never);
const signal = new AbortController().signal;

assert.deepEqual(environment.tools, [
  { name: 'pay_invoice', description: undefined, parameters: undefined },
]);
assert.deepEqual(await environment.call('pay_invoice', { number: 'RE-1007' }, signal), {
  paid: true,
});
await assert.rejects(environment.call('pay_invoice', { number: 'X-1' }, signal), ToolError);
await assert.rejects(environment.call('delete_invoice', {}, signal), /unknown tool/);

// Only the call that succeeded is a write; the failed one is in failedWrites with its error.
// state is returned unchanged.
assert.deepEqual(environment.outcome(), {
  writes: [{ tool: 'pay_invoice', args: { number: 'RE-1007' } }],
  failedWrites: [
    { tool: 'pay_invoice', args: { number: 'X-1' }, error: 'only an open invoice can be paid' },
  ],
  state: { balance: 100 },
});
```
