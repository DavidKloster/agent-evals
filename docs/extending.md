# Extending

The package is meant to be extended in code: an adapter for your agent, graders for your domain, fact
matchers for values that are written in many ways, reports in your own format, hooks that reset your
environment, and a judge client for any provider. This page shows how, with complete examples. Every
`ts doctest` block on this page runs in the package's tests, without a network or a model.

The extension points are plain TypeScript interfaces from `src/core/types.ts`. There is no plugin
loader: you pass your objects to `runEval`, or put them in a TypeScript config module (see the end of
this page).

## An adapter

An adapter connects the evaluation harness to the system under test, the agent harness. It has one
method:

```ts
interface Adapter {
  start(context: TrialContext): Promise<AgentSession>;
}

interface AgentSession {
  send(message: string): Promise<AgentReply>;
  outcome?(): unknown; // the final state of the environment, or a promise of it
  close?(): Promise<void> | void;
}

interface AgentReply {
  text: string;
  firstTokenAt?: number; // epoch ms of the reply's first token
  done?: boolean; // the agent ended the conversation
}
```

(These are the type declarations, shown for reference.)

### The contract

- **`start(context)`** is called once per attempt. Open a **new, clean** session: a new
  conversation, a new browser page, a fresh copy of the data. Never reuse a session across trials.
- **`send(message)`** sends one user message and returns the agent's reply. The harness records the
  user message and the assistant message itself. Do **not** record them again.
- **`context.record(event)`** adds everything else to the transcript, while it happens: `model_call`,
  `tool_call`, `tool_result`, `note` and `error` events. `at` defaults to now. The
  [transcript format](transcript-format.md) lists the fields. The graders read tool calls and
  results, the metrics read model calls (tokens, cost, first token).
- **`outcome()`** reads the final state of the environment: what was written, what was sent. Read it
  from the environment, not from what the agent said. The `outcome` grader checks it. The harness
  calls it after a successful conversation, and also after a failed one (waiting at most 10 seconds),
  because a failed trial may still have changed something.
- **`close()`** cleans up what the session holds: it deletes the conversation, closes the page. The
  harness waits at most 10 seconds for it.
- **`context.signal`** is aborted when the trial times out. Pass it to `fetch` and to timers, and
  check it in loops (`signal.throwIfAborted()`). An adapter that ignores it does no harm to the run,
  but it keeps working (and spending) after the trial has ended.
- **Errors.** Throw an `InfraError` for a failure of the eval's own infrastructure: the agent's stack
  is down, the connection broke, the eval account hit a rate limit. The harness retries the trial and
  never counts it as the agent's failure. Throw any other `Error` for the agent's own failure: it
  refused, it crashed, it ran out of steps. That trial is `agent_error`.
- `context.task.input.context` carries whatever a task file puts under `input.context`, merged over
  the suite's `defaults.context`. Use it for the adapter's own settings per task: the page to start
  on, the user to act as, the data to seed.

### A complete adapter

This module wraps a small in-process agent: it reads and pays invoices with two tools, keeps its data
per session, honours the signal, and reports an unreachable backend as an infrastructure error. Then
it runs three tasks against it.

