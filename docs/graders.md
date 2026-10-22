# Graders

A **grader** scores one aspect of a trial through **assertions**. A task lists its graders (after the
suite's default graders); each grader runs on the trial's transcript, its answer and its outcome, and
returns a result with a score from 0 to 1 and a verdict. The task's **scoring mode** turns the
results into the trial's verdict.

This page is the reference of every built-in grader, of the matcher language their parameters use,
and of the rules that combine grader results: ids, scores, scoring modes, unknown verdicts, grader
errors and ungraded trials. How to write your own grader is in [Extending](extending.md); how to
calibrate a judge against people is in [Judges and calibration](judges-and-calibration.md).

## What a grader sees

| Name         | What it is                                                                                         |
| ------------ | -------------------------------------------------------------------------------------------------- |
| transcript   | Every event of the trial ([format](transcript-format.md#events)).                                  |
| tool calls   | The `tool_call` events paired with their results by id, in the order they were made.               |
| answer       | The text of every `assistant` message, joined by a blank line.                                     |
| final answer | The text of the last `assistant` message (empty when there is none).                               |
| outcome      | The environment's final state, as the adapter read it after the trial (not what the agent claims). |
| task         | The task, its input and its reference solution.                                                    |

## Built-in graders

| Type                                          | Kind  | Checks                                                                   |
| --------------------------------------------- | ----- | ------------------------------------------------------------------------ |
| [`tool_called`](#tool_called)                 | code  | A tool was called, with matching arguments, a number of times, or first. |
| [`tool_not_called`](#tool_not_called)         | code  | None of the tools was called.                                            |
| [`tool_calls`](#tool_calls)                   | code  | The number of tool calls is within limits.                               |
| [`no_placeholder_args`](#no_placeholder_args) | code  | No argument is a placeholder such as `<id>` or `TODO`.                   |
| [`no_repeated_calls`](#no_repeated_calls)     | code  | No tool was called twice with the same arguments.                        |
| [`outcome`](#outcome)                         | code  | The final state of the environment.                                      |
| [`facts`](#facts)                             | code  | The answer states each fact. Partial credit.                             |
| [`forbid`](#forbid)                           | code  | The answer states none of the patterns.                                  |
| [`limits`](#limits)                           | code  | Turns, model calls and tool calls stay within a budget.                  |
| [`language`](#language)                       | code  | The answer is in German or English.                                      |
| [`formality`](#formality)                     | code  | A German answer uses the formal "Sie".                                   |
| [`no_error`](#no_error)                       | code  | No agent error, timeout or tool error.                                   |
| [`asks_back`](#asks_back)                     | code  | The agent asks the user back instead of acting, or acts.                 |
| [`judge`](#judge)                             | model | A model grades the trial on a rubric, one dimension per call.            |

Code graders are fast, cheap and reproducible: prefer them, and use a judge only for what code cannot
check. A model grader needs a judge client; without one it is skipped (see [Ungraded
trials](#ungraded-trials-and-skipped-model-graders)).

Unless a grader says otherwise, its score is the share of its assertions that passed (1 when it has
none), and it passes when every assertion passes. A missing or wrong required parameter makes the
grader throw, which is a [grader error](#grader-errors-and-agent-errors).

Every example on this page is a complete grader entry of a task's `graders` list.

### `tool_called`

The agent called the tool, optionally with matching arguments. The tool can be called anywhere in the
trial; the grader does not demand one exact path.

| Parameter | Type                       | Required | Default | Meaning                                                                                                     |
| --------- | -------------------------- | -------- | ------- | ----------------------------------------------------------------------------------------------------------- |
| `tool`    | string                     | yes      |         | The tool's name, compared ignoring case, or `re:<pattern>`. See [tool names](#tool-names).                  |
| `args`    | `{ <path>: <matcher> }`    | no       | `{}`    | Every path must match in the **same** call. See [the matcher language](#the-matcher-language).              |
| `count`   | number or `{ min?, max? }` | no       |         | How many calls must match name and arguments, in place of "at least one". A number means exactly that many. |
| `first`   | boolean                    | no       | `false` | The trial's first tool call (of any tool) must be this tool, with these arguments.                          |

Assertions:

- Without `count`: `called <tool>` passes when any call has the name. When `args` is given and the
  tool was called, `<tool> with matching args` passes when one of those calls matches every path; its
  message lists why the other calls did not match. So a call with wrong arguments scores 0.5, and no
  call at all scores 0.
- With `count`: one assertion, `<tool> called <count> times`, on the number of calls that match name
  and arguments.
- With `first: true`, also `first call is <tool>`.

```yaml
{ type: tool_called, tool: list_invoices, args: { status: in_approval, vendor: 're:schmidt' } }
```

```yaml
{ type: tool_called, tool: 're:^get_', count: { min: 1, max: 2 }, first: true }
```

### `tool_not_called`

None of the tools was called.

| Parameter | Type     | Required          | Meaning                  |
| --------- | -------- | ----------------- | ------------------------ |
| `tool`    | string   | `tool` or `tools` | A name or `re:` pattern. |
| `tools`   | string[] | `tool` or `tools` | More names or patterns.  |

One assertion per name or pattern, `did not call <pattern>`, which passes when no call matches it. Its
`actual` lists the offending calls.

```yaml
{ type: tool_not_called, tools: [pay_invoice, 're:^delete_'], required: true }
```

### `tool_calls`

The number of tool calls is within limits. Arguments are not looked at.

| Parameter | Type    | Required       | Meaning                                       |
| --------- | ------- | -------------- | --------------------------------------------- |
| `tool`    | string  | no             | Count only the calls of this name or pattern. |
| `min`     | integer | `min` or `max` | At least this many calls.                     |
| `max`     | integer | `min` or `max` | At most this many calls.                      |

One assertion for each bound given. `max: 0` checks that the agent answered without tools.

```yaml
{ type: tool_calls, max: 0 }
```

### `no_placeholder_args`

No string argument of any call is a placeholder: the sign of a model that calls a tool before it has
the value.

| Parameter | Type     | Required | Default    | Meaning                                          |
| --------- | -------- | -------- | ---------- | ------------------------------------------------ |
| `tools`   | string[] | no       | every tool | Check only the calls of these names or patterns. |

Every string anywhere in the arguments (nested objects and arrays included) is checked. A string is a
placeholder when, after trimming, it:

- is empty;
- is, ignoring case, one of `string`, `str`, `uuid`, `guid`, `id`, `null`, `undefined`, `none`,
  `todo`, `tbd`, `placeholder`, `...`, `…`;
- is the nil GUID `00000000-0000-0000-0000-000000000000`;
- is wrapped as a whole in `<…>`, `{{…}}` or `${…}`;
- is three or more `x` (any case), or three or more dots;
- contains `lorem ipsum` (any case).

One assertion, `no placeholder arguments`. Its `actual` lists each finding as
`<tool> <path>=<value>`.

```yaml
{ type: no_placeholder_args }
```

### `no_repeated_calls`

No tool was called twice with deep-equal arguments: the sign of a loop or a lost result.

| Parameter | Type     | Required | Default    | Meaning                                                                                     |
| --------- | -------- | -------- | ---------- | ------------------------------------------------------------------------------------------- |
| `tools`   | string[] | no       | every tool | Check only these names or patterns.                                                         |
| `ignore`  | string[] | no       |            | Leave these names or patterns out (a tool that is meant to poll).                           |
| `perTurn` | boolean  | no       | `false`    | Compare only the calls within one user turn: a later question may need the same read again. |

Two calls repeat each other when the tool name is the same and the arguments are equal as canonical
JSON (object keys sorted, so key order does not matter). With `perTurn`, a call belongs to the turn of
the last user message whose `at` is not later than the call's `at`. One assertion, `no repeated
calls`; its `actual` lists each repeated call with `×<count>`.

```yaml
{ type: no_repeated_calls, ignore: [get_job_status], perTurn: true }
```

### `outcome`

The final state of the environment, as the adapter read it after the trial. Grade the outcome first:
it is what the agent did, not what it says it did.

| Parameter | Type                    | Required             | Meaning                                                                        |
| --------- | ----------------------- | -------------------- | ------------------------------------------------------------------------------ |
| `expect`  | `{ <path>: <matcher> }` | `expect` or `equals` | One assertion per path. A path of `''` or `.` is the whole outcome.            |
| `equals`  | any value               | `expect` or `equals` | The whole outcome is deep-equal to this value (canonical JSON). `null` counts. |

```yaml
{
  type: outcome,
  required: true,
  expect:
    { writes: { length: 1 }, 'writes[0].tool': pay_invoice, 'writes[0].args.number': RE-1007 },
}
```

```yaml
{ type: outcome, equals: { writes: [], state: null } }
```

### `facts`

Each fact holds in the answer. The score is the share of facts found: **partial credit**.

| Parameter   | Type                                | Required | Default  | Meaning                                                                                            |
| ----------- | ----------------------------------- | -------- | -------- | -------------------------------------------------------------------------------------------------- |
| `facts`     | list of strings or lists of strings | yes      |          | Each entry is one fact. A list is one fact with alternatives: it holds when one alternative holds. |
| `on`        | `answer` \| `final`                 | no       | `answer` | Every assistant message, or only the final answer.                                                 |
| `allowEcho` | boolean                             | no       | `false`  | Count a fact that is found only because the answer quotes the user's message.                      |

How one fact is matched against the text:

1. **Normalization.** The text and a plain fact are normalized: Unicode NFC, the characters `*`, `_`
   and `` ` `` removed (Markdown emphasis and code marks), every run of whitespace (non-breaking
   spaces included) collapsed to one space, and trimmed.
2. **`re:<pattern>`** is a case-insensitive, Unicode-aware regular expression, tested on the raw
   text (as written) and on the normalized text; it holds when either matches. It is not anchored.
   So `re:snake_case` and `re:\*\*total` match the Markdown as written, and `re:total: 5` matches
   `**total**: 5`.
3. **A registered prefix** (`amount:1250`, see [fact matchers](#fact-matchers)) hands the fact without
   its prefix, and the raw text, to that matcher.
4. **Anything else** holds when the normalized fact is a case-insensitive substring of the normalized
   text.

**Echo removal.** Unless `allowEcho` is set, every user message of 20 or more characters (after
normalization) is removed from the normalized text and from the raw text (where Markdown marks and
any whitespace may sit between its characters), case-insensitively and everywhere it occurs, before
the facts are matched. An answer that only repeats the question does not get the facts the
question names. Shorter user messages stay, as removing a word such as a name would hide real answers.

One assertion per fact, `states <fact>` (alternatives joined with `|`).

```yaml
{ type: facts, facts: [RE-1001, ['1,250.00', '1250.00', '1.250,00'], 're:\bdue\b.*june'] }
```

### `forbid`

None of the patterns holds in the answer: the answer must not state a wrong value or a leaked one.

| Parameter  | Type                | Required | Default  | Meaning                                          |
| ---------- | ------------------- | -------- | -------- | ------------------------------------------------ |
| `patterns` | non-empty string[]  | yes      |          | Matched like [facts](#facts), prefixes included. |
| `on`       | `answer` \| `final` | no       | `answer` | As for `facts`.                                  |

One assertion per pattern, `does not state <pattern>`, which passes when the pattern does not hold.
Unlike `facts`, `forbid` removes no echo: an answer that quotes the user's words containing a
forbidden pattern fails.

```yaml
{ type: forbid, patterns: [RE-1003, 're:\bdeleted\b'] }
```

### `limits`

The trial stays within its budget.

| Parameter       | Type    | Meaning                                  |
| --------------- | ------- | ---------------------------------------- |
| `maxTurns`      | integer | At most this many user messages.         |
| `maxUserTurns`  | integer | The same check as `maxTurns` (an alias). |
| `maxModelCalls` | integer | At most this many `model_call` events.   |
| `maxToolCalls`  | integer | At most this many `tool_call` events.    |

At least one of them is required. One assertion per limit given, `at most <n> <what>`.

```yaml
{ type: limits, maxModelCalls: 6, maxToolCalls: 4 }
```

### `language`

The answer is in the expected language, by a cheap count of stop words.

| Parameter  | Type                | Required | Default  | Meaning                |
| ---------- | ------------------- | -------- | -------- | ---------------------- |
| `language` | `de` \| `en`        | yes      |          | The expected language. |
| `on`       | `answer` \| `final` | no       | `answer` | As for `facts`.        |

Fenced code blocks, inline code, Markdown link targets and URLs are removed first. The words (runs of
letters) are lower-cased and counted against a list of frequent function words that only one of the
two languages has. The grader passes when the expected language has **more** stop words than the
other; a tie fails, an answer without any stop word too. The counts are the assertion's `actual`.

```yaml
{ type: language, language: en }
```

### `formality`

German answers address the user formally ("Sie"), with no du-forms.

| Parameter  | Type                | Required | Default  | Meaning                      |
| ---------- | ------------------- | -------- | -------- | ---------------------------- |
| `language` | `de`                | no       | `de`     | The only supported language. |
| `register` | `formal`            | no       | `formal` | The only supported register. |
| `on`       | `answer` \| `final` | no       | `answer` | As for `facts`.              |

Any other `language` or `register` is a grader error. After removing code, link targets and URLs as
for `language`, the grader looks for the whole words `du`, `dich`, `dir`, `euch`, `euer` and every
word starting with `dein` or `eure`, ignoring case. It passes when there is none; the found words are
the assertion's `actual`. It does not check that "Sie" is used.

```yaml
{ type: formality, language: de, register: formal }
```

### `no_error`

The trial ran without errors.

| Parameter         | Type    | Default | Meaning                                                                        |
| ----------------- | ------- | ------- | ------------------------------------------------------------------------------ |
| `allowToolErrors` | boolean | `false` | Let tool errors pass: an agent that recovers from a failing tool still passes. |

Assertions: `no agent error` fails for each `error` event of kind `agent` or `timeout`; unless
`allowToolErrors`, `no tool error` fails for each `tool_result` with an `error`.

A trial whose status is `agent_error` or `timeout` never passes anyway; `no_error` makes the error
visible among the grader results and catches errors an adapter recorded without failing the trial.

```yaml
{ type: no_error, allowToolErrors: true }
```

### `asks_back`

Whether the agent asks the user back instead of acting (`expected: true`) or acts (`expected:
false`).

| Parameter    | Type     | Required | Meaning                                                                |
| ------------ | -------- | -------- | ---------------------------------------------------------------------- |
| `expected`   | boolean  | yes      | `true`: the agent should ask back. `false`: it should not.             |
| `writeTools` | string[] | no       | Names or patterns of the tools that act. A call of one means it acted. |

The agent asked back when both hold:

- its **final answer** has a sentence that ends in `?`: a `?` (or several) followed only by optional
  closing quotes, `)`, `*` or `_`, then whitespace or the end of the text. Fenced code, inline
  code, link targets and URLs are removed first, so the `?` of a URL's query does not count;
- it called none of the `writeTools`.

The grader passes when "asked back" equals `expected`. It is a heuristic; when the wording matters, a
judge dimension fits better.

```yaml
{ type: asks_back, expected: true, writeTools: [pay_invoice] }
```

### `judge`

A model grades the trial on a rubric. On the method's advice, each rubric dimension is decided in its
own call (so one verdict cannot colour the next), the judge writes its reason before its verdict, it
may answer "unknown" instead of guessing, and several judge models can vote.

| Parameter            | Type                                                                | Required | Default                                                    | Meaning                                                                          |
| -------------------- | ------------------------------------------------------------------- | -------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `rubric`             | dimension or dimension[]                                            | yes      |                                                            | Each dimension needs `name`, `question`, `pass` and `fail` (non-empty strings).  |
| `models`             | string[]                                                            | no       | the run's judge models, else the client's default model    | The judge models. With several, the majority decides.                            |
| `include`            | list of `input`, `answer`, `final`, `tools`, `outcome`, `reference` | no       | `[input, answer, tools]`                                   | What the judge sees.                                                             |
| `instructions`       | string                                                              | no       |                                                            | Extra guidance added to every dimension's question (the domain, what to ignore). |
| `onUnknown`          | `fail` \| `ignore`                                                  | no       | `fail`                                                     | What an unknown verdict means; see [Unknown verdicts](#unknown-verdicts).        |
| `toolResultMaxChars` | positive whole number                                               | no       | the configuration's `judge.toolResultMaxChars`, else `600` | How many characters of each tool result's JSON the judge sees; the rest is cut.  |

A dimension: `name` (the assertion's name and the label files' `dimension`), `question` (what the
judge answers), `pass` (what counts as pass) and `fail` (what counts as fail).

What `include` shows the judge, in this fixed order:

| Entry       | Shows                                                                                                             |
| ----------- | ----------------------------------------------------------------------------------------------------------------- |
| `input`     | The task's fixed turns and the simulated user's persona and goal.                                                 |
| `tools`     | Every tool call with its arguments and its result or error, shortened (a result to `toolResultMaxChars`).         |
| `answer`    | The assistant's answer; with more than one user message, the whole conversation.                                  |
| `final`     | The final answer only.                                                                                            |
| `outcome`   | The outcome as JSON, shortened.                                                                                   |
| `reference` | The reference solution's answer and outcome, marked as one correct way, not the only one (when the task has one). |

How it decides:

- One call per dimension and judge model, all at once, with temperature 0 and a 120-second limit.
  The judge is asked for `{"reason": "...", "verdict": "pass" | "fail" | "unknown"}`.
- An answer whose verdict cannot be read counts as `unknown`, with the raw answer as the reason.
- With several models, a dimension's verdict is `pass` or `fail` by majority. A tie between pass and
  fail is `unknown`, and so is a dimension where more than half of the models said `unknown`.
- A judge call that fails with an infrastructure error or a timeout is retried twice, 2 and then 4
  seconds later. After that the trial's grading failed: it is `ungraded` with a `gradingError` (never
  the agent's failure). Any other failure of the client is a grader error.

The result: one assertion per dimension (`expected: pass`, `actual` the verdict, `message` the
reason). The score is the share of dimensions with `pass`. The grader is `unknown` when any dimension
is unknown. `details` holds `{ dimensions: [{ name, question, verdict, reason, votes: [{ model,
verdict, reason }] }] }`, which the calibration and the viewer read.

```yaml
type: judge
weight: 2
include: [input, answer, tools]
rubric:
  - name: grounded
    question: Is every number in the answer taken from or computed from the tool results shown?
    pass: Every amount and count comes from the tool results.
    fail: The answer states an amount or count that the tool results don't support.
  - name: concise
    question: Does the answer give the total first, in at most three short sentences?
    pass: The total comes first and the answer is short.
    fail: The total is buried, or the answer is long-winded.
```

The prompts, the pairwise comparison (`comparePair`) and the calibration against human labels are in
[Judges and calibration](judges-and-calibration.md).

## The matcher language

The parameters `args` (of `tool_called`), `expect` (of `outcome`) and `when` (of a
[mock tool's response](task-and-suite-files.md#mock-tools)) map **paths** to **matchers**. Each path
selects a value; the matcher decides whether that value is right.

### Paths

| Path                    | Selects                                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| `''` or `.`             | The value itself (the whole outcome, all arguments).                                            |
| `number`                | The key `number` of an object.                                                                  |
| `writes[0].args.number` | Keys separated by `.`; `[n]` is the n-th element (0-based) of an array.                         |
| `writes.0.args`         | A segment of digits also indexes an array.                                                      |
| `..documentId`          | Every value of the key `documentId` anywhere in the value, at any depth, in objects and arrays. |

- A step into a value that is `null`, not an object or not an array gives `undefined`, so a matcher
  such as `{ absent: true }` can check that a path does not exist.
- A key cannot contain `.`, `[` or `]`.
- `..key` looks for the key anywhere; the rest of the path is read beneath each value found:
  `..a.b` is the key `a` anywhere, then its `b`, and `..lines[0].amount` works the same way. The path
  holds when **any** found value matches. When none is found, the matcher sees `undefined`.
- The parser is strict. Anything but the forms above (`a[0]b`, `a..b`, `a.`, `.a`, `a[x]`, an
  unclosed `[`) makes the grader throw `invalid path "<path>": …`, which `validate` reports as a
  problem of the task. `tool_called` checks its paths also when the tool was never called.
- In YAML, quote a path that contains `[` or starts with `.`: `'writes[0].tool': pay_invoice`.

### Matchers

| Matcher                     | Holds when                                                                                                                                                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| a string                    | The value is a string, number or boolean that equals the string ignoring case. A number or boolean is compared as its JSON text (`42` as `"42"`, `true` as `"true"`). `null`, a missing value, an object or an array never match a string. |
| `re:<pattern>`              | The same text matches the regular expression, case-insensitive and Unicode-aware. It is not anchored: use `^` and `$` for a whole-value match.                                                                                             |
| a number, boolean or `null` | The value is strictly equal (`===`). The string `"42"` does not match `42`, and a missing value does not match `null`.                                                                                                                     |
| an array                    | The value is deep-equal (canonical JSON: element order matters, object key order does not).                                                                                                                                                |
| an object                   | Every constraint in it holds. See below.                                                                                                                                                                                                   |

An object matcher may only use these keys. An empty object, or one with any other key, makes the
grader throw (`unknown matcher … (use { equals: … } for an object)`): to compare with an object, wrap
it in `equals`.

| Key        | Value                      | Holds when                                                                                                                                                                                             |
| ---------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `exists`   | boolean                    | `true`: the value is neither `null` nor missing. `false`: the same as `absent: true`.                                                                                                                  |
| `absent`   | boolean                    | `true`: the value is `null` or missing. (`false` checks nothing.)                                                                                                                                      |
| `equals`   | any value                  | The value is deep-equal (canonical JSON).                                                                                                                                                              |
| `oneOf`    | matcher[]                  | At least one of the matchers holds.                                                                                                                                                                    |
| `min`      | number or string           | The value is at least the bound. Both are compared as numbers when both are numbers or numeric strings; else, when both are strings, as text (so ISO dates compare correctly); else the matcher fails. |
| `max`      | number or string           | The value is at most the bound, compared like `min`.                                                                                                                                                   |
| `contains` | string                     | The value's text contains the string, ignoring case. A string is used as it is, `null` or missing as `""`, anything else as canonical JSON.                                                            |
| `includes` | matcher                    | The value is an array and at least one element matches.                                                                                                                                                |
| `length`   | number or `{ min?, max? }` | The value is an array or a string of exactly that length, or within the inclusive bounds.                                                                                                              |
| `all`      | matcher[]                  | Every matcher holds.                                                                                                                                                                                   |
| `any`      | matcher[]                  | At least one matcher holds.                                                                                                                                                                            |
| `not`      | matcher                    | The matcher does not hold.                                                                                                                                                                             |

The constraints are checked in the order `exists`, `absent`, `equals`, `oneOf`, `min`, `max`,
`contains`, `includes`, `length`, `all`, `any`, `not`; the first that fails gives the reason in the
assertion's message, prefixed with the path.

```ts doctest
import assert from 'node:assert/strict';

import { matchAt, matchValue } from '@agent-evals/core';

// Strings: equal ignoring case; numbers and booleans compare as their JSON text.
assert.equal(matchValue('Paid', 'paid'), null);
assert.equal(matchValue(42, '42'), null);
assert.notEqual(matchValue('42', 42), null); // a number matcher is strict
assert.notEqual(matchValue(undefined, null), null); // missing is not null
assert.equal(matchValue('RE-1007', 're:^RE-10\\d{2}$'), null);

// Object matchers.
assert.equal(matchValue('2026-06-11', { min: '2026-06-01', max: '2026-06-30' }), null);
assert.equal(matchValue('12.5', { min: 10 }), null);
assert.equal(matchValue(['a', 'B'], { includes: 'b', length: { min: 2 } }), null);
assert.equal(matchValue(undefined, { absent: true }), null);
assert.equal(matchValue({ a: 1 }, { equals: { a: 1 } }), null);
assert.equal(matchValue('open', { not: { oneOf: ['paid', 'cancelled'] } }), null);
assert.throws(() => matchValue({ a: 1 }, { a: 1 } as never), /unknown matcher/);

// Paths.
const outcome = { writes: [{ tool: 'pay_invoice', args: { number: 'RE-1007' } }] };
assert.equal(matchAt(outcome, 'writes[0].args.number', 'RE-1007'), null);
assert.equal(matchAt(outcome, 'writes.0.tool', 'pay_invoice'), null);
assert.equal(matchAt(outcome, '..number', 're:^RE-'), null);
assert.equal(matchAt(outcome, '..documentId', { absent: true }), null);
assert.equal(matchAt(outcome, '.', { contains: 'pay_invoice' }), null);
assert.equal(
  matchAt(outcome, 'writes[0].args.number', 'RE-1001'),
  'writes[0].args.number: expected "RE-1001", got "RE-1007"',
);
```

### Tool names

The `tool` and `tools` parameters of the tool graders and `writeTools` of `asks_back` are string
matchers on the tool's name: the exact name ignoring case, or `re:<pattern>`. A pattern is not
anchored: `re:invoice` also matches `list_invoices`. Write `re:^list_invoices$` for one name.

## Fact matchers

A **fact matcher** handles values written in many ways, such as amounts or dates, for the `facts`
and `forbid` graders. It has a `prefix` and a function `holds(fact, text)`. A fact that starts with the
prefix is handed to the first matcher whose prefix fits, without the prefix. `text` is the answer as
written (not normalized), the same for `facts` and `forbid`; `facts` removes the echoes of the user's
messages first.

Register fact matchers in a TypeScript configuration (`factMatchers`, see
[CLI and configuration](cli-and-config.md#configuration)) or pass them to `builtinGraders` in code:

```ts doctest
import assert from 'node:assert/strict';

import {
  builtinGraders,
  completeTranscript,
  gradeTrial,
  type FactMatcher,
} from '@agent-evals/core';

// "amount:1250" holds for 1250, 1,250.00, 1.250,00 and 1 250 in the text.
const amount: FactMatcher = {
  prefix: 'amount:',
  holds(fact, text) {
    const wanted = Number(fact);
    const numbers = text.match(/\d[\d.,\s]*\d|\d/g) ?? [];
    return numbers.some((written) => {
      const digits = written.replace(/[\s.,](?=\d{3}(\D|$))/g, '').replace(',', '.');
      return Number(digits) === wanted;
    });
  },
};

const task = {
  id: 'total',
  input: { turns: ['How much is waiting?'] },
  graders: [{ type: 'facts', facts: ['amount:1250'] }],
};
const transcript = completeTranscript([
  { type: 'message', role: 'user', text: 'How much is waiting?' },
  { type: 'message', role: 'assistant', text: 'In total 1.250,00 EUR.' },
]);
const [result] = await gradeTrial(task, transcript, null, { graders: builtinGraders([amount]) });
assert.equal(result?.passed, true);
```

## Grader ids

Each grader of a task gets an id, used in results, reports, the failure table and label files:

- the grader's `id`, when it has one;
- else its `type` for the first grader of that type without an id, `type#2` for the second,
  `type#3` for the third, and so on.

The suite's default graders come first, then the task's own, and the numbering runs over both. Ids
must be unique within a task: an explicit `id: facts` next to an unnamed `facts` grader is refused by
the loader (`<file>: task <id>: the grader id facts is used twice`) and reported by `validate`. Give
explicit ids that differ from the types.

## Scores and verdicts of one grader

For each grader that runs:

- **score**: the grader's own score when it sets one (`facts` does), else the share of passed
  assertions, 1 when there are no assertions;
- **passed**: every assertion passed and the verdict is not unknown;
- **weight**: the grader's `weight`, default 1;
- **required**: the grader's `required`, default `false`.

### Unknown verdicts

A grader can report that it could not decide (the `judge` does when a dimension is unknown). The
grader parameter `onUnknown`, read for every grader type, decides what that means:

- `fail` (the default): the grader does not pass, and its score counts with its weight;
- `ignore`: only what is unknown is set aside. A grader marks its undecided assertions with
  `unknown: true` (the `judge` marks its unknown dimensions); the other assertions decide: the grader
  passes when they all passed, its score is their share of passes, and its weight stays. When nothing
  is decided (every dimension unknown, or a grader that says `unknown` without marking an assertion),
  the grader passes and its weight becomes 0, so it drops out of the weighted mean.

So with `ignore`, a judge whose `tone` dimension is unknown and whose `facts` dimension failed still
fails.

## Scoring

The task's `scoring` (or the suite's default, or `binary`) combines the grader results into the
trial's verdict.

| `scoring.mode`     | The trial passes when                                                    |
| ------------------ | ------------------------------------------------------------------------ |
| `binary` (default) | every grader passes                                                      |
| `weighted`         | the weighted mean of the grader scores reaches `threshold`               |
| `hybrid`           | every `required` grader passes and the weighted mean reaches `threshold` |

- `threshold` is between 0 and 1 and defaults to **1**.
- The **weighted mean** is `Σ weight × score / Σ weight`, rounded to 6 decimal places. It is the
  trial's `score`, the **partial credit**, reported in every mode.
- When the weights add up to 0 (no graders, or every unknown ignored), the mean is 1 if every grader
  passed and 0 otherwise.
- `required` matters only in `hybrid` mode.
- A trial that did not complete (`agent_error`, `timeout`, `infra_error`) or was not graded has score
  0 and never passes, whatever the graders say.

```ts doctest
import assert from 'node:assert/strict';

import { scoreOf, type GraderResult } from '@agent-evals/core';

const result = (
  id: string,
  score: number,
  passed: boolean,
  weight = 1,
  required = false,
): GraderResult => ({ id, type: id, score, passed, weight, required, assertions: [] });

const results = [
  result('outcome', 1, true, 1, true),
  result('facts', 0.5, false),
  result('judge', 1, true, 2),
];

// (1 × 1 + 1 × 0.5 + 2 × 1) / 4 = 0.875
assert.deepEqual(scoreOf(results, { mode: 'binary' }), { score: 0.875, passed: false });
assert.deepEqual(scoreOf(results, { mode: 'weighted', threshold: 0.8 }), {
  score: 0.875,
  passed: true,
});
assert.deepEqual(
  scoreOf([result('outcome', 0, false, 1, true), ...results.slice(1)], {
    mode: 'hybrid',
    threshold: 0.5,
  }),
  { score: 0.625, passed: false },
); // the required grader failed
```

## Grader errors and agent errors

A failure is attributed to the part that caused it, so a broken grader or a flaky eval stack never
reads as a failing agent.

| What happened                                                                                                     | Recorded as                                                                                  | Effect                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| The agent failed (the adapter threw an ordinary error)                                                            | trial status `agent_error`, an `error` event of kind `agent`                                 | The trial fails; it counts against the agent.                                                                                                 |
| The trial ran out of time                                                                                         | status `timeout`, an `error` event of kind `timeout`                                         | The trial fails; it counts against the agent.                                                                                                 |
| A grader threw (a missing parameter, an unknown matcher key, a bug in a custom grader)                            | the grader's result has `error`, score 0, `passed: false`, no assertions                     | The grader fails with its weight. The summary counts the trial under `graderErrors`, and the failure table shows `<id>: grader error (…)`.    |
| A task names an unknown grader type                                                                               | a grader result with `error: unknown grader type <type>`                                     | As a grader error. `validate` reports it before any run.                                                                                      |
| A grader threw an error named `InfraError` (the judge could not be reached after its retries)                     | the trial keeps its status, `ungraded: true`, `gradingError` starts with `the judge failed:` | The trial is not graded and is left out of pass@k. It is not retried; the summary counts it under `gradingErrors`. `regrade` grades it again. |
| The adapter threw an `InfraError`, `beforeTrial` failed or ran past `hookTimeoutMs`, or the simulated user failed | status `infra_error` after the retries, an `error` event of kind `infra`                     | Retried (`retries`, default 2); then left out of pass@k.                                                                                      |

The trial's `grades` are computed for `agent_error` and `timeout` trials too, so you can read what
the partial transcript got right, but such a trial's score is 0.

## Ungraded trials and skipped model graders

Model graders need a judge client. A run without a judge (no `judge` in the configuration) skips
them: they produce no result and are left out of the score, and `run.json` says
`meta.modelGraders: "skipped"` (only when a task of the run has a model grader). A task with code graders and a model grader is then scored on its code
graders alone.

When **every** grader of a task is a model grader, a run without a judge grades nothing. The trial is
marked `ungraded: true`, gets score 0 and `passed: false`, and is left out of `n`, `c`, pass@k and
pass^k like an infrastructure error, so a dry run cannot pass a task it never graded. It is not a
failure either: the reports list it under "Ungraded trials", apart from the failure table, and
`summary.json` under `ungraded`.

`regrade` without a judge keeps the model graders' earlier results and appends them after the newly
graded code graders.

## Grading in code

`gradeTrial(task, transcript, outcome, options)` runs every grader of a task on one transcript and
returns the grader results; `scoreOf(results, scoring)` gives the verdict. The example grades a
transcript with code graders and a fake judge.

```ts doctest
import assert from 'node:assert/strict';

import {
  builtinGraders,
  completeTranscript,
  gradeTrial,
  scoreOf,
  scoringOf,
} from '@agent-evals/core';

const task = {
  id: 'due-date',
  input: { turns: ['When is RE-1001 due?'] },
  graders: [
    { type: 'tool_called', tool: 'get_invoice', args: { number: 'RE-1001' } },
    { type: 'facts', facts: [['2026-06-11', 'June 11'], 'RE-1001'] },
    { type: 'tool_not_called', tool: 'pay_invoice' },
    {
      type: 'judge',
      onUnknown: 'ignore',
      rubric: { name: 'friendly', question: 'Is it friendly?', pass: 'Yes.', fail: 'No.' },
    },
  ],
  scoring: { mode: 'weighted' as const, threshold: 0.7 },
};

const transcript = completeTranscript([
  { type: 'message', role: 'user', text: 'When is RE-1001 due?' },
  { type: 'tool_call', id: 'c1', name: 'get_invoice', args: { number: 'RE-1002' } },
  { type: 'message', role: 'assistant', text: 'It is due on June 11.' },
]);

// A fake judge that cannot decide.
const judge = {
  complete: async () => ({ text: '{"reason": "Hard to say.", "verdict": "unknown"}' }),
};

const results = await gradeTrial(task, transcript, null, { graders: builtinGraders(), judge });
assert.deepEqual(
  results.map(({ id, score, passed, weight }) => [id, score, passed, weight]),
  [
    ['tool_called', 0.5, false, 1], // called, but with other arguments
    ['facts', 0.5, false, 1], // the date, but not the number
    ['tool_not_called', 1, true, 1],
    ['judge', 0, true, 0], // unknown, ignored: weight 0
  ],
);
// (0.5 + 0.5 + 1) / 3 = 0.666667, below the threshold of 0.7
assert.deepEqual(scoreOf(results, scoringOf(task)), { score: 0.666667, passed: false });

// Without a judge, the model grader is skipped.
const withoutJudge = await gradeTrial(task, transcript, null, {
  graders: builtinGraders(),
  skipModelGraders: true,
});
assert.equal(withoutJudge.length, 3);
```
