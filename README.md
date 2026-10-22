# agent-evals

Evals for AI agents that you can trust: tasks as files with reference solutions, several trials per task, graders that check what the agent **did** (not only what it said), pass@k and pass^k, model judges calibrated against people, and every transcript on disk for a person to read.

The method follows Anthropic's article [Demystifying evals for AI agents](https://www.anthropic.com/research/demystifying-evals-for-ai-agents). This package is an independent implementation of it for TypeScript and Node.

> **Status:** 0.x, before the first npm release. The API may still change in minor releases ([stability policy](docs/stability.md)). Used in production by Acriva, a document management system whose AI assistant and document chat are evaluated with it.

## Why

An agent's answer can read well and still be wrong: it called the wrong tool, wrote when it should have asked, or claimed an action it never took. And an agent that passes a task once may fail it the next time. `agent-evals` is built around those two facts:

- **Grade the outcome.** An adapter reads the environment after the trial (what was written, which proposal was made), and graders check that, plus the tool calls and the facts in the answer.
- **Measure consistency.** Every task runs several trials. pass@k says whether the agent _can_ do it; pass^k says whether it does it _every time_, which is what users of a customer-facing agent experience.
- **Read the transcripts.** Every trial's complete record lands in a JSONL file, the HTML report shows all of them, and a local viewer lets you compare runs and label judge verdicts.
- **No service.** It runs on your machine or in CI, writes plain files, and has two runtime dependencies (`zod`, `yaml`).

## Install

You need Node 22.18 or later.

The package isn't on npm yet. Until it is, work from a clone of the repository:

```sh
git clone https://github.com/DavidKloster/agent-evals.git
cd agent-evals
npm install
node src/cli.ts --help
```

In a clone, `node src/cli.ts` is the CLI: use it wherever these docs say `npx agent-evals`. Once the package is published, install it in your project with `npm install --save-dev @agent-evals/core` and run `npx agent-evals`.

## Quick start

The repository ships a complete example, an invoice-desk assistant with mock tools, a regression suite and a capability suite. Check the tasks, then run them without a model (the `scripted` adapter replays each task's reference solution):

```sh
npx agent-evals validate examples/invoice-desk/regression/suite.yaml examples/invoice-desk/capability/suite.yaml
npx agent-evals run --config examples/invoice-desk/eval.replay.yaml
npx agent-evals view --root examples/invoice-desk/results
```

The run lands in `examples/invoice-desk/results/<time>/` (the config's `out`, relative to the config file): `run.json`, `summary.json`, `report.md`, a static `report.html` with every transcript, and one JSONL transcript per trial. `view` prints the address of the local viewer (by default `http://127.0.0.1:4177/`); open it to browse the runs.

With a key for an OpenAI-compatible API (OpenRouter by default), the same suites run against real models, with a judge and a simulated user:

```sh
OPENROUTER_API_KEY=… npx agent-evals run --config examples/invoice-desk/eval.config.yaml
```

## A task

A task is a small YAML file: the input, the graders, and a reference solution that passes them.

```yaml task
id: no-write-on-read-question
description: A status question; the assistant reads and must not pay (should NOT write).
tags: [lookup, balance]
input:
  turns: ['Has RE-1003 been paid?']
graders:
  - { type: tool_called, tool: get_invoice, args: { number: RE-1003 } }
  - { type: tool_not_called, tool: pay_invoice }
  - { type: outcome, expect: { writes: { length: 0 } } }
  - { type: facts, facts: ['re:\bpaid\b|\byes\b'] }
reference:
  transcript:
    - { type: message, role: user, text: 'Has RE-1003 been paid?' }
    - { type: tool_call, id: c1, name: get_invoice, args: { number: RE-1003 } }
    - { type: message, role: assistant, text: 'Yes, RE-1003 was paid on May 2, 2026.' }
  outcome: { writes: [], state: null }
```

## In code

```ts doctest
import { defineSuite, runEval, scriptedAdapter, summarize } from '@agent-evals/core';

const suite = defineSuite({
  name: 'greetings',
  kind: 'regression',
  tasks: [
    {
      id: 'greets-back',
      input: { turns: ['Hello!'] },
      graders: [{ type: 'facts', facts: ['re:\\bhello\\b|\\bhi\\b'] }],
    },
  ],
});

// A stand-in agent; replace it with an adapter for yours (docs/extending.md).
const agent = scriptedAdapter({ replies: { 'greets-back': [{ text: 'Hi there!' }] } });

const run = await runEval({
  suites: [suite],
  targets: [{ name: 'my-agent', adapter: agent }],
  trials: 3,
});
const [group] = summarize(run, { k: 3 }).groups;
console.log(`pass@1 ${group?.pass1}, pass^3 ${group?.passHatK}`);
```

`runEval` takes any number of suites and targets (models, prompts, configurations), runs the trials concurrently with a clean session each, and grades them. `writeReports(run, dir)` writes the reports.

## What's inside

| Part                 | What it does                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tasks and suites** | YAML or JSON with JSON Schemas for editors; capability and regression suites; graduation and saturation rules; `validate` proves every reference solution passes                                                                                                                                                                                                                                                                 |
| **Harness**          | Concurrent trials, a clean session per trial with setup and teardown hooks, time limits, retries for infrastructure errors only (counted apart), a simulated user for conversations                                                                                                                                                                                                                                              |
| **Graders**          | Code: tool called with argument matchers, tool not called, no placeholder arguments, no repeated calls, outcome checks, facts and forbidden statements, limits, language (German or English), formality (the German formal address), asks back. Model: rubric judges, one call per dimension, an Unknown verdict, multi-model consensus, pairwise comparison. Human: labelling sheets and calibration (agreement, Cohen's kappa) |
| **Metrics**          | pass@1, pass@k, pass^k, partial credit, p50/p90 time to first token and to reply, turns, calls, tokens, cost per task, error rates; diffs between runs                                                                                                                                                                                                                                                                           |
| **Reports**          | Markdown, JSON and a self-contained HTML report with every transcript, failure classification and annotated examples                                                                                                                                                                                                                                                                                                             |
| **Adapters**         | `openai-tools` (a chat-with-tools loop on any OpenAI-compatible API, with mock tools from the task), `http-sse` (an agent behind HTTP that streams Server-Sent Events), `scripted` (replay, for tests and dry runs), or your own                                                                                                                                                                                                 |
| **Viewer**           | `agent-evals view`: runs, side-by-side comparison, a transcript reader with filters, and labelling of judge verdicts, on `127.0.0.1`                                                                                                                                                                                                                                                                                             |

## Documentation

Start with the [documentation index](docs/README.md): concepts and architecture, the task and suite file reference, graders, metrics with their formulas, judges and calibration, the CLI and config, the transcript format, extending (adapters, graders, fact matchers), the viewer, troubleshooting, FAQ, and a comparison with other tools.

## Contributing

Contributions are welcome: graders, adapters, example tasks, docs. See [CONTRIBUTING.md](CONTRIBUTING.md); every commit is signed off ([DCO](https://developercertificate.org/)). Please follow the [code of conduct](CODE_OF_CONDUCT.md), and report security issues privately as described in [SECURITY.md](SECURITY.md).

## Licence

[Apache-2.0](LICENSE). Copyright 2026 David Kloster; see [NOTICE](NOTICE).

Anthropic and Claude are trademarks of Anthropic, PBC. This project is not affiliated with or endorsed by Anthropic.