```ts doctest
import { setTimeout as delay } from 'node:timers/promises';

import {
  InfraError,
  defineSuite,
  runEval,
  type Adapter,
  type AgentSession,
  type TrialContext,
} from '@agent-evals/core';

interface Invoice {
  number: string;
  amount: number;
  paid: boolean;
}

/** The system under test: a tiny rule-based agent with a read tool and a write tool. */
function invoiceAgentAdapter(): Adapter {
  return {
    async start(context: TrialContext): Promise<AgentSession> {
      if (context.task.input.context?.backendDown)
        throw new InfraError('the invoice backend is not reachable');
      // Fresh data per trial: nothing is shared between trials.
      const invoices: Invoice[] = [
        { number: 'INV-1', amount: 120, paid: false },
        { number: 'INV-2', amount: 80.5, paid: true },
      ];
      let calls = 0;
      const tool = (name: string, args: { number: string }, run: () => unknown) => {
        const id = `call-${++calls}`;
        context.record({ type: 'tool_call', id, name, args });
        try {
          const result = run();
          context.record({ type: 'tool_result', id, name, result });
          return result;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          context.record({ type: 'tool_result', id, name, result: null, error: message });
          return null;
        }
      };
      return {
        async send(message) {
          const startedAt = Date.now();
          await delay(1, undefined, { signal: context.signal }); // "thinking", abortable
          context.record({
            type: 'model_call',
            model: 'rule-based',
            startedAt,
            firstTokenAt: Date.now(),
            endedAt: Date.now(),
            inputTokens: message.length,
            outputTokens: 12,
            costUsd: 0,
          });
          const number = /INV-\d+/.exec(message)?.[0];
          if (!number) return { text: 'Which invoice do you mean?' };
          const invoice = tool('get_invoice', { number }, () => {
            const found = invoices.find((i) => i.number === number);
            if (!found) throw new Error(`no invoice ${number}`);
            return { ...found };
          }) as Invoice | null;
          if (!invoice) return { text: `I can't find ${number}.` };
          if (/\bpay\b/i.test(message) && !invoice.paid) {
            tool('pay_invoice', { number }, () => {
              invoices.find((i) => i.number === number)!.paid = true;
              return { ok: true };
            });
            return { text: `${number} is paid.`, done: true };
          }
          const status = invoice.paid ? 'paid' : 'open';
          return { text: `${number} over ${invoice.amount.toFixed(2)} EUR is ${status}.` };
        },
        // Read from the environment, not from the agent's words.
        outcome: async () => ({ paid: invoices.filter((i) => i.paid).map((i) => i.number) }),
        close: async () => {
          invoices.length = 0;
        },
      };
    },
  };
}

const suite = defineSuite({
  name: 'invoice-desk',
  kind: 'regression',
  tasks: [
    {
      id: 'status-does-not-pay',
      input: { turns: ['Is INV-1 still open?'] },
      graders: [
        { type: 'tool_called', tool: 'get_invoice', args: { number: 'INV-1' } },
        { type: 'tool_not_called', tool: 'pay_invoice' },
        { type: 'outcome', expect: { paid: { equals: ['INV-2'] } } },
        { type: 'facts', facts: ['120.00', 'open'] },
      ],
    },
    {
      id: 'pays-when-asked',
      input: { turns: ['Please pay INV-1.'] },
      graders: [
        { type: 'tool_called', tool: 'pay_invoice', args: { number: 'INV-1' } },
        { type: 'outcome', expect: { paid: { includes: 'INV-1' } } },
      ],
    },
    {
      id: 'backend-down',
      input: { turns: ['Is INV-1 open?'], context: { backendDown: true } },
      graders: [{ type: 'no_error' }],
    },
  ],
});

const run = await runEval({
  suites: [suite],
  targets: [{ name: 'rule-based', adapter: invoiceAgentAdapter() }],
  trials: 2,
  retries: 1,
});

const byTask = (id: string) => run.trials.filter((t) => t.taskId === id);
if (!byTask('status-does-not-pay').every((t) => t.passed)) throw new Error('status task failed');
if (!byTask('pays-when-asked').every((t) => t.passed)) throw new Error('pay task failed');
for (const trial of byTask('backend-down')) {
  if (trial.status !== 'infra_error' || trial.attempts !== 2)
    throw new Error('expected an infrastructure error after one retry');
}
```

The built-in adapters are good templates: `src/adapters/openai-tools.ts` (a chat-with-tools loop that
records every model call, tool call and result) and `src/adapters/http-sse.ts` (an agent behind HTTP
that streams Server-Sent Events, with `open`, `outcome` and `close` callbacks).

## A custom grader

A grader is an object with a `type`, a `kind` and a `grade` function:

```ts
interface Grader<P extends GraderSpec = GraderSpec> {
  type: string; // the name a task file uses
  kind: 'code' | 'model' | 'human';
  grade(context: GradeContext, spec: P): GraderOutput | Promise<GraderOutput>;
}

