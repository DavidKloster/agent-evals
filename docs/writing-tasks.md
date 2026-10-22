# Writing tasks and running suites

How to write tasks that measure something, how suites move from capability to regression, and how to read the results. The file formats are in [Task and suite files](task-and-suite-files.md); the graders in [Graders](graders.md).

## What makes a good task

- **Start from real failures.** 20 to 50 tasks drawn from what went wrong (bug reports, support tickets, your own sessions with the agent) are enough to start. Then add the common tasks your users do.
- **Unambiguous.** Two experts reading a trial reach the same verdict. When the expected answer depends on taste, write down in the grader what is wanted.
- **A reference solution** that passes every grader. `agent-evals validate` checks it, so a task can't be impossible by mistake. A task that every strong model fails in every trial is suspected broken before the agent is; the report lists such tasks.
- **Balanced.** For every "should do X" add a "should not do X": should not write for a read question, should not search when the context already answers, should ask back when the request is ambiguous, should refuse what it can't do. An agent tuned on one-sided tasks overshoots.
- **Grade the outcome, not the path.** Check what the agent did to the environment and the facts it states. Don't require one exact sequence of calls when several are correct.
- **Hard to game.** An answer that repeats the question doesn't state its facts (the `facts` grader removes the user's own messages first); `forbid` catches a wrong fact stated next to the right one; `outcome` can't be talked into passing.

A complete example:

```yaml task
id: pay-ambiguous-asks-back
description: Two invoices of the vendor are open, so "the Schmidt invoice" is ambiguous; the agent asks back and pays nothing.
tags: [write, ambiguity]
input:
  turns: ['Pay the Schmidt invoice.']
graders:
  - { type: asks_back, expected: true, writeTools: [pay_invoice] }
  - { type: tool_not_called, tool: pay_invoice }
  - { type: outcome, expect: { writes: { length: 0 } } }
reference:
  transcript:
    - { type: message, role: user, text: 'Pay the Schmidt invoice.' }
    - { type: tool_call, id: c1, name: list_invoices, args: { vendor: Schmidt, status: open } }
    - {
        type: message,
        role: assistant,
        text: 'Two Schmidt invoices are open: RE-1001 (240.00 EUR) and RE-1007 (89.90 EUR). Which one should I pay?',
      }
  outcome: { writes: [], state: null }
```

## Adding a task as a pull request

Anyone who saw the agent fail can add a task: a product manager, support, a developer.

1. Copy a task of the suite (or [`templates/task-from-report.yaml`](../templates/task-from-report.yaml)) into the suite's `tasks/` folder. The first line's `# yaml-language-server: $schema=…` comment lets the editor check the file as you type.
2. Write the input, the graders and the reference solution.
3. Run `agent-evals validate <suite.yaml>`: the reference must pass.
4. Open the pull request. The suite's `owner` reviews the task for fairness: is it unambiguous, does it grade the outcome, is the data synthetic?

## From a user's report to a task

When a user reports a bad answer, turn the report into a task by hand, never by copying:

1. Name the **pattern** in one line: what the user asked, what the agent did, what it should have done.
2. **Invent the data.** Never copy a name, a number, an amount, a date, a document's text or the answer's text. Write a question of the same shape on your eval environment's synthetic data.
3. Grade the reported failure as a `required` grader, then what should happen instead.
4. Write the reference solution, run `validate`, and add a balancing task when the fix could overshoot (the report says "it wrote when it shouldn't": also keep a task where it should write).
5. Put the task in the capability suite, with `source:` naming the report's ID only.

The template [`templates/task-from-report.yaml`](../templates/task-from-report.yaml) walks through these steps, and [`from-report-status-not-pay.yaml`](../examples/invoice-desk/capability/tasks/from-report-status-not-pay.yaml) is a finished example: the pattern "asked about the status, the agent paid", rewritten on invented invoices.

## Capability and regression suites

- **Capability suites** hold what the agent can't do reliably yet. A low pass rate is expected: it is the hill to climb.
- **Regression suites** hold what it must keep doing. Aim at 100 %, and run them on every change of the prompt, the tools, the routing or the model, and before a release.
- **Graduation.** `agent-evals graduate <older run> <newer run>` lists the capability tasks that passed every trial of every target in the last runs (each suite's `graduation` rule, else k 3 and 2 runs; `--k` and `--runs` override it). Moving a task to the regression suite is a pull request.
- **Saturation.** A capability suite whose pass@1 reaches its `saturation.threshold` (default 0.9) gives little signal any more. The report says so: add harder tasks.

## Running

- **Several trials.** Three per task is a sensible default; pass^3 is then the consistency number. More trials narrow the estimate for the tasks that matter most.
- **A clean state per trial.** Each trial starts a new session. If the agent writes to a real environment, reset it in `hooks.beforeTrial` or `hooks.afterTrial` (re-seed, undo the write). See [Extending](extending.md#hooks).
- **Never a real model in CI.** Run the suites with the `scripted` adapter in CI (a dry run: references replayed, `userSimulator: reference`), and against real models on demand, before a release, and on every change of a prompt, a tool description, the routing or the model.
- **Compare runs.** `agent-evals diff <before> <after>` lists regressions (pass^k fell from 1, or pass@1 dropped by at least `minDrop`, 0.34 by default) and improvements per task; `run --baseline <run>` puts the diff in the report.

## Reading transcripts

Scores mean nothing until someone has read transcripts. For every failure, decide whether the agent made the mistake or the task or grader was unfair, and fix an unfair task or grader before trusting the score. `agent-evals regrade <run> --config <file>` applies the fixed graders to the stored transcripts without calling the agent again.

Write what you found in the run folder's `reviews.yaml`:

```yaml
- taskId: pay-ambiguous-asks-back
  target: model-a
  class: grader
  annotation: The question came first and the options after it; the grader only looked at the last paragraph. Fixed.
- taskId: no-write-on-read-question
  target: model-a
  trial: 0
  class: agent
  annotation: Answered an English question in German.
```

`class` is `agent`, `grader`, `task` or `infra`. `agent-evals report <run>` counts the classes and shows the annotated failures first among its examples. The [viewer](viewer.md) makes the reading faster: filter to failed trials, step through them, and compare a task's trials across two runs.

## Ownership

Treat the suites like unit tests. Each suite names its `owner`, who reviews new tasks and keeps the graders fair. A failing regression task is a bug; a saturated capability suite needs harder tasks.
