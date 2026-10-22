# FAQ

## Method

### Why pass^k, and not only the pass rate?

pass@1 says how often a single trial passes. pass^k says how likely it is that **all** of k trials
pass. For an agent that people talk to, the second matters: a user who asks the same thing three
times expects the right answer three times. An agent with pass@1 = 0.75 has pass^3 of about 0.42 if
its trials are independent (`0.75³`). The package computes pass^k from the trials without
replacement, `C(c, k) / C(n, k)`; see [Metrics](metrics.md#pass1-passk-and-passk).

pass@k (at least one of k passes) is the number for a capability: can the agent do it at all, given
a few tries? Regression suites aim at pass^k = 1. The report shows all three.

### How many trials per task?

At least k, or the task has no pass@k and pass^k. The default is 3 trials and k = 3.

- With 3 trials, pass@1 of a task moves in steps of a third. That is enough to see a task that
  breaks, not to measure a small difference.
- To compare two agents, more **tasks** help more than more trials per task. A suite of 30 tasks with
  3 trials each says more than 10 tasks with 9.
- Use more trials (5 to 10) for the few tasks you care most about, or when a task is flaky and you
  want to know how flaky.

### How many tasks do I need?

Start with 20 to 50, drawn from real failures: bug reports, support tickets, the team's own sessions.
Add the common tasks users do. Balance them: for every "should do X" add a "should not do X". See
[Writing tasks](writing-tasks.md#what-makes-a-good-task).

### Capability suite or regression suite?

A **capability** suite holds what the agent can't do reliably yet: a low pass rate is expected, and
it shows progress. A **regression** suite holds what the agent must keep doing: it should pass at
nearly 100 %, and a failure there is a bug. Tasks graduate from capability to regression when they
pass consistently (`agent-evals graduate`); a capability suite that passes almost everything is
saturated and needs harder tasks. See [Metrics](metrics.md#saturation).

### Why grade the outcome and not the steps?

Agents find different correct paths. A grader that demands one exact sequence of tool calls fails
correct trials and teaches you to tune the agent to the grader. Check what the agent did to the
environment (`outcome`) and what it said (`facts`, `forbid`). When the path matters (the agent must
not write on a read question, must look before it pays), check that one thing (`tool_not_called`,
`tool_called` with `first`). See [the graders reference](graders.md).

### Why are infrastructure errors left out of the pass rate?

A lost connection or a rate limit says nothing about the agent. Counting it as a failure would make a
flaky test stack look like a bad agent, and a comparison between two agents would depend on which one
hit the busy minute. Infrastructure errors are retried, counted apart and reported. An adapter must
throw an `InfraError` for them; see [Extending](extending.md#an-adapter).

### Is a model judge reliable?

Only as far as it agrees with people. Calibrate it on 30 or more labelled trials per rubric
dimension, read the disagreements, fix the rubric, and label a fresh sample. Use code graders
wherever code can decide. See [Judges and calibration](judges-and-calibration.md).

### Is the judge deterministic?

No. It runs at temperature 0, but providers don't promise identical answers. Several judge models
with a majority vote are steadier. Keep the judge model fixed while you compare agents.

## Running

### Can I run evals in CI without a model?

Yes, and you should not call a real model in CI. Two things run without a key:

- `agent-evals validate <suite.yaml>`: every task names known graders, has a reference solution, and
  the reference passes its graders. Model graders are skipped and counted.
- A dry run: the `scripted` adapter with `replayReference: true`, no judge, and
  `userSimulator: reference`. It proves the suite loads and the harness runs, not that the agent is
  good.

Run real evals on demand: before a release, and on every change of a prompt, a tool description, a
model or a route. To let such a run fail a pipeline, pass `run --fail-under <pass@1>` (exit 1 when a
suite × target group is below it) or compare with a baseline through `diff --fail-on-regression`;
see [the exit codes](cli-and-config.md#exit-codes).

### What does a run cost?

The package adds no cost of its own; the model calls do. Roughly:

```text
agent calls  = tasks × targets × trials × model calls per trial
judge calls  = tasks × targets × trials × rubric dimensions × judge models   (per judge grader)
user calls   = tasks with a simulated user × targets × trials × user turns
```

Retries after infrastructure errors add attempts. The report shows the mean USD per trial
(`$/task`) from the providers' usage, and marks it `≥` when a call reported no cost. Do a dry run
first, then a real run with `--trials 1` and `--task` on a few tasks, before a full run.

### How do I run one task, or fewer trials?

`agent-evals run --config <file> --task <id>,<id> --trials 1`. See
[the CLI and config reference](cli-and-config.md).

### How do I compare two models or two prompts?

Make each one a **target** of the same run: the same tasks, the same trials, side by side in the
report. To compare two runs (before and after a change), use `agent-evals diff <before> <after>`,
`agent-evals report <run> --baseline <before>`, or the viewer's side-by-side view. For a direct
judgement of two transcripts, `comparePair` asks a judge in both orders. See
[Judges and calibration](judges-and-calibration.md#pairwise-comparison-comparepair).

### Does it work with my agent framework?

If your agent can be driven from Node, yes: write an adapter (a `start` function that returns
`send`, `outcome` and `close`). The built-in `http-sse` adapter drives an agent behind HTTP that
streams Server-Sent Events, so the agent can be written in any language. The `openai-tools` adapter
is a small agent of its own, to compare models on the task's mock tools. See
[Extending](extending.md#an-adapter).

### Do I need a server or a database?

No. Tasks are files, a run is a folder of files, and the viewer is a local process. Nothing runs in
the background.

### Can I install it from npm?

Not yet: the first release, `@agent-evals/core`, is in preparation. It ships compiled JavaScript.
Until then, clone the repository, run `npm install`, and use `node src/cli.ts …` or import from
`src/index.ts`.

### Which Node version?

Node 22.18 or later.

## Data and privacy

### What do transcripts contain?

Everything the adapter records: every user and assistant message, every tool call with its arguments
and result, every model call with tokens and cost, and errors. `run.json` holds every transcript,
`report.html` shows every transcript in one file, and `transcripts/` has one JSONL file per trial.

### Can I use real customer data?

Keep evals on **synthetic data**. Transcripts may contain whatever the agent saw and said: names,
amounts, documents. The package has **no built-in redaction** today. It writes the transcripts to
local files and sends parts of them to the judge's provider (what the judge's `include` names) and
to the simulated user's provider (the conversation). Treat a run folder like the data in it: don't
commit it, don't attach `report.html` to a ticket, and delete runs you no longer need.

When a task comes from a real user's report, keep the pattern (what was asked, what went wrong) and
invent the data. See [Writing tasks](writing-tasks.md#from-a-users-report-to-a-task).

### Are API keys written anywhere?

No. A config names the environment variable (`apiKeyEnv`, default `OPENROUTER_API_KEY`); the key is
read at start and kept in memory. The built-in client keeps it in a private field, so it is not
serialized with the client.

### Does the viewer expose my results on the network?

No. It listens on 127.0.0.1 only, refuses requests whose `Host` header is not its own, and refuses
writes from other web pages (a write needs a custom header and, when the browser sends an `Origin`,
the viewer's own). See [the viewer](viewer.md).

## Project

### Is this an official implementation of the article?

No. The package follows the method of
[Demystifying evals for AI agents](https://www.anthropic.com/research/demystifying-evals-for-ai-agents)
and uses its terms. The article's authors do not endorse or maintain it.

### How does it compare with other eval tools?

See [Comparison](comparison.md).