interface GraderOutput {
  assertions: Assertion[]; // { name, passed, expected?, actual?, message? }
  score?: number; // 0..1; the share of passed assertions when left out
  unknown?: boolean; // the grader couldn't decide
  details?: unknown; // kept in the result, for the report
}
```

(These are the type declarations, shown for reference.)

- `spec` is the grader's entry in the task file: `type`, `id`, `weight`, `required` and your own
  parameters.
- `context` has the task, the transcript, the outcome, `answer` (every assistant message, joined by
  blank lines), `finalAnswer` (the last one), the target's name, and the judge client and models.
- `kind` matters in two places. A `model` grader is skipped when the run has no judge (it would need
  one), and `regradeRun` keeps a `model` grader's earlier result when regrading without a judge.
  `code` and `human` graders always run.
- Throw for a broken spec (a missing parameter). The harness records a grader error, which the reports
  count apart from the agent's failures. Throw an error named `InfraError` only when an outside
  service the grader needs is down: the trial then becomes an infrastructure error.
- One assertion per thing you check makes the failure readable in the report.

Register your graders next to the built-in ones with `registry(...)`. It takes lists of graders; a
later grader with the same `type` replaces an earlier one.

```ts doctest
import {
  builtinGraders,
  defineSuite,
  registry,
  runEval,
  scriptedAdapter,
  type Grader,
  type GraderSpec,
} from '@agent-evals/core';

interface MaxLengthSpec extends GraderSpec {
  max: number;
}

/** `max_length`: the final answer has at most `max` characters. */
const maxLength: Grader<MaxLengthSpec> = {
  type: 'max_length',
  kind: 'code',
  grade(context, spec) {
    if (typeof spec.max !== 'number') throw new Error('max_length needs max');
    const length = context.finalAnswer.length;
    return {
      assertions: [
        {
          name: `at most ${spec.max} characters`,
          passed: length <= spec.max,
          expected: spec.max,
          actual: length,
        },
      ],
    };
  },
};

const graders = registry([...builtinGraders().values()], [maxLength as Grader]);

const suite = defineSuite({
  name: 'short-answers',
  kind: 'regression',
  tasks: [
    {
      id: 'brief',
      input: { turns: ['Is INV-1 paid?'] },
      graders: [
        { type: 'max_length', max: 40 },
        { type: 'facts', facts: ['paid'] },
      ],
    },
  ],
});

const run = await runEval({
  suites: [suite],
  targets: [
    {
      name: 'scripted',
      adapter: scriptedAdapter({ replies: { brief: [{ text: 'Yes, INV-1 is paid.' }] } }),
    },
  ],
  graders,
  trials: 1,
});
if (!run.trials[0]!.passed) throw new Error('expected the brief answer to pass');
```

In a YAML config you can't register graders. Use a TypeScript config module (below) with
`graders: [maxLength]`; `resolveConfig` adds them to the built-in ones.

## A fact matcher

The `facts` and `forbid` graders match each fact as a case-insensitive substring, or as a regular
expression with `re:`. Some values are written in many ways: `1,725.50`, `1.725,50`, `1725.5`. A
**fact matcher** handles one such kind of value, chosen by a prefix:

```ts
interface FactMatcher {
  prefix: string; // e.g. 'amount:'
  holds(fact: string, text: string): boolean;
}
```

(The type declaration, shown for reference.)

`holds` gets the fact **without the prefix**: for the fact `amount:1725.50` it gets `1725.50`. The
`text` is the answer as the grader sees it. For `facts`, that is the normalized answer (Markdown
emphasis and code marks removed, white space collapsed) with the user's own longer messages removed,
unless `allowEcho: true`. For `forbid`, it is the answer as written. The first matcher whose prefix
the fact starts with wins.

Pass the matchers to `builtinGraders(factMatchers)`, or as `factMatchers` in a TypeScript config.

```ts doctest
import {
  builtinGraders,
  defineSuite,
  runEval,
  scriptedAdapter,
  type FactMatcher,
} from '@agent-evals/core';

/** `amount:1725.50` holds when the text has that amount in either German or English notation. */
const amount: FactMatcher = {
  prefix: 'amount:',
  holds(fact, text) {
    const wanted = Number(fact);
    const numbers = text.match(/\d[\d.,]*\d|\d/g) ?? [];
    return numbers.some((raw) => {
      const lastSeparator = Math.max(raw.lastIndexOf(','), raw.lastIndexOf('.'));
      const decimals = lastSeparator >= 0 && raw.length - lastSeparator - 1 <= 2;
      const whole = decimals ? raw.slice(0, lastSeparator) : raw;
      const fraction = decimals ? raw.slice(lastSeparator + 1) : '';
      const value = Number(`${whole.replace(/[.,]/g, '')}.${fraction || '0'}`);
      return Math.abs(value - wanted) < 0.005;
    });
  },
};

