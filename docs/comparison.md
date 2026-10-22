# Comparison with other tools

Many tools evaluate language models and agents. This page says, as fairly as we can, what some
well-known ones are good at, when to choose them instead of this package, and where this package
differs. It describes them **as of 2026**, in general terms. Tools change fast; check their own
documentation before you decide. If something here is wrong or out of date, please open an issue or a
pull request.

## What this package is

`@agent-evals/core` is a small TypeScript library and CLI for evaluating AI agents, built on the
method of
[Demystifying evals for AI agents](https://www.anthropic.com/research/demystifying-evals-for-ai-agents).
Its choices:

- **Tasks as files with reference solutions.** A task is a YAML or JSON file: the input, the graders,
  the scoring and a reference solution that passes every grader. `validate` checks the reference in
  CI, so an impossible task or an unfair grader shows up before any agent is blamed.
- **Outcome grading.** The adapter reads the final state of the environment after a trial, and the
  graders check it, next to what the agent said. They don't require one exact path.
- **pass^k as a headline.** Several trials per task, pass@1, pass@k and pass^k side by side;
  infrastructure errors retried and kept out of the numbers.
- **Transcripts as files.** Every trial's complete record is a JSONL file. A run is a folder:
  `run.json`, Markdown and HTML reports, transcripts.
- **Judges calibrated against people.** One isolated call per rubric dimension, an "unknown" verdict,
  consensus of several judges, pairwise comparison in both orders, and agreement and Cohen's kappa
  against human labels.
- **A simulated user** for conversational tasks.
- **Local first, no service.** No server, no database, no account. A local viewer on 127.0.0.1.
  Two dependencies (`zod`, `yaml`).

What it does **not** do: it has no sandbox or container runner for the agent, no production tracing
or monitoring, no hosted dashboard or team workspace, no dataset management, no red-teaming attack
library, and no Python API. Its built-in model client speaks the OpenAI-compatible chat API only;
other providers need a small client of your own.

## Other tools

### OpenAI Evals

An open-source framework and registry of evals from OpenAI, with evals defined as data plus Python
classes, aimed mainly at grading model outputs. OpenAI also offers evaluation features in its hosted
platform.

Choose it when you evaluate models (rather than a whole agent with tools and state), want to reuse
its registry of evals, or work mainly inside OpenAI's platform.

### promptfoo

An open-source CLI and library for testing prompts, models and LLM applications, configured in YAML,
with many providers, a large catalogue of assertions (including model-graded ones), a local web
viewer, CI integration and red-teaming features.

Choose it when you compare prompts and providers on many test cases, want a rich set of ready-made
assertions, or need red-teaming and security scans. It is the closer neighbour in spirit (config
files, CLI, local); this package puts more weight on multi-turn agents, outcomes read from the
environment, reference solutions and pass^k.

### Inspect AI (UK AI Security Institute)

An open-source Python framework for evaluations, with tasks, solvers and scorers, support for agents
and tool use in sandboxes (for example Docker), a log viewer, and a growing collection of published
evals and benchmarks. It is widely used for capability and safety evaluations.

Choose it when you work in Python, need agents to act in isolated sandboxes, want to run or extend
established benchmarks, or need its scale and ecosystem. It covers much more ground than this package.

### Braintrust and autoevals

Braintrust is a hosted platform for evaluations, experiments, datasets and production logging, with
SDKs for TypeScript and Python. autoevals is its open-source library of scorers (model-graded and
heuristic) that can be used on its own.

Choose Braintrust when a team wants a shared hosted UI, experiment tracking over time and production
logs next to evals. Use autoevals when you want ready-made scorers in your own code; such a scorer
can also be wrapped as a grader of this package.

### LangSmith

LangChain's hosted platform for tracing, datasets, evaluation and monitoring of LLM applications. It
fits most naturally with LangChain and LangGraph, and has SDKs for other code too.

Choose it when your agent is built with LangChain or LangGraph, or when you want tracing of
production traffic and evaluations in one service.

### Langfuse

An open-source, self-hostable LLM engineering platform: tracing, prompt management, datasets,
evaluations and scores, with a hosted option.

Choose it when you need observability of a production agent and want evaluations on the same traces,
especially if you want to host it yourself.

### DeepEval

An open-source Python framework for evaluating LLM applications in a unit-test style, with many
ready-made metrics (model-graded and others, including RAG and conversational metrics). Its makers
offer a hosted platform as well.

Choose it when you work in Python, like tests in the style of pytest, and want ready-made metrics for
common application types.

### Harbor and Terminal-Bench

Terminal-Bench is a benchmark for agents that work in a terminal: each task has its own container
environment, instructions, tests that check the result and a reference solution. Harbor is a
framework from the same community for running agents on such containerized tasks at scale.

Choose them when you benchmark coding or terminal agents, need each trial in a fresh container, or
want to compare your agent on a public benchmark. The task design (an environment, a check of the
final state, a reference solution) is close to this package's; the difference is that this package
leaves the environment to your adapter and hooks instead of running containers.

## How to choose

| If you need …                                                                         | Look at                         |
| ------------------------------------------------------------------------------------- | ------------------------------- |
| tasks in your repository, graded on outcomes, run locally and in CI, in TypeScript    | this package                    |
| prompt and provider comparisons on many cases, a big assertion catalogue, red teaming | promptfoo                       |
| Python, sandboxed agent evals, established benchmarks                                 | Inspect AI                      |
| a hosted team workspace with experiments and production logs                          | Braintrust, LangSmith, Langfuse |
| self-hosted tracing with evaluations                                                  | Langfuse                        |
| unit-test-style metrics in Python                                                     | DeepEval                        |
| containerized terminal or coding tasks                                                | Harbor and Terminal-Bench       |
| model-level evals in OpenAI's ecosystem                                               | OpenAI Evals                    |

The tools combine well. A common setup keeps tasks and regression gates in the repository (this
package or promptfoo), traces production in an observability platform, and turns real failures from
the traces into new tasks.
