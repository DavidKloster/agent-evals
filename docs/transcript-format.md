# Transcript and result formats

This page specifies the files a run writes and the files a person writes next to them:

- [the transcript](#the-transcript-jsonl) of one trial, one JSON event per line;
- [`run.json`](#runjson), the complete result of a run;
- [`summary.json`](#summaryjson), the numbers the reports show;
- [the labels file](#the-labels-file), human verdicts for judge calibration;
- [the reviews file](#the-reviews-file), the failure classes a person assigned.

`run.json` and every line of a transcript file carry the format's version, `formatVersion` (today `1`, the exported `FORMAT_VERSION`). A reader refuses a newer version; see [Stability and versioning](stability.md#file-format-versions). The labels and reviews files, which people write, carry none.

All times named `at`, `startedAt`, `endedAt` or `firstTokenAt` in a transcript are wall-clock times in
**milliseconds since the Unix epoch** (`Date.now()`). Durations end in `Ms` and are milliseconds. The
times in `run.json` that end in `At` at the run and trial level are ISO 8601 strings.

## The transcript (JSONL)

A transcript is the complete record of one trial: the messages, the model calls, the tool calls and
their results, errors and notes. The harness keeps it in memory as an array of events and writes it
to a file when the run has an output folder (the CLI always has one):

```text
<run folder>/transcripts/<suite>/<target>/<task>.<trial>.jsonl
```

- `<suite>`, `<target>` and `<task>` are the names with every run of characters outside
  `[a-zA-Z0-9._-]` replaced by one `_`. Two names that differ only in such characters map to the
  same folder or file, so keep names in that character set.
- `<trial>` is the 0-based trial index.
- Each line is `JSON.stringify({ formatVersion: 1, ...event })` followed by `\n`, so the file ends
  with `\n`. An empty transcript gives an empty file. `formatVersion` comes first on every line, so
  a reader that streams the file sees the version on any line it starts from; it is not a field of
  the event, and the events in `run.json` don't repeat it.
- Fields whose value is `undefined` are left out. Other fields are never `null` unless the event
  type allows any JSON value there (`args`, `result`, `data`).
- The same events are also in `run.json` under `trials[].transcript`.

### Events

Every event is an object with a `type` and an `at`. The six types:

#### `message`

A message of the conversation.

| Field          | Type                                    | Required | Meaning                                                                                                                                                |
| -------------- | --------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `type`         | `"message"`                             | yes      |                                                                                                                                                        |
| `at`           | number (ms since epoch)                 | yes      | When the message was recorded. For a user message: just before it was sent to the agent. For an assistant message: when the agent's reply had arrived. |
| `role`         | `"user"` \| `"assistant"` \| `"system"` | yes      | Who wrote it. The harness writes `user` and `assistant`; an adapter may record `system`.                                                               |
| `text`         | string                                  | yes      | The full text.                                                                                                                                         |
| `firstTokenAt` | number (ms since epoch)                 | no       | For an assistant message: when its first token arrived, as the adapter reported it.                                                                    |

#### `model_call`

One call of a model, as the adapter reports it. The built-in `openai-tools` adapter records one per
round of its tool loop; the `http-sse` adapter records one per `usage` event of the stream.

| Field          | Type                    | Required | Meaning                                                                                     |
| -------------- | ----------------------- | -------- | ------------------------------------------------------------------------------------------- |
| `type`         | `"model_call"`          | yes      |                                                                                             |
| `at`           | number (ms since epoch) | yes      | When the event was recorded. With `openai-tools` this is after the call ended.              |
| `model`        | string                  | yes      | The model, as the provider named it in its answer when it did.                              |
| `provider`     | string                  | no       | The provider that served the call (OpenRouter reports it).                                  |
| `startedAt`    | number (ms since epoch) | yes      | When the request was sent.                                                                  |
| `firstTokenAt` | number (ms since epoch) | no       | When the first text or tool-call token arrived.                                             |
| `endedAt`      | number (ms since epoch) | yes      | When the response ended.                                                                    |
| `inputTokens`  | number                  | no       | Prompt tokens from the provider's usage.                                                    |
| `outputTokens` | number                  | no       | Completion tokens from the provider's usage.                                                |
| `costUsd`      | number (USD)            | no       | What the provider's usage says the call cost. Missing when the provider reported no cost.   |
| `error`        | string                  | no       | The call failed. `openai-tools` then sets `startedAt` and `endedAt` to the time of failure. |

#### `tool_call`

The agent called a tool.

| Field  | Type                    | Required | Meaning                                                                                                                                     |
| ------ | ----------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `type` | `"tool_call"`           | yes      |                                                                                                                                             |
| `at`   | number (ms since epoch) | yes      | When the call was recorded.                                                                                                                 |
| `id`   | string                  | yes      | The call's id. It pairs the call with its `tool_result`.                                                                                    |
| `name` | string                  | yes      | The tool's name.                                                                                                                            |
| `args` | any JSON value          | yes      | The arguments. `openai-tools` parses the model's argument string as JSON; when that fails, `args` is `{ "_unparsed": "<the raw string>" }`. |

#### `tool_result`

The result of a tool call.

| Field    | Type                    | Required | Meaning                                                                        |
| -------- | ----------------------- | -------- | ------------------------------------------------------------------------------ |
| `type`   | `"tool_result"`         | yes      |                                                                                |
| `at`     | number (ms since epoch) | yes      | When the result was recorded.                                                  |
| `id`     | string                  | yes      | The `id` of the `tool_call` this result answers.                               |
| `name`   | string                  | yes      | The tool's name.                                                               |
| `result` | any JSON value          | yes      | What the tool returned. `null` when it failed (with `openai-tools`).           |
| `error`  | string                  | no       | The tool failed with this message. The `no_error` grader looks for this field. |

#### `error`

A failure of the trial. The harness records it when an attempt ends with an exception.

| Field     | Type                                                | Required | Meaning                                                                                                                                                                                                     |
| --------- | --------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`    | `"error"`                                           | yes      |                                                                                                                                                                                                             |
| `at`      | number (ms since epoch)                             | yes      | When the failure was recorded.                                                                                                                                                                              |
| `kind`    | `"agent"` \| `"infra"` \| `"timeout"` \| `"grader"` | yes      | Where the failure lies. The harness writes `agent`, `infra` or `timeout`. `grader` exists in the type but the harness never writes it: a grader's failure is in the grader's result, not in the transcript. |
| `message` | string                                              | yes      | The error message.                                                                                                                                                                                          |

#### `note`

Anything else worth keeping in the record.

| Field  | Type                    | Required | Meaning                     |
| ------ | ----------------------- | -------- | --------------------------- |
| `type` | `"note"`                | yes      |                             |
| `at`   | number (ms since epoch) | yes      | When the note was recorded. |
| `text` | string                  | yes      | The note.                   |
| `data` | any JSON value          | no       | Structured data.            |

The harness writes one note before each message of a simulated user:
`{ "type": "note", "text": "simulated user", "data": { "turn": <n> } }`, where `turn` is the 1-based
number of that user message in the conversation, the fixed turns included.

### Events without a time

A reference solution in a task file and an adapter may leave `at` out (the `TranscriptEventInput`
type). The time is filled in this way:

- **During a trial**, the recorder sets `at` to `Date.now()` when the event is recorded. An event that
  carries its own `at` keeps it.
- **For a reference solution** (`validate`) and in `completeTranscript(events, start = 0)`, an event
  without `at` gets `start + index`, where `index` is its position in the list. An event with `at`
  keeps it. So a reference transcript without times has `at` values `0, 1, 2, …`.

### Ordering

- **The order of the array (and of the lines in the file) is the order in which events were
  recorded.** Use it for the sequence of events.
- For each turn, the harness records the user message before it calls the adapter, then the adapter
  records what happened during the turn (model calls, tool calls, tool results), and the harness
  records the assistant message after the adapter returned the reply.
- **`at` is not guaranteed to increase along the array.** An adapter may set `at` itself: the
  `http-sse` adapter uses the time each Server-Sent Event arrived, and a scripted turn may replay
  events with their own times. Use `at` for durations, not for the order.
- When an attempt fails, the harness appends an `error` event. An agent that ignores the trial's
  abort signal can still record events until the harness takes its copy of the transcript, so in rare
  cases an event follows the `error` event.
- When an attempt fails with an infrastructure error and the harness retries the trial, the retry
  starts a new transcript. **Only the last attempt's transcript is kept.** The messages of the earlier
  attempts' errors are in `run.json` under `trials[].infraErrors`.
- When the judge fails while grading, the transcript gets no `error` event for it; the trial keeps its
  status and the message is in `trials[].gradingError`.

### How the package reads a transcript

These functions are exported and are what the graders and metrics use.

**`toolUses(transcript)`** pairs each `tool_call` with its `tool_result` by `id` and returns the calls
in the order they were made, as `{ id, name, args, at, result?, error? }` (`at` is the call's time).

- A `tool_result` attaches to the most recent earlier `tool_call` with the same `id`. When two calls
  share an `id`, the result goes to the later one.
- A `tool_result` whose `id` matches no earlier `tool_call` is ignored, and so is a result recorded
  before its call.
- When one call gets several results, the last one wins, its `result` and its `error`: a later
  result without `error` clears an earlier result's `error`.
- A call without a result has neither `result` nor `error`.

**`answerOf(transcript)`** returns `{ answer, finalAnswer }`: `answer` is the `text` of every
`assistant` message joined with a blank line (`"\n\n"`), and `finalAnswer` is the text of the last
assistant message, or `""` when there is none. The graders call these the answer and the final
answer.

**`completeTranscript(events, start = 0)`** fills in missing times as described above.

**`metricsOf(transcript, startedAt, endedAt)`** computes a trial's `metrics` (see
[`TrialMetrics`](#trialmetrics)) in one pass over the events:

- `durationMs` is `endedAt − startedAt`. The harness passes the last attempt's start, taken just
  before the `beforeTrial` hook, and its end, taken after the conversation ended and the outcome was
  read (before `close` and `afterTrial`).
- `turns` is the number of `user` messages.
- **A turn** starts at a `user` message and ends at the next `assistant` message. For each turn that
  ends:
  - `replyMs` gets `assistant.at − user.at`;
  - `ttftMs` gets `firstToken − user.at`, where `firstToken` is the assistant message's
    `firstTokenAt`, else the `firstTokenAt` of the first `model_call` in the turn that has one, else
    the assistant message's `at`.
- A `user` message that follows another `user` message with no assistant reply between them starts a
  new turn; the earlier turn adds nothing to `ttftMs` or `replyMs`. An `assistant` message outside a
  turn adds nothing either. So `ttftMs` and `replyMs` can be shorter than `turns`.
- `modelCalls` counts `model_call` events, failed ones included. `inputTokens` and `outputTokens` sum
  their fields (a missing field counts as 0).
- `costUsd` sums `costUsd` and is rounded to 8 decimal places. `costComplete` is `false` as soon as
  one `model_call` has no `costUsd`; then `costUsd` is a lower bound. A trial without model calls has
  `costUsd: 0` and `costComplete: true`.
- `toolCalls` counts `tool_call` events.

```ts doctest
import assert from 'node:assert/strict';

import { answerOf, completeTranscript, metricsOf, toolUses } from '@agent-evals/core';

const transcript = completeTranscript([
  { type: 'message', role: 'user', text: 'When is RE-1001 due?', at: 1_000 },
  {
    type: 'model_call',
    model: 'some-model',
    startedAt: 1_010,
    firstTokenAt: 1_200,
    endedAt: 1_400,
    inputTokens: 50,
    outputTokens: 10,
    costUsd: 0.0001,
    at: 1_400,
  },
  { type: 'tool_call', id: 'c1', name: 'get_invoice', args: { number: 'RE-1001' }, at: 1_410 },
  { type: 'tool_result', id: 'c1', name: 'get_invoice', result: { due: '2026-06-11' }, at: 1_500 },
  // No costUsd: the trial's cost becomes a lower bound.
  { type: 'model_call', model: 'some-model', startedAt: 1_510, endedAt: 1_900, at: 1_900 },
  { type: 'message', role: 'assistant', text: 'It is due on June 11, 2026.', at: 1_950 },
]);

assert.deepEqual(toolUses(transcript), [
  {
    id: 'c1',
    name: 'get_invoice',
    args: { number: 'RE-1001' },
    at: 1_410,
    result: { due: '2026-06-11' },
  },
]);
assert.equal(answerOf(transcript).finalAnswer, 'It is due on June 11, 2026.');

const metrics = metricsOf(transcript, 900, 2_000);
assert.equal(metrics.durationMs, 1_100);
assert.deepEqual(metrics.ttftMs, [200]); // the first model call's first token, 200 ms after the question
assert.deepEqual(metrics.replyMs, [950]);
assert.equal(metrics.modelCalls, 2);
assert.equal(metrics.toolCalls, 1);
assert.equal(metrics.costUsd, 0.0001);
assert.equal(metrics.costComplete, false);

// Missing times: start + the event's index in the list.
const filled = completeTranscript(
  [
    { type: 'note', text: 'a' },
    { type: 'note', text: 'b', at: 5 },
    { type: 'note', text: 'c' },
  ],
  100,
);
assert.deepEqual(
  filled.map((event) => event.at),
  [100, 5, 102],
);
```

### Reference transcripts in task files

A task's `reference.transcript` uses the same events. The task schema checks only that each event
has a `type` from the six above and, if present, a numeric `at`; it does not check the other fields
per type. A reference event with a wrong field (a `message` without `role`) passes the schema and then
grades as if the field were missing. See [Task and suite files](task-and-suite-files.md#reference-solutions-and-validate).

## `run.json`

`run.json` holds the complete `RunResult` of a run as pretty-printed JSON (two-space indent, trailing
newline), with `formatVersion` first. `readRun(path)` reads it back from the file or from the folder
that holds it, and fails when the value has no `trials` or `suites` array, or when `formatVersion` is
not a positive whole number or is newer than the package's `FORMAT_VERSION`. A file without
`formatVersion` (written before 0.1.0) reads as version 1. `writeReports` writes the version the run
carries, and the current one for a run built in code without a version.

### `RunResult`

| Field           | Type                              | Required | Meaning                                                                                                                            |
| --------------- | --------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `formatVersion` | number                            | no       | The format's version, `1` today. `runEval` sets it and `writeReports` always writes it; only a file written before 0.1.0 lacks it. |
| `id`            | string                            | yes      | A random UUID of the run.                                                                                                          |
| `startedAt`     | string (ISO 8601)                 | yes      | When the run started.                                                                                                              |
| `finishedAt`    | string (ISO 8601)                 | yes      | When the last trial was graded.                                                                                                    |
| `targets`       | `{ name, description? }[]`        | yes      | The targets in the configuration's order.                                                                                          |
| `suites`        | `RunSuite[]`                      | yes      | The suites in the configuration's order.                                                                                           |
| `trials`        | [`TrialResult`](#trialresult)`[]` | yes      | One entry per trial: per suite, per task, per target, per trial index, in that nesting order.                                      |
| `meta`          | object                            | no       | See below.                                                                                                                         |

`RunSuite` is `{ name, kind, owner?, tasks, saturation?, graduation? }`: `kind` is `"capability"` or
`"regression"`, `tasks` lists the ids of **every** task of the suite (also the ones a `--task` filter
left out), `saturation` is the suite file's `{ threshold }` and `graduation` its `{ k, runs }`.

`meta` holds the configuration's `meta` object, plus these keys the package adds:

| Key            | Value             | When                                                                              |
| -------------- | ----------------- | --------------------------------------------------------------------------------- |
| `modelGraders` | `"skipped"`       | The run had no judge and a task of the run has a model grader, which did not run. |
| `regradedAt`   | string (ISO 8601) | `agent-evals regrade` graded the run again.                                       |

### `TrialResult`

| Field            | Type                                | Required | Meaning                                                                                                                                                                                                                                      |
| ---------------- | ----------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `suite`          | string                              | yes      | The suite's name.                                                                                                                                                                                                                            |
| `suiteKind`      | `"capability"` \| `"regression"`    | yes      | The suite's kind. The summary prefers the kind in `RunResult.suites`.                                                                                                                                                                        |
| `taskId`         | string                              | yes      | The task's id.                                                                                                                                                                                                                               |
| `target`         | string                              | yes      | The target's name.                                                                                                                                                                                                                           |
| `trial`          | integer                             | yes      | The 0-based trial index within the task and target.                                                                                                                                                                                          |
| `status`         | [status](#statuses)                 | yes      | How the last attempt ended.                                                                                                                                                                                                                  |
| `attempts`       | integer ≥ 1                         | yes      | Attempts made, the retries after infrastructure errors included.                                                                                                                                                                             |
| `infraErrors`    | string[]                            | yes      | The message of each attempt that ended with an infrastructure error. Empty when there was none.                                                                                                                                              |
| `error`          | string                              | no       | The last attempt's error message.                                                                                                                                                                                                            |
| `outcome`        | any JSON value                      | yes      | The environment's final state as the adapter read it after the trial; `null` when the adapter returned none, or when reading it failed after a failed attempt (a rejecting `outcome()` after a normal conversation fails the trial instead). |
| `grades`         | [`GraderResult`](#graderresult)`[]` | yes      | One per grader that ran, in the task's order of graders (after `regrade` without a judge, the kept model grader results come last). Empty for an infrastructure error.                                                                       |
| `ungraded`       | `true`                              | no       | Present only when the trial has no verdict although the task has graders. See [statuses](#statuses).                                                                                                                                         |
| `gradingError`   | string                              | no       | `"the judge failed: …"`: the grading failed after the attempt (the judge's provider stayed down). The trial is then `ungraded`.                                                                                                              |
| `score`          | number 0..1                         | yes      | The weighted mean of the grader scores (the partial credit). 0 unless `status` is `completed` and the trial is graded.                                                                                                                       |
| `passed`         | boolean                             | yes      | The task's verdict under its scoring mode. Only a `completed`, graded trial can pass.                                                                                                                                                        |
| `metrics`        | [`TrialMetrics`](#trialmetrics)     | yes      | Numbers from the transcript.                                                                                                                                                                                                                 |
| `transcript`     | event[]                             | yes      | The last attempt's transcript.                                                                                                                                                                                                               |
| `transcriptFile` | string                              | no       | The JSONL file, relative to the run folder, with `/` as the separator on every OS. Present when the run had an output folder.                                                                                                                |
| `startedAt`      | string (ISO 8601)                   | yes      | When the last attempt started.                                                                                                                                                                                                               |

### Statuses

| `status`      | Meaning                                                                                                                                      | Graded?                        | `score`, `passed` |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ----------------- |
| `completed`   | The conversation ended normally and the outcome was read.                                                                                    | yes                            | from the graders  |
| `agent_error` | The adapter threw an error that is not an `InfraError` (the agent failed, refused, or ran out of rounds).                                    | yes, on the partial transcript | `0`, `false`      |
| `timeout`     | The trial took longer than its `timeoutMs`. The adapter's `signal` was aborted.                                                              | yes, on the partial transcript | `0`, `false`      |
| `infra_error` | The eval's infrastructure failed after all retries (an `InfraError` from the adapter, a failed `beforeTrial` hook, a failed simulated user). | no (`grades` is empty)         | `0`, `false`      |

`ungraded: true` marks a trial whose status is not `infra_error`, whose task has graders, and which
has no verdict. This happens when every grader of the task is a model grader and the run had no
judge, or when the grading failed (`gradingError`: the judge's provider stayed down; `grades` is then
empty and `regrade` with a judge grades the trial again). Such a trial counts like an infrastructure error in the metrics: it is left out of `n`, `c`,
pass@k and pass^k, so a dry run cannot pass a task it never graded.

The grader results of an `agent_error` or `timeout` trial are kept for reading, but they never make the
trial pass.

### `GraderResult`

| Field        | Type                          | Required | Meaning                                                                                                                             |
| ------------ | ----------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `id`         | string                        | yes      | The grader's id in the task: its `id`, else its type, `type#2` for the second unnamed grader of a type, and so on.                  |
| `type`       | string                        | yes      | The grader's type.                                                                                                                  |
| `score`      | number 0..1                   | yes      | The grader's own score, else the share of passed assertions (1 when there are none). 0 for a grader error.                          |
| `passed`     | boolean                       | yes      | Every assertion passed and the verdict is not unknown. With `onUnknown: ignore`, every decided assertion passed.                    |
| `weight`     | number ≥ 0                    | yes      | The weight in the weighted mean (default 1; 0 with `onUnknown: ignore` when nothing was decided).                                   |
| `required`   | boolean                       | yes      | Whether the grader must pass in hybrid scoring (default `false`).                                                                   |
| `assertions` | [`Assertion`](#assertion)`[]` | yes      | What the grader checked. Empty for a grader error.                                                                                  |
| `unknown`    | boolean                       | no       | The grader could not decide (a judge's "unknown"). Present for every grader that ran without throwing.                              |
| `details`    | any JSON value                | no       | Whatever the grader keeps for the report. The `judge` grader keeps `{ dimensions: [...] }`; see [Graders](graders.md#judge).        |
| `error`      | string                        | no       | The grader threw, or its type is unknown. The grader then counts as failed with score 0; this is a grader error, never the agent's. |

### `Assertion`

| Field      | Type           | Required | Meaning                                            |
| ---------- | -------------- | -------- | -------------------------------------------------- |
| `name`     | string         | yes      | What was checked, in words (`called get_invoice`). |
| `passed`   | boolean        | yes      | Whether it holds.                                  |
| `expected` | any JSON value | no       | What the grader expected.                          |
| `actual`   | any JSON value | no       | What it found.                                     |
| `message`  | string         | no       | Why it failed, or a judge's reason.                |
| `unknown`  | `true`         | no       | Not decided (a judge's unknown dimension).         |

### `TrialMetrics`

| Field          | Type     | Meaning                                                              |
| -------------- | -------- | -------------------------------------------------------------------- |
| `durationMs`   | number   | The last attempt's duration.                                         |
| `ttftMs`       | number[] | Per finished turn: from the user message to the first token.         |
| `replyMs`      | number[] | Per finished turn: from the user message to the assistant message.   |
| `turns`        | integer  | User messages.                                                       |
| `modelCalls`   | integer  | `model_call` events.                                                 |
| `toolCalls`    | integer  | `tool_call` events.                                                  |
| `inputTokens`  | integer  | Sum over the model calls.                                            |
| `outputTokens` | integer  | Sum over the model calls.                                            |
| `costUsd`      | number   | Sum over the model calls, in USD, rounded to 8 decimals.             |
| `costComplete` | boolean  | Every model call reported its cost; else `costUsd` is a lower bound. |

The exact rules are under [How the package reads a transcript](#how-the-package-reads-a-transcript).

## `summary.json`

`summary.json` holds the numbers behind `report.md` and `report.html`, as pretty-printed JSON. It is
written next to `run.json` by `run`, `report` and `regrade`, and it is derived data: `report` writes it
again from `run.json` at any time. The meaning of the metrics is explained in [Metrics](metrics.md);
this section lists the fields.

| Field         | Type                                                | Meaning                                                                            |
| ------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `run`         | string                                              | The run's `id`.                                                                    |
| `summary`     | [`Summary`](#summary)                               | Per task and per group (suite × target).                                           |
| `saturation`  | `SaturationNote[]`                                  | Per capability suite and target: `{ suite, target, saturated, pass1, threshold }`. |
| `diff`        | [`RunDiff`](#rundiff) \| `null`                     | The comparison with the baseline run, when one was given.                          |
| `failures`    | [`FailureRow`](#failurerow)`[]`                     | Every graded trial that did not pass, with its failure class.                      |
| `ungraded`    | `UngradedRow[]`                                     | Every ungraded trial: `{ suite, taskId, target, trial, status, reason, error? }`.  |
| `calibration` | [`CalibrationReport`](#calibrationreport) \| `null` | The judge calibration, when labels were given.                                     |

`SaturationNote.threshold` is the suite's `saturation.threshold`, else `0.9`. `saturated` is `true`
when `pass1` is not `null` and reaches the threshold. Regression suites get no note.

### `Summary`

`{ k, groups, tasks, brokenTaskSuspects }`, where `k` is the k of pass@k and pass^k.

`tasks[]` (`TaskSummary`), one per suite, target and task:

| Field                                    | Type                                               | Meaning                                                               |
| ---------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------- |
| `target`, `suite`, `suiteKind`, `taskId` | string                                             | What the row is about.                                                |
| `trials`                                 | integer                                            | Every trial, infrastructure errors and ungraded trials included.      |
| `n`                                      | integer                                            | Graded trials: not `infra_error` and not `ungraded`.                  |
| `c`                                      | integer                                            | Passed trials among the `n`.                                          |
| `pass1`                                  | number \| `null`                                   | `c / n`; `null` when `n` is 0.                                        |
| `passAtK`, `passHatK`                    | number \| `null`                                   | `null` when `n < k`.                                                  |
| `score`                                  | number \| `null`                                   | The mean `score` of the graded trials.                                |
| `statuses`                               | `{ completed, agent_error, timeout, infra_error }` | Trials per status.                                                    |
| `infraErrors`                            | integer                                            | Attempts that hit an infrastructure error, the retried ones included. |
| `infraErrorRate`                         | number                                             | `infraErrors` over all attempts (0 without attempts).                 |
| `graderErrors`                           | integer                                            | Trials in which at least one grader has an `error`.                   |
| `gradingErrors`                          | integer                                            | Trials with a `gradingError` (the judge failed), apart from attempts. |
| `gradingErrorRate`                       | number                                             | `gradingErrors` over the trials.                                      |

`groups[]` (`GroupSummary`), one per suite and target:

| Field                                     | Type                                                                   | Meaning                                                         |
| ----------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------- |
| `target`, `suite`, `suiteKind`            | string                                                                 | What the row is about.                                          |
| `tasks`, `trials`, `graded`               | integer                                                                | Tasks, all trials, graded trials.                               |
| `pass1`                                   | number \| `null`                                                       | The mean of the tasks' `pass1` (tasks with `null` left out).    |
| `passAtK`, `passHatK`                     | number \| `null`                                                       | The mean over the tasks with at least k graded trials.          |
| `tasksBelowK`                             | integer                                                                | Tasks left out of those two means.                              |
| `score`                                   | number \| `null`                                                       | The mean of the tasks' `score`.                                 |
| `ttftMs`, `replyMs`                       | `{ p50, p90 }` (number \| `null` each)                                 | Nearest-rank percentiles over every turn of every graded trial. |
| `perTask`                                 | `{ turns, modelCalls, toolCalls, inputTokens, outputTokens, costUsd }` | Means per graded trial (`null` without graded trials).          |
| `costComplete`                            | boolean                                                                | Every graded trial's cost is complete.                          |
| `rates`                                   | `{ agentError, timeout, infraError }`                                  | Over all attempts.                                              |
| `attempts`, `infraErrors`, `graderErrors` | integer                                                                | As for a task, summed over the group.                           |
| `gradingErrors`, `gradingErrorRate`       | integer, number                                                        | As for a task, over the group's trials.                         |

`brokenTaskSuspects[]` is `{ suite, taskId, trials, targets }` for each task that no target passed
even once while its graded trials over all targets add up to at least `k`.

### `RunDiff`

`{ before, after, k, minDrop, tasks, groups, regressions, improvements }`. `before` and `after` are run
ids, `minDrop` is the pass@1 drop that counts as a regression (0.34 from the CLI), `regressions` and
`improvements` count the tasks of those kinds.

`tasks[]` is `{ suite, target, taskId, kind, before, after, pass1Change }`, sorted by kind in the order
`regression`, `improvement`, `new`, `removed`, `incomparable`, `unchanged`. `before` and `after` are
`{ n, c, pass1, passHatK }` or `null` (for a new or removed task). `pass1Change` is after − before, or
`null`.

`groups[]` is `{ suite, target, before, after, delta }`, where `before` and `after` are
`{ pass1, passHatK, costUsd, replyP50 }` or `null`, and `delta` holds after − before for each of those
four (`null` where a side is missing).

### `FailureRow`

One per trial with `passed: false` that is not `ungraded`, in the run's order of suites, targets,
tasks and trials.

| Field                                | Type                                                               | Meaning                                                                                                                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `suite`, `taskId`, `target`, `trial` |                                                                    | Which trial.                                                                                                                                                                                |
| `status`                             | status                                                             | The trial's status.                                                                                                                                                                         |
| `class`                              | `"agent"` \| `"grader"` \| `"task"` \| `"infra"` \| `"unreviewed"` | From the [reviews file](#the-reviews-file). An `infra_error` trial is always `infra`, whatever a review says.                                                                               |
| `annotation`, `reviewer`             | string                                                             | From the matching review, when it has them.                                                                                                                                                 |
| `failing`                            | string[]                                                           | Per failed grader: `"<id>: grader error (<message>)"`, `"<id>: unknown"`, `"<id>: <assertion> (<message>)"` per failed assertion, or `"<id>: failed (score <s>)"` when no assertion failed. |
| `error`                              | string                                                             | The trial's `error`, when it has one.                                                                                                                                                       |
| `score`                              | number                                                             | The trial's score.                                                                                                                                                                          |

An `ungraded` trial has `passed: false` but no verdict, so it says nothing about the agent: it is
left out of `failures` and listed under `ungraded`, in the same order, with the `reason` (the
`gradingError`, or `no judge for its model graders`).

### `CalibrationReport`

`{ dimensions, sample }`, written by `calibrate` and by `run` or `report` with `--labels`.

`dimensions[]`, one per judge grader id and rubric dimension that has labels:

| Field          | Type                        | Meaning                                                                              |
| -------------- | --------------------------- | ------------------------------------------------------------------------------------ |
| `grader`       | string                      | The judge grader's id.                                                               |
| `dimension`    | string                      | The rubric dimension's name.                                                         |
| `n`            | integer                     | Labels a person decided (not `unknown`) whose trial and dimension the judge graded.  |
| `agreement`    | number \| `null`            | The share of those where the judge's verdict equals the label; `null` when `n` is 0. |
| `kappa`        | number \| `null`            | Cohen's kappa over the pairs where neither side said `unknown`.                      |
| `unknownRate`  | number \| `null`            | How often the judge said `unknown` among the `n`.                                    |
| `humanUnknown` | integer                     | Labels left at (or set to) `unknown` whose trial the judge graded.                   |
| `confusion`    | `{ judge, human, count }[]` | Every judge × human verdict pair, `unknown` labels included.                         |

`sample[]` is every label with `judge` (the judge's verdict, or `null` when the run has no such trial,
grader or dimension) and, when the judge gave one, `judgeReason`.

## The labels file

A labels file holds a person's verdicts on judge dimensions: the gold standard a model judge is
calibrated against. `agent-evals label` writes a sheet to fill in, the viewer writes labels into it,
and `calibrate`, `run --labels` and `report --labels` read it. See [Judges](judges-and-calibration.md) for the
workflow.

The file is YAML (JSON also parses, as JSON is YAML). Its top level is either a list of labels or an
object with a `labels` list. A missing or empty list means no labels.

| Field       | Type                                | Required | Meaning                                                                             |
| ----------- | ----------------------------------- | -------- | ----------------------------------------------------------------------------------- |
| `suite`     | string                              | no       | The suite. Without it, the label matches the trial in any suite.                    |
| `taskId`    | string, non-empty                   | yes      | The task.                                                                           |
| `target`    | string, non-empty                   | yes      | The target.                                                                         |
| `trial`     | integer ≥ 0                         | yes      | The trial index.                                                                    |
| `grader`    | string, non-empty                   | yes      | The judge grader's id in the task (`judge`, `judge#2` or its `id`).                 |
| `dimension` | string, non-empty                   | yes      | The rubric dimension's `name`.                                                      |
| `label`     | `"pass"` \| `"fail"` \| `"unknown"` | yes      | The person's verdict. `unknown` means not decided and is left out of the agreement. |
| `labeller`  | string                              | no       | Who labelled. An empty string means not given.                                      |
| `note`      | string                              | no       | Why. An empty string means not given.                                               |

Other keys are allowed and ignored when the labels are read. The sheet that `agent-evals label`
writes uses three of them to help the person decide: `question` (the dimension's question), `input`
(the user's messages, cut to 600 characters) and `answer` (the agent's answer, cut to 1,500
characters). A new sheet has `label: unknown`, `labeller: ''` and `note: ''` in every entry, starts with
a comment that explains the task, and leaves the judge's verdict out so it cannot anchor the person.

```yaml
# Labelling sheet for the model judge's calibration.
- suite: invoice-desk-capability
  taskId: sum-in-approval
  target: model-a
  trial: 0
  grader: judge
  dimension: grounded
  question: Is every number in the answer taken from or computed from the tool results shown?
  input: How much is waiting for approval in total?
  answer: 1,250.00 EUR in total.
  label: pass
  labeller: Dana
  note: ''
```

A label is identified by `suite`, `taskId`, `target`, `trial`, `grader` and `dimension`. When the
viewer saves a label with the same key, it replaces the entry's label fields and keeps the sheet's
helper fields. The viewer also bounds the input: 500 characters for each key field, 200 for
`labeller`, 2,000 for `note`, and a trial index of at most 1,000,000. It writes the file through a
temporary file and a rename, as a plain list after a two-line comment.

## The reviews file

A reviews file holds what a person found when reading the transcripts of failed trials: the class of
each failure and a note. `report` and `regrade` read `<run folder>/reviews.yaml` by default; `run`
reads one only with `--reviews <file>`. The classes appear in `summary.json` under `failures` and in
the reports.

The file is YAML (or JSON). Its top level is a list of reviews or an object with a `reviews` list and
no other key. A missing file, an empty file or a file holding only `null` means nothing was reviewed
yet. Any other invalid content fails the command with the file name and the problems.

| Field        | Type                                             | Required | Meaning                                                                      |
| ------------ | ------------------------------------------------ | -------- | ---------------------------------------------------------------------------- |
| `suite`      | string, non-empty                                | no       | The suite. Without it, the review matches any suite.                         |
| `taskId`     | string, non-empty                                | yes      | The task.                                                                    |
| `target`     | string, non-empty                                | yes      | The target.                                                                  |
| `trial`      | integer ≥ 0                                      | no       | The trial. Without it, the review covers every trial of the task and target. |
| `class`      | `"agent"` \| `"grader"` \| `"task"` \| `"infra"` | yes      | Where the failure lies.                                                      |
| `annotation` | string                                           | no       | What went wrong, for the reports' annotated examples.                        |
| `reviewer`   | string                                           | no       | Who reviewed.                                                                |

No other key is allowed. When several reviews match a trial, the most specific one wins: one that
names the trial beats one that doesn't, then one that names the suite beats one that doesn't, then the
first in the file.

```yaml
- { taskId: due-date, target: model-a, class: grader, annotation: The date format was valid. }
- { taskId: due-date, target: model-a, trial: 2, class: agent, annotation: Guessed the date. }
```

## Reading the files in code

The example below runs a tiny suite with the `scripted` adapter, writes the reports, and reads back
the transcript file, `run.json`, `summary.json`, a reviews file and a labels file.

```ts doctest
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  calibrate,
  defineSuite,
  FORMAT_VERSION,
  loadLabels,
  readRun,
  runEval,
  scriptedAdapter,
  writeReports,
} from '@agent-evals/core';

const suite = defineSuite({
  name: 'demo',
  kind: 'regression',
  tasks: [
    {
      id: 'greet',
      input: { turns: ['Hello'] },
      graders: [
        { type: 'facts', facts: ['hello'] },
        {
          type: 'judge',
          rubric: { name: 'polite', question: 'Is it polite?', pass: 'Yes.', fail: 'No.' },
        },
      ],
    },
  ],
});

// A fake judge: no model, no key. It answers every dimension with "pass".
const judge = {
  complete: async () => ({ text: '{"reason": "It greets back.", "verdict": "pass"}' }),
};

const out = mkdtempSync(join(tmpdir(), 'agent-evals-doc-'));
const run = await runEval({
  suites: [suite],
  targets: [
    {
      name: 'bot',
      adapter: scriptedAdapter({
        replies: {
          greet: [
            {
              text: 'Hello! Nobody else is here.',
              events: [{ type: 'tool_call', id: 't1', name: 'who_is_here', args: {} }],
            },
          ],
        },
      }),
    },
  ],
  trials: 1,
  judge,
  outDir: out,
});

// The transcript file: one event per line, in the order they were recorded.
const trial = run.trials[0]!;
assert.equal(trial.transcriptFile, 'transcripts/demo/bot/greet.0.jsonl');
const events = readFileSync(join(out, trial.transcriptFile!), 'utf8')
  .split('\n')
  .filter((line) => line !== '')
  .map((line) => JSON.parse(line));
assert.deepEqual(
  events.map((event) => event.type),
  ['message', 'tool_call', 'message'],
);
assert.ok(events.every((event) => typeof event.at === 'number'));
// Every line carries the format's version (run.json does too, below).
assert.ok(events.every((event) => event.formatVersion === FORMAT_VERSION));

// A reviews file next to the run, and a labels file a person filled in.
writeFileSync(
  join(out, 'reviews.yaml'),
  '- { taskId: greet, target: bot, class: agent, annotation: Made up a claim. }\n',
);
const labelsFile = join(out, 'labels.yaml');
writeFileSync(
  labelsFile,
  'labels:\n  - { taskId: greet, target: bot, trial: 0, grader: judge, dimension: polite, label: fail }\n',
);
const calibration = calibrate(run, loadLabels(labelsFile));
assert.equal(calibration.dimensions[0]!.agreement, 0); // the judge said pass, the person fail

writeReports(run, out, {
  reviewsFile: join(out, 'reviews.yaml'),
  labelsCalibration: calibration,
});

const saved = readRun(out);
assert.equal(saved.formatVersion, FORMAT_VERSION);
assert.equal(saved.trials[0]!.status, 'completed');
assert.deepEqual(
  saved.trials[0]!.grades.map((grade) => grade.id),
  ['facts', 'judge'],
);

const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'));
assert.deepEqual(Object.keys(summary), [
  'run',
  'summary',
  'saturation',
  'diff',
  'failures',
  'ungraded',
  'calibration',
]);
assert.equal(summary.summary.tasks[0].pass1, 1);
assert.deepEqual(summary.failures, []); // the trial passed, so the review classifies nothing
```
