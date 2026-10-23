---
name: agent-evals
description: Use when adding evals to an AI agent or LLM app, eval-testing or regression-testing a prompt, model, tool or agent change, measuring pass@k or pass^k, or running and reading agent-evals (@agent-evals/core) suites, reports and transcripts.
---

# agent-evals

Evals for a tool-using agent with `@agent-evals/core`: tasks as YAML files with a reference solution, several trials per task, graders that check what the agent **did**, and pass@k / pass^k. The docs live in the repository: [documentation index](https://github.com/DavidKloster/agent-evals/blob/main/docs/README.md).

## The CLI

Run it as `npx @agent-evals/core <command>`; in a project that has the package as a devDependency, `npx agent-evals <command>` is the same. `npx @agent-evals/core help` prints every command and option.

Before the first npm release, link a checkout: in a clone of `DavidKloster/agent-evals` run `npm install`, `npm run build` and `npm link`, then `npm link @agent-evals/core` in your project.

## Setting up

1. **Layout.** Copy the shape of the [invoice-desk example](https://github.com/DavidKloster/agent-evals/tree/main/examples/invoice-desk): `evals/eval.config.yaml`, `evals/tools.yaml` (mock tools and system prompt), `evals/regression/suite.yaml` and `evals/capability/suite.yaml`, each with a `tasks/` folder. Formats: [Task and suite files](https://github.com/DavidKloster/agent-evals/blob/main/docs/task-and-suite-files.md).
2. **Target.** Pick how the run reaches the agent: `openai-tools` (a model with the mock tools), `http-sse` (your agent behind HTTP), `command` (your agent as a process, in any language: [Evaluating a Python agent](https://github.com/DavidKloster/agent-evals/blob/main/docs/python-agents.md)), `scripted` (replays, no model), or your own adapter in a `.ts` config ([Extending](https://github.com/DavidKloster/agent-evals/blob/main/docs/extending.md)).
3. **Tasks.** Start with 20 to 50 tasks from real failures, each balanced by its opposite (should write / should not write). To write one, use the `write-eval-task` skill.
4. **Validate.** `npx @agent-evals/core validate evals/regression/suite.yaml evals/capability/suite.yaml` must print `OK` for every suite: each reference solution passes its graders.
5. **Dry run in CI.** A second config replays the references, with no model and no key:

   ```yaml config
   suites: [regression/suite.yaml, capability/suite.yaml]
   targets:
     - { name: reference, adapter: scripted, options: { replayReference: true } }
   userSimulator: reference
   trials: 3
   out: results
   ```

6. **Real runs** on demand (a prompt, tool, routing or model change, a release): `npx @agent-evals/core run --config evals/eval.config.yaml` with the key in `OPENROUTER_API_KEY` (or the variable `apiKeyEnv` names). Keys: [CLI and config](https://github.com/DavidKloster/agent-evals/blob/main/docs/cli-and-config.md).

## Picking graders

Grade the outcome first, then the tool calls, then the answer's facts; a judge only for what code can't check.

| Question                              | Grader                                                           |
| ------------------------------------- | ---------------------------------------------------------------- |
| What did it change?                   | `outcome`                                                        |
| Right tool, right arguments? Or none? | `tool_called`, `tool_not_called`                                 |
| Does the answer state the facts?      | `facts` (partial credit), `forbid` for wrong ones                |
| Should it ask back first?             | `asks_back`                                                      |
| Language and form of address          | `language`, `formality`                                          |
| Hygiene, as suite defaults            | `no_error`, `no_placeholder_args`, `no_repeated_calls`, `limits` |
| Tone, helpfulness, a rubric           | `judge` (needs `judge` in the config)                            |

Parameters and the matcher language: [Graders](https://github.com/DavidKloster/agent-evals/blob/main/docs/graders.md). Calibrate a judge against people with `label` and `calibrate` before trusting it: [Judges and calibration](https://github.com/DavidKloster/agent-evals/blob/main/docs/judges-and-calibration.md).

## Reading a run

A run folder holds `run.json`, `summary.json`, `report.md`, `report.html` and one JSONL transcript per trial.

- **pass@1**: the share of trials that passed. **pass@k**: it _can_ do the task in k tries. **pass^k**: it does it _every_ time, what users feel. **Partial credit**: the trial's score, the weighted mean of its graders. Formulas: [Metrics](https://github.com/DavidKloster/agent-evals/blob/main/docs/metrics.md).
- Read the failing transcripts before trusting a number: `npx @agent-evals/core view --root evals/results` ([Viewer](https://github.com/DavidKloster/agent-evals/blob/main/docs/viewer.md)). Classify each failure in the run's `reviews.yaml` as `agent`, `grader`, `task` or `infra`; after fixing an unfair grader, `regrade <run> --config <file>` grades the stored transcripts again.
- Compare: `diff <before> <after>`, or `run --baseline <run>` for the diff in the report.
- Gate CI on `run --fail-under 0.9` or `diff --fail-on-regression`.
- Promote: `graduate <older run> <newer run>` lists capability tasks that passed every trial; moving one to the regression suite is a pull request.

## Common mistakes

- **A real model in CI.** CI runs the scripted dry run; real models run on demand.
- **One trial.** Three per task, so pass^3 shows the flaky tasks.
- **Grading the path.** Several call orders can be right; grade the outcome and the facts.
- **Real user data in a task.** Invent the data; keep only the pattern.
