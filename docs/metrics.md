# Metrics

This page gives every number the package reports, with the formula as the code computes it today.
The formulas live in `src/metrics/stats.ts` (pass@k, pass^k, the summary), `src/graders/grade.ts`
(partial credit), `src/core/transcript.ts` (latency and cost per trial), `src/metrics/lifecycle.ts`
(saturation and graduation), `src/metrics/diff.ts` (comparing runs) and
`src/metrics/calibration.ts` (judge calibration).

`summarize(run, { k })` computes the numbers of a run. `k` defaults to 3. It returns:

- `tasks`: one `TaskSummary` per suite, target and task;
- `groups`: one `GroupSummary` per suite and target (a row of the report's comparison table);
- `brokenTaskSuspects`: tasks that no target passed;
- `k`.

## Which trials count

A trial is **graded** when its status is not `infra_error` and it is not `ungraded` (see
[Architecture](architecture.md#statuses)). Only graded trials enter pass@1, pass@k, pass^k, partial
credit, latency and cost.

- An infrastructure error says nothing about the agent. Counting it as a failure would make a flaky
  eval stack look like a failing agent.
- An ungraded trial had no grader run (every grader is a model grader and the run had no judge).
  Counting it as a pass or a failure would invent a verdict.

`agent_error` and `timeout` trials **are** graded. They never pass, and their score is 0.

For one task and one target:

- `trials`: every trial, the infrastructure errors included;
- `n`: the graded trials;
- `c`: the graded trials that passed.

## pass@1, pass@k and pass^k

For one task with `n` graded trials, `c` of them passed:

| Metric | Meaning                                         | Formula                   | Code                |
| ------ | ----------------------------------------------- | ------------------------- | ------------------- |
| pass@1 | the share of trials that pass                   | `c / n`                   | `TaskSummary.pass1` |
| pass@k | the chance that at least one of k trials passes | `1 − C(n−c, k) / C(n, k)` | `passAtK(n, c, k)`  |
| pass^k | the chance that all k trials pass               | `C(c, k) / C(n, k)`       | `passHatK(n, c, k)` |

`C(a, b)` is the binomial coefficient. Both pass@k and pass^k draw k of the n trials without
replacement. pass@k is the unbiased estimator of Chen et al. (2021). pass^k is the consistency
metric: the headline number for an agent that a customer talks to, who expects it to work every
time.

### Product forms

Binomials of large numbers overflow, so the code computes products instead.

pass@k:

```text
C(n−c, k) / C(n, k)  =  Π_{i = n−c+1 .. n} (1 − k / i)
passAtK  =  1 − Π_{i = n−c+1 .. n} (1 − k / i)
```

Why they are equal: `C(n−c, k) / C(n, k) = [(n−c)! (n−k)!] / [n! (n−c−k)!]`. Write it as
`Π_{i=n−c+1..n} (i − k) / i`: the numerator `Π (i − k)` over `i = n−c+1 .. n` is
`(n−c−k+1) ⋯ (n−k) = (n−k)! / (n−c−k)!`, and the denominator `Π i` is `n! / (n−c)!`. And
`(i − k) / i = 1 − k / i`.

pass^k:

```text
C(c, k) / C(n, k)  =  Π_{i = 0 .. k−1} (c − i) / (n − i)
```

Both are `[c! / (c−k)!] / [n! / (n−k)!]`, since the `k!` of both binomials cancels.

### Edge cases

- `n < k`: both return `null`. There are not enough trials to draw k.
- `n − c < k`: pass@k is exactly 1. Any k trials include a pass.
- `c < k`: pass^k is exactly 0. There are not k passes to draw.
- `k = 1`: both equal `c / n`.
- `n`, `c` and `k` must be integers, `k ≥ 1` and `0 ≤ c ≤ n`. Anything else throws.
- pass@1 is `null` when `n = 0`: every trial was lost to the infrastructure.

Some values, computed by the code and checked against the binomial form:

| n   | c   | k   | pass@k | pass^k   |
| --- | --- | --- | ------ | -------- |
| 5   | 3   | 2   | 0.9    | 0.3      |
| 10  | 6   | 3   | 0.9667 | 0.1667   |
| 4   | 3   | 3   | 1      | 0.25     |
| 3   | 1   | 3   | 1      | 0        |
| 2   | 2   | 3   | null   | null     |
| 20  | 7   | 5   | 0.9170 | 0.001354 |

```ts doctest
import { passAtK, passHatK } from '@agent-evals/core';

const binomial = (n: number, k: number) => {
  if (k < 0 || k > n) return 0;
  let value = 1;
  for (let i = 0; i < k; i++) value = (value * (n - i)) / (i + 1);
  return value;
};
const near = (a: number | null, b: number) => a !== null && Math.abs(a - b) < 1e-12;

for (const [n, c, k] of [
  [5, 3, 2],
  [10, 6, 3],
  [4, 3, 3],
  [20, 7, 5],
] as const) {
  if (!near(passAtK(n, c, k), 1 - binomial(n - c, k) / binomial(n, k))) throw new Error('pass@k');
  if (!near(passHatK(n, c, k), binomial(c, k) / binomial(n, k))) throw new Error('pass^k');
}
if (passAtK(2, 2, 3) !== null || passHatK(2, 2, 3) !== null) throw new Error('n < k');
```

### Over the tasks of a suite

A `GroupSummary` (one suite, one target) averages the tasks. Each task weighs the same, however many
trials it has.

- `pass1`: the mean of the tasks' pass@1, over the tasks with at least one graded trial.
- `passAtK` and `passHatK`: the mean over the tasks with **at least k graded trials**. A task with
  fewer has `null` and is left out.
- `tasksBelowK`: the number of tasks left out of pass@k and pass^k, so `tasks − tasks with n ≥ k`.
  The report says so under the table.
- `graded`: the graded trials, summed over the tasks.

So a group's pass@k and pass^k can rest on fewer tasks than its pass@1. Check `tasksBelowK` before
comparing two groups.

## Partial credit

`scoreOf(results, scoring)` in `src/graders/grade.ts` turns the grader results of one trial into a
score and a verdict.

### A grader's score

Each grader returns assertions. Its **score** is the score it gives itself, when it gives one.
Otherwise it is the share of assertions that passed, or 1 when it has no assertion. The `facts`
grader, for example, gives the share of facts found.

A grader **passes** when every assertion passed and its verdict is not unknown. Its score does not
decide that. A `facts` grader that found 2 of 3 facts has score 0.667 and fails.

A grader that is unknown (a judge said "unknown") and has `onUnknown: ignore` is graded on its
decided assertions only. When nothing was decided, it passes and gets weight 0, so it leaves the
score untouched.

### The trial's score

With `w` the grader's `weight` (default 1) and `s` its score:

```text
score = Σ w·s / Σ w            when Σ w > 0
score = 1 if every grader passed, else 0      when Σ w = 0
```

The score is rounded to 6 decimals. A grader with an `error` (it threw, or its type is unknown) has
score 0.

The verdict depends on `scoring.mode` (the task's, else the suite's `defaults.scoring`, else
`binary`). `threshold` defaults to 1.

| Mode       | The trial passes when                                                 |
| ---------- | --------------------------------------------------------------------- |
| `binary`   | every grader passed (the score is reported but does not decide)       |
| `weighted` | `score ≥ threshold`                                                   |
| `hybrid`   | every grader with `required: true` passed **and** `score ≥ threshold` |

Then the harness overrides both for a trial that is not `completed` or is ungraded: score 0, not
passed.

Examples, with grader results written as (weight, score, passed):

| Graders                               | Mode                    | Score | Passed |
| ------------------------------------- | ----------------------- | ----- | ------ |
| (1, 1, yes), (2, 0.5, no), (1, 0, no) | binary                  | 0.5   | no     |
| (1, 1, yes), (3, 0.5, no)             | weighted, threshold 0.6 | 0.625 | yes    |
| (1, 1, yes, required), (3, 0.5, no)   | hybrid, threshold 0.6   | 0.625 | yes    |
| (0, 0, yes), (0, 0, yes)              | binary                  | 1     | yes    |
| (0, 0, yes), (0, 0, no)               | binary                  | 0     | no     |

Two consequences to know:

- `scoreOf([])` is `{ score: 1, passed: true }`. So the loader refuses a task left without any grader
  (its own or the suite's defaults), and `validateSuite` reports one in a suite built by hand. See
  [Troubleshooting](troubleshooting.md#graders-the-task-has-no-grader-and-the-suite-no-default-graders).
- In `binary` mode, the weights only change the reported score, never the verdict.

### Over trials and tasks

- `TaskSummary.score`: the mean trial score over the task's graded trials.
- `GroupSummary.score`: the mean of the tasks' scores.

## Latency

`metricsOf(transcript, startedAt, endedAt)` reads the trial's transcript. A **turn** starts at a user
`message` event and ends at the next assistant `message` event.

- **Time to reply** (`replyMs`): the assistant message's `at` minus the user message's `at`.
- **Time to first token** (`ttftMs`): the first of these, minus the user message's `at`:
  1. the assistant message's `firstTokenAt`;
  2. the `firstTokenAt` of the first `model_call` event in the turn that has one;
  3. the assistant message's `at` (then TTFT equals the reply time).

The harness writes both message events itself: the user message just before `session.send`, the
assistant message when `send` returns. So `at` is the harness's clock. `firstTokenAt` of the message
comes from the `AgentReply` the adapter returns. `firstTokenAt` of a model call comes from the
adapter's `model_call` event.

A trial also has `durationMs`: the end minus the start of its last attempt. The start is taken after `beforeTrial`; `close` and `afterTrial` run after the end is taken.

The group's latency numbers are **percentiles over every turn of every graded trial** of the group,
pooled, not averaged per task. `p50` and `p90` use the **nearest rank**:

```text
sorted = the values in ascending order, N = their count
rank   = max(1, ceil(p / 100 × N))
value  = sorted[rank − 1]
```

The result is always one of the values. No values give `null`. For the ten values 100, 200, …,
1000, p50 is 500 and p90 is 900. For one value, every percentile is that value.

Example. A trial with three turns:

| Turn | User message `at` | Events in the turn                                                | Assistant `at` | TTFT | Reply |
| ---- | ----------------- | ----------------------------------------------------------------- | -------------- | ---- | ----- |
| 1    | 1000              | model call with `firstTokenAt` 1300, tool call, model call (1800) | 2100           | 300  | 1100  |
| 2    | 3000              | none; the assistant message has `firstTokenAt` 3200               | 3500           | 200  | 500   |
| 3    | 4000              | none, and no `firstTokenAt`                                       | 4400           | 400  | 400   |

## Cost and effort

Per trial, from the transcript:

| Field          | What it counts                                                              |
| -------------- | --------------------------------------------------------------------------- |
| `turns`        | user messages                                                               |
| `modelCalls`   | `model_call` events, failed calls included                                  |
| `toolCalls`    | `tool_call` events                                                          |
| `inputTokens`  | the sum of `inputTokens` of the model calls (a missing value counts as 0)   |
| `outputTokens` | the sum of `outputTokens`                                                   |
| `costUsd`      | the sum of `costUsd`, rounded to 8 decimals                                 |
| `costComplete` | true when every model call has a `costUsd`; else `costUsd` is a lower bound |

The cost is what the provider's usage says. The package has no price list. The `openai-tools`
adapter asks OpenRouter for the cost (`usage: { include: true }`); other providers may report none.

Per group, `perTask` holds the **mean per graded trial** of each field: turns, model calls, tool
calls, tokens and USD. `costComplete` is true when every graded trial's cost is complete. The report
then prints the cost as `$0.0123`, else as `≥$0.0123`.

## Error rates

The denominators differ from pass@k: error rates divide by **attempts**, the retries after
infrastructure errors included (`attempts`, the sum of `TrialResult.attempts`).

| Field                       | Numerator                                                    | Denominator  |
| --------------------------- | ------------------------------------------------------------ | ------------ |
| `rates.agentError`          | trials whose final status is `agent_error`                   | attempts     |
| `rates.timeout`             | trials whose final status is `timeout`                       | attempts     |
| `rates.infraError`          | infrastructure errors (`infraErrors` of every trial, summed) | attempts     |
| `infraErrorRate` (per task) | the task's infrastructure errors                             | its attempts |
| `graderErrors`              | trials in which at least one grader has an `error` (a count) | none         |
| `gradingErrors`             | trials whose grading failed (`gradingError`, a count)        | none         |
| `gradingErrorRate`          | `gradingErrors`                                              | trials       |

Grading errors are counted apart from the attempts: a judge whose provider failed after its retries
leaves the attempt as it was (one attempt, no infrastructure error) and marks the trial ungraded with
`gradingError`. Such a trial is left out of n and c like an infrastructure error. `graderErrors` is a
different thing: a grader that threw for its own reason (a wrong parameter) fails, and the trial is
graded.

With no attempt at all, every rate is 0.

## Broken task suspects

`brokenTaskSuspects` lists the tasks that **no target passed** in at least k graded trials: for each
suite and task, `Σ c = 0` and `Σ n ≥ k` over all targets. A task every strong agent fails is often a
broken task (an impossible request, an unfair grader) before it is a weak agent. Read its transcripts
first.

## Saturation

`saturation(run, summary)` in `src/metrics/lifecycle.ts` checks each **capability** suite per target:

```text
saturated = pass@1 of the group ≥ threshold
```

`threshold` is the suite's `saturation.threshold`, default 0.9. A saturated capability suite gives no
signal any more: add harder tasks. Regression suites are never reported as saturated; they are meant
to pass.

## Graduation

`graduationCandidates(history, { k?, runs? })` takes runs, oldest first. A **capability** task is a
candidate for the regression suite when, in each of the **last `runs` runs that ran it**, every
target that ran it has pass^k = 1. `k` and `runs` come from each suite's `graduation` rule (the run
records it in `run.json`; the newest run that has the suite wins), else 3 and 2. Given in the
options (the CLI's `--k` and `--runs`), they apply to every suite instead.

- A target whose trials were all infrastructure errors (n = 0) did not run the task in that run.
- A target with fewer than k graded trials has pass^k `null`, which is not 1: no candidate.
- A task that ran in fewer than `runs` runs is no candidate.
- `targets` lists the targets of the last of those runs.

Moving a candidate to the regression suite is a change you make by hand.

## Comparing two runs

`diffRuns(before, after, { k = 3, minDrop = 0.34 })` in `src/metrics/diff.ts` compares two runs task by
task, per suite and target. Each task gets one kind:

| Kind           | When                                                                         |
| -------------- | ---------------------------------------------------------------------------- |
| `new`          | the task (for this suite and target) is only in `after`                      |
| `removed`      | it is only in `before`                                                       |
| `incomparable` | either side has pass@1 `null` (all its trials were infrastructure errors)    |
| `regression`   | pass^k was 1 and is now below 1, **or** pass@1 changed by `−minDrop` or less |
| `improvement`  | pass^k was below 1 and is now 1, **or** pass@1 changed by `+minDrop` or more |
| `unchanged`    | anything else                                                                |

The rules are checked in this order, so a regression wins over an improvement. The pass^k rules apply
only when both sides have a pass^k (n ≥ k on both sides). The pass@1 comparison allows `1e−9` for
floating point.

`minDrop` defaults to 0.34: a change of **more than one trial in three**. With 3 trials per task:

| Before | After | Kind        | Why                                  |
| ------ | ----- | ----------- | ------------------------------------ |
| 3/3    | 2/3   | regression  | pass^3 fell from 1 to 0              |
| 2/3    | 1/3   | unchanged   | pass@1 fell by 0.333, less than 0.34 |
| 3/3    | 1/3   | regression  | pass^3 fell from 1                   |
| 2/3    | 3/3   | improvement | pass^3 rose to 1                     |
| 1/3    | 2/3   | unchanged   | pass@1 rose by 0.333                 |

With `minDrop: 1/3`, the 2/3 → 1/3 case becomes a regression. With 10 trials: 8/10 → 5/10 (−0.3) is
unchanged, 8/10 → 4/10 (−0.4) is a regression.

`tasks` is sorted: regressions, improvements, new, removed, incomparable, unchanged. `regressions` and
`improvements` count them. `groups` holds, per suite and target, the change (`after − before`) of
pass@1, pass^k, the mean USD per trial and the reply time p50.

## Calibration

`calibrate(run, labels)` in `src/metrics/calibration.ts` compares a model judge with human labels,
per judge grader and rubric dimension. A label names a trial (suite, task, target, trial number), the
judge grader's `id`, the dimension and the person's verdict: `pass`, `fail` or `unknown`.

For one grader and dimension, the code first pairs each label with the judge's verdict on that trial.
A label whose trial, grader or dimension is not in the run gets `judge: null`: it stays in `sample`
but counts nowhere.

| Field          | Formula                                                                           |
| -------------- | --------------------------------------------------------------------------------- |
| `n`            | pairs where the person decided (`pass` or `fail`)                                 |
| `agreement`    | pairs among the `n` where the judge's verdict equals the person's, divided by `n` |
| `unknownRate`  | pairs among the `n` where the judge said `unknown`, divided by `n`                |
| `kappa`        | Cohen's kappa over the pairs where **both** decided (see below)                   |
| `humanUnknown` | pairs where the person left `unknown`; not in `n`, `agreement` or `kappa`         |
| `confusion`    | the count of every (judge, human) combination, unknowns included                  |

A judge's `unknown` against a person's decision counts in `n` and as a disagreement. Fractions are
rounded to 6 decimals; with `n = 0` they are `null`.

### Cohen's kappa

Over the `m` pairs where judge and person both said `pass` or `fail`:

```text
p_o = (pairs that agree) / m
p_j = (pairs where the judge said pass) / m
p_h = (pairs where the person said pass) / m
p_e = p_j · p_h + (1 − p_j) · (1 − p_h)
κ   = (p_o − p_e) / (1 − p_e)
```

κ is `null` when `m = 0`, and when `p_e = 1` (both said only pass, or both only fail: chance alone
explains the agreement). It is rounded to 6 decimals.

Example: 10 pairs, judge and person both pass on 6, both fail on 2, and they disagree once each way.
`p_o = 0.8`, `p_j = p_h = 0.7`, `p_e = 0.49 + 0.09 = 0.58`, `κ = 0.22 / 0.42 = 0.52381`.

A second example with unknowns: seven labels on one dimension, where (judge, person) are (pass, pass)
twice, (pass, fail), (fail, fail) twice, (unknown, pass) and (pass, unknown). Then `n = 6` (the
person's unknown is left out), `agreement = 4/6 = 0.666667`, `unknownRate = 1/6 = 0.166667`,
`humanUnknown = 1`. Kappa uses the five pairs without any unknown: `p_o = 0.8`, `p_j = 0.6`,
`p_h = 0.4`, `p_e = 0.48`, `κ = 0.615385`.

How to read kappa and how many labels to collect: see
[Judges and calibration](judges-and-calibration.md#interpreting-kappa).

## A worked example

One capability suite with four tasks, one target, 4 trials per task, `k = 3`, no retries. Each task
has one `facts` grader with two facts, `yes` and `42`.

| Task     | What the trials do                                       | n   | c   | pass@1 | pass@3 | pass^3 | Score |
| -------- | -------------------------------------------------------- | --- | --- | ------ | ------ | ------ | ----- |
| `always` | all 4 say "yes, 42"                                      | 4   | 4   | 1      | 1      | 1      | 1     |
| `mostly` | 3 say "yes, 42", 1 says only "yes" (half the facts)      | 4   | 3   | 0.75   | 1      | 0.25   | 0.875 |
| `flaky`  | 2 infrastructure errors, then one "yes, 42" and one "no" | 2   | 1   | 0.5    | null   | null   | 0.5   |
| `never`  | all 4 say "no"                                           | 4   | 0   | 0      | 0      | 0      | 0     |

The task numbers:

- `mostly`: pass@3 is 1 because only one trial failed (`n − c = 1 < 3`). pass^3 is
  `C(3,3) / C(4,3) = 1/4`. Its score is `(1 + 1 + 1 + 0.5) / 4 = 0.875`.
- `flaky`: 2 graded trials are fewer than k = 3, so pass@3 and pass^3 are `null`.

The group (suite × target):

- pass@1 = `(1 + 0.75 + 0.5 + 0) / 4 = 0.5625`;
- pass@3 = `(1 + 1 + 0) / 3 = 0.6667`, over the three tasks with n ≥ 3;
- pass^3 = `(1 + 0.25 + 0) / 3 = 0.4167`;
- `tasksBelowK` = 1;
- score = `(1 + 0.875 + 0.5 + 0) / 4 = 0.59375`;
- infrastructure error rate = 2 errors / 16 attempts = 0.125;
- `brokenTaskSuspects` lists `never`: 4 graded trials, no pass.

This module runs that example and checks every number:

```ts doctest
import {
  defineSuite,
  runEval,
  scriptedAdapter,
  summarize,
  type ScriptedTurn,
  type TrialContext,
} from '@agent-evals/core';

const task = (id: string) => ({
  id,
  input: { turns: ['What is the answer?'] },
  graders: [{ type: 'facts', facts: ['yes', '42'] }],
});
const suite = defineSuite({
  name: 'demo',
  kind: 'capability',
  tasks: ['always', 'mostly', 'flaky', 'never'].map(task),
});

const good: ScriptedTurn = { text: 'yes, 42' };
const replies: Record<string, (context: TrialContext) => ScriptedTurn> = {
  always: () => good,
  mostly: (context) => (context.trial < 3 ? good : { text: 'yes' }),
  flaky: (context) =>
    context.trial < 2 ? { text: '', fail: 'infra' } : context.trial === 2 ? good : { text: 'no' },
  never: () => ({ text: 'no' }),
};

const run = await runEval({
  suites: [suite],
  targets: [{ name: 'scripted', adapter: scriptedAdapter({ replies }) }],
  trials: 4,
  retries: 0,
});
const summary = summarize(run, { k: 3 });

const check = (what: string, actual: number | null, expected: number | null) => {
  const ok =
    actual === expected ||
    (actual !== null && expected !== null && Math.abs(actual - expected) < 1e-9);
  if (!ok) throw new Error(`${what}: expected ${expected}, got ${actual}`);
};
const byId = new Map(summary.tasks.map((t) => [t.taskId, t]));
check('mostly pass^3', byId.get('mostly')!.passHatK, 0.25);
check('mostly score', byId.get('mostly')!.score, 0.875);
check('flaky n', byId.get('flaky')!.n, 2);
check('flaky pass@3', byId.get('flaky')!.passAtK, null);

const group = summary.groups[0]!;
check('pass@1', group.pass1, 0.5625);
check('pass@3', group.passAtK, 2 / 3);
check('pass^3', group.passHatK, 1.25 / 3);
check('tasks below k', group.tasksBelowK, 1);
check('score', group.score, 0.59375);
check('infra error rate', group.rates.infraError, 2 / 16);
if (summary.brokenTaskSuspects.map((s) => s.taskId).join() !== 'never')
  throw new Error('expected never to be a broken task suspect');
```