const suite = defineSuite({
  name: 'amounts',
  kind: 'regression',
  tasks: [
    {
      id: 'total',
      input: { turns: ['What do the open invoices add up to?'] },
      graders: [{ type: 'facts', facts: ['amount:1725.50'] }],
    },
  ],
});

const run = await runEval({
  suites: [suite],
  targets: [
    {
      name: 'german-notation',
      adapter: scriptedAdapter({ replies: { total: [{ text: 'Zusammen 1.725,50 EUR.' }] } }),
    },
  ],
  graders: builtinGraders([amount]),
  trials: 1,
});
if (!run.trials[0]!.passed) throw new Error('expected 1.725,50 to match amount:1725.50');
```

## A reporter

There is **no reporter plugin API**. A report is a function of your own over a `RunResult`. The run
is plain data: `run.json` holds it, and `readRun(dir)` reads it back. Build your report from the same
functions the built-in reports use:

- `summarize(run, { k })`: the numbers per task and per suite and target (see [Metrics](metrics.md));
- `failureTable(run, reviews)`: every trial that didn't pass, with its failed assertions and its
  review class (`loadReviews(file)` reads a reviews file);
- `saturation(run, summary)`, `diffRuns(before, after)`, `calibrate(run, labels)`.

`writeReports(run, dir)` writes the built-in `run.json`, `summary.json`, `report.md` and
`report.html`. Call your own reporter next to it, or alone. This module writes a CSV file with one
row per suite and target:

```ts doctest
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  defineSuite,
  failureTable,
  runEval,
  scriptedAdapter,
  summarize,
  type RunResult,
} from '@agent-evals/core';

/** One CSV row per suite and target, plus the number of failed trials. */
function csvReport(run: RunResult, k = 3): string {
  const summary = summarize(run, { k });
  const failures = failureTable(run, []);
  const cell = (value: number | null) => (value === null ? '' : value.toFixed(4));
  const rows = summary.groups.map((group) =>
    [
      group.suite,
      group.target,
      cell(group.pass1),
      cell(group.passHatK),
      String(failures.filter((f) => f.suite === group.suite && f.target === group.target).length),
    ].join(','),
  );
  return [`suite,target,pass@1,pass^${k},failed trials`, ...rows].join('\n') + '\n';
}

const suite = defineSuite({
  name: 'smoke',
  kind: 'regression',
  tasks: [
    { id: 'hello', input: { turns: ['Hello'] }, graders: [{ type: 'facts', facts: ['hello'] }] },
  ],
});
const run = await runEval({
  suites: [suite],
  targets: [
    { name: 'scripted', adapter: scriptedAdapter({ replies: { hello: [{ text: 'Hello!' }] } }) },
  ],
  trials: 3,
});

const dir = mkdtempSync(join(tmpdir(), 'agent-evals-csv-'));
try {
  writeFileSync(join(dir, 'report.csv'), csvReport(run));
  const lines = readFileSync(join(dir, 'report.csv'), 'utf8').trim().split('\n');
  if (lines[1] !== 'smoke,scripted,1.0000,1.0000,0') throw new Error(`unexpected row ${lines[1]}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
```

## Hooks

Each trial must start from a clean state. The session is new for every attempt, but what the agent
changes outside it (a database, a mailbox, a ticket system) stays. The run's hooks reset it:

- `beforeTrial(context)` runs before every attempt, retries included: seed the data, create a fresh
  account. It runs before the trial's clock starts, with a time limit of its own (the run's
  `hookTimeoutMs`, default 60 000 ms). If it throws or runs past that limit, the attempt is an
  **infrastructure error**: the harness wraps the error in an `InfraError` (`beforeTrial failed: …`,
  `beforeTrial took longer than … ms`) and retries. Resetting the environment is the eval's job, so
  its failure is never the agent's.
- `afterTrial(context)` runs after every attempt, also after a failed one: undo a write, delete what
  the trial created. The harness waits at most `hookTimeoutMs` for it, and ignores its failure.

Both get the trial's `TrialContext`, so they can key the state by suite, task, target and trial. With
`concurrency` above 1, trials run at the same time: give each trial its own data (a tenant, a prefix)
or run with `concurrency: 1`.

```ts doctest
import { defineSuite, runEval, type Adapter } from '@agent-evals/core';

// A store outside the agent's session, shared by every trial: the hooks must reset it.
const store = new Map<string, string[]>();
const keyOf = (c: { task: { id: string }; target: string; trial: number }) =>
  `${c.task.id}/${c.target}/${c.trial}`;

// An agent that appends a note to the store on every message.
const notesAgent: Adapter = {
  async start(context) {
    return {
      async send(message) {
        const notes = store.get(keyOf(context));
        if (!notes) throw new Error('no store for this trial');
        notes.push(message);
        return { text: `Noted. You have ${notes.length} note(s).` };
      },
      outcome: async () => store.get(keyOf(context)) ?? [],
    };
  },
};

const suite = defineSuite({
  name: 'notes',
  kind: 'regression',
  tasks: [
    {
      id: 'one-note',
      input: { turns: ['Buy milk'] },
      graders: [
        { type: 'facts', facts: ['1 note'] },
        { type: 'outcome', expect: { '': { length: 1 } } },
      ],
    },
  ],
});

let failNextSetup = false;
const run = await runEval({
  suites: [suite],
  targets: [{ name: 'notes', adapter: notesAgent }],
  trials: 3,
  concurrency: 3,
  hooks: {
    beforeTrial(context) {
      if (failNextSetup) throw new Error('the store is down');
      store.set(keyOf(context), []); // a clean state per trial
    },
    async afterTrial(context) {
      store.delete(keyOf(context));
    },
  },
});
if (!run.trials.every((t) => t.passed)) throw new Error('expected every trial to start clean');

failNextSetup = true;
const broken = await runEval({
  suites: [suite],
  targets: [{ name: 'notes', adapter: notesAgent }],
  trials: 1,
  retries: 0,
  hooks: {
    beforeTrial: () => {
      if (failNextSetup) throw new Error('the store is down');
    },
  },
});
const trial = broken.trials[0]!;
if (trial.status !== 'infra_error' || !trial.infraErrors[0]?.startsWith('beforeTrial failed'))
  throw new Error('a failing beforeTrial must be an infrastructure error');
```

## A judge client for another provider

The judge and the simulated user talk to a model through a `ChatClient`:

```ts
interface ChatClient {
  complete(request: ChatRequest): Promise<ChatResponse>;
}
// ChatRequest: { model?, messages: { role: 'system' | 'user' | 'assistant'; content }[],
//                temperature?, maxTokens?, json?, signal? }
// ChatResponse: { text, model?, inputTokens?, outputTokens?, costUsd? }
```

(The type declarations, shown for reference.)

The built-in `OpenAICompatible` client covers any OpenAI-compatible chat API. For a provider with
another wire format, write a client. Follow these rules, so the judge's retries work:

- Pass `request.signal` on to the request. The judge aborts a call after 120 seconds.
- When the call was aborted, rethrow the error as it is. Its name is `TimeoutError`, which the judge
  retries.
- Throw an `InfraError` for a connection failure, a busy or broken provider (HTTP 408, 429 and 5xx)
  and a refused key (401, 403): none of them is the agent's fault. The judge retries it twice, then
  the trial becomes an infrastructure error.
- Throw a plain `Error` for anything else (a wrong model, a malformed request), naming the model.
  Retrying won't help; it becomes a grader error.
- Report `costUsd` when the provider gives it.

This client speaks a made-up provider's format. The module tests it with a fake `fetch`; in real use,
leave `fetch` out and pass the key from an environment variable.

```ts doctest
import {
  InfraError,
  type ChatClient,
  type ChatRequest,
  type ChatResponse,
} from '@agent-evals/core';

interface ExampleProviderOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
}

class ExampleProviderClient implements ChatClient {
  private readonly options: ExampleProviderOptions;

  constructor(options: ExampleProviderOptions) {
    this.options = options;
  }

  async complete(request: ChatRequest): Promise<ChatResponse> {
    const { baseUrl, apiKey, model } = this.options;
    const system = request.messages.filter((m) => m.role === 'system').map((m) => m.content);
    const body = {
      model: request.model ?? model,
      system: system.join('\n\n'),
      turns: request.messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ speaker: m.role, text: m.content })),
      temperature: request.temperature,
      max_output_tokens: request.maxTokens,
    };
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(`${baseUrl}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: request.signal,
      });
    } catch (error) {
      if (request.signal?.aborted) throw error; // a TimeoutError: the judge retries it
      throw new InfraError(
        `the request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok) {
      const message = `HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`;
      throw response.status === 408 || response.status === 429 || response.status >= 500
        ? new InfraError(message)
        : new Error(message);
    }
    const data = (await response.json()) as {
      output: string;
      usage?: { input: number; output: number; cost_usd?: number };
    };
    return {
      text: data.output,
      model: body.model,
      inputTokens: data.usage?.input,
      outputTokens: data.usage?.output,
      costUsd: data.usage?.cost_usd,
    };
  }
}

// A fake provider: busy once, then an answer.
let calls = 0;
const fakeFetch: typeof fetch = async () => {
  calls++;
  if (calls === 1) return new Response('busy', { status: 503 });
  return Response.json({
    output: '{"reason":"ok","verdict":"pass"}',
    usage: { input: 10, output: 5 },
  });
};
const client = new ExampleProviderClient({
  baseUrl: 'https://provider.invalid/v1',
  apiKey: 'not-a-real-key',
  model: 'judge-model',
  fetch: fakeFetch,
});

const request: ChatRequest = { messages: [{ role: 'user', content: 'Grade this.' }] };
const busy = await client.complete(request).catch((error: unknown) => error);
if (!(busy instanceof InfraError)) throw new Error('a 503 must be an InfraError');
const answer = await client.complete(request);
if (!answer.text.includes('"pass"')) throw new Error('expected the verdict');
```

Pass it as the judge: `runEval({ ..., judge: client, judgeModels: ['judge-model'] })`, or in a
TypeScript config as `judge: { client, models: ['judge-model'] }`. The same client works as
`userSimulator: { client, model }`.

## A TypeScript config module

A YAML or JSON config can only name the built-in adapters (`openai-tools`, `scripted`, `http-sse`)
and an OpenAI-compatible judge. For your own adapters, graders, fact matchers, judge client or hooks,
write the config as a TypeScript (or JavaScript) module whose **default export** is the config.
`agent-evals run --config eval.config.ts` imports it. The fields are listed in
[the CLI and config reference](cli-and-config.md).

- `suites` takes suite file paths (relative to the config file) or suites built in code
  (`defineSuite`).
- `targets` takes `{ name, adapter }` objects, or the YAML form of a built-in adapter.
- `graders` and `factMatchers` are added to the built-in graders.
- `judge` and `userSimulator` take `{ client, ... }` with your own `ChatClient`.

Node runs a `.ts` config by type stripping, so it needs Node 22.18 or later and only erasable
TypeScript (no enums, no parameter properties). Today the package itself also runs from source; see
[Troubleshooting](troubleshooting.md#node-refuses-to-run-the-package-from-node_modules).

This module is such a config. The test imports it, so its last lines also resolve and run it:

```ts doctest
import { tmpdir } from 'node:os';

import {
  defineSuite,
  resolveConfig,
  runEval,
  scriptedAdapter,
  type EvalConfig,
  type FactMatcher,
} from '@agent-evals/core';

const yesNo: FactMatcher = {
  prefix: 'yes:',
  holds: (_fact, text) => /\b(yes|ja)\b/i.test(text),
};

const config: EvalConfig = {
  suites: [
    defineSuite({
      name: 'smoke',
      kind: 'regression',
      tasks: [
        {
          id: 'confirms',
          input: { turns: ['Is it paid?'] },
          graders: [{ type: 'facts', facts: ['yes:'] }],
        },
      ],
    }),
  ],
  targets: [
    {
      name: 'scripted',
      adapter: scriptedAdapter({ replies: { confirms: [{ text: 'Ja, bezahlt.' }] } }),
    },
  ],
  factMatchers: [yesNo],
  trials: 2,
  k: 2,
  hooks: {
    beforeTrial: () => {
      // reset your environment here
    },
  },
};

export default config;

// What `agent-evals run --config <this file>` does with it, without writing files:
const resolved = resolveConfig(config, tmpdir(), {});
const run = await runEval({ ...resolved });
if (!run.trials.every((t) => t.passed)) throw new Error('expected the config to pass');
```
