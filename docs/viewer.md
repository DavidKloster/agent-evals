# Viewer

`agent-evals view` serves a small web page over a results folder: the runs, one run's results with
filters, a transcript reader, two runs side by side, and labelling of the judges' rubric dimensions
into the labels file that `calibrate` reads.

The viewer is a **local developer tool**. It is not meant to be deployed or shared: it listens on
`127.0.0.1` only, has no login, and shows whatever the run files under its folder hold.

## Starting it

```sh
npx agent-evals view --root results
```

It prints `The eval viewer runs on http://127.0.0.1:4177/ (labels: <file>). Ctrl+C stops it.` and runs
until stopped. The options (`--root`, `--labels`, `--port`, `--k`) are in [CLI and
configuration](cli-and-config.md#view). Open the printed URL in a browser on the same machine.

In code, `startViewer(options)` starts the same server and returns `{ url, port, labelsFile, close() }`:

| Option       | Type          | Default              | Meaning                                                        |
| ------------ | ------------- | -------------------- | -------------------------------------------------------------- |
| `root`       | string        | required             | The results folder. It must exist and be a folder.             |
| `labelsFile` | string        | `<root>/labels.yaml` | The labels file the viewer reads and writes.                   |
| `port`       | number        | 0 (a free port)      | The port on `127.0.0.1`. The CLI's default is 4177.            |
| `host`       | `"127.0.0.1"` | `"127.0.0.1"`        | Any other value is refused with an error.                      |
| `k`          | number        | 3                    | The k of pass@k and pass^k, unless a request asks for another. |

### Which runs it finds

A **run folder** is a folder that holds a `run.json`. The viewer looks for them in the root and in
folders up to three levels below it. It does not enter folders whose name starts with `.`, folders
named `node_modules` or `transcripts`, and symbolic links to folders. A run is identified by its folder
path relative to the root, with `/` as separator (`.` for the root itself); that id appears in the
page's URLs and in the API. The list is read again on every request, so new runs show after a reload.

## What it shows

The page has five views, each with its own address after `#`, so a view can be bookmarked or opened in
a new tab.

| View              | Address                           | Shows                                                                                                                                                                                                                                                                                                                                   |
| ----------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runs              | `#/`                              | Every run folder, newest first: the folder, the run id, the start time, the targets, the suites, the number of trials and the mean pass@1. Tick two runs and press **Compare**; the older one is the baseline. A folder whose `run.json` cannot be read is listed with its error.                                                       |
| A run             | `#/run/<id>`                      | The run's times, k and `meta`; per suite a table per target (pass@1, pass@k, pass^k, graded trials, USD per task, TTFT and reply p50, infrastructure, grader and grading errors) and a grid of tasks × targets with `c/n`, pass^k and one chip per trial (✓ passed, ✗ failed, ? ungraded, ! infrastructure error).                      |
| A trial           | `#/run/<id>/trial/<index>`        | One trial (`<index>` is its position in `run.json`'s `trials`): status, score, attempts, errors, the metrics, every grader with its assertions, the labelling controls, the transcript event by event with times relative to the first event, and the outcome. **Previous** and **next** walk the trials the run's filters let through. |
| Two runs compared | `#/compare/<before>/<after>`      | Per suite and target the change of pass@1, pass^k, USD per task and reply p50; per task the kind of change (worse, better, new, removed, incomparable, same), both sides' `c/n`, pass@1 and pass^k, and the change of pass@1 in percentage points. Unchanged tasks are hidden by default. **swap** exchanges the two runs.              |
| Side by side      | `#/pair/<before>/<i>/<after>/<j>` | Two trials next to each other. The compare view links the first failed trial (not an ungraded or infrastructure one) of the later run with the same trial number of the earlier one.                                                                                                                                                    |

The run view's filters apply to the grid and to previous and next in the trial view:

- **Only failed**: trials that did not pass, leaving out ungraded trials (no judge, or the judge failed), which show as `?` with their reason in the transcript reader. With a grader filter, trials in which that grader failed.
- **Target**: one target.
- **Grader**: trials that have a grader of this type (`type <type>`) or with this id.
- **Search**: a case-insensitive text search over the task id, the target, the trial's error, the
  text of every message and the message of every error event.

The filters and the cached runs live in the page until it is reloaded. **Reload** on the runs view
reads the runs again.

## Labelling

A trial graded by a `judge` has one labelling control per rubric dimension: the dimension's name and
question, three buttons **pass**, **fail** and **unknown**, a note (up to 2,000 characters) and **Save
label**. The **Labeller** field above the graders holds your name; the browser keeps it in its local
storage (`agent-evals.labeller`) for the next session.

**The judge's verdict stays hidden until you have labelled**, so your label isn't anchored on it:

- each dimension shows the judge's verdict, reason and votes only after you saved a label for that
  dimension;
- the judge grader's overall verdict, score and weight show only once every dimension has a label;
- **Show judge** reveals the judge's verdicts of that grader at once, for this page session, without a
  label.

Saving sends the label to the server, which writes it into the labels file and answers with every
label of the file. A dimension that already has a label shows `Saved: <label> by <labeller>`, and its
button reads **Update label**; saving again replaces the label. A label is identified by suite, task,
target, trial, grader id and dimension; see [the labels file](transcript-format.md#the-labels-file).
Then run `agent-evals calibrate <run> --labels <file>` to compare the judge with the labels.

## Security model

Any web page open in the same browser can send requests to `127.0.0.1`. The viewer serves transcripts,
which can hold anything an agent or a tool wrote, and it writes a file, so it defends against requests
from other sites and against content in the transcripts.

| Measure                    | What it does                                                                                                                                                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loopback only              | The server listens on `127.0.0.1` and refuses any other address. It is never reachable from the network.                                                                                                                                                                              |
| Host check                 | Every request must carry `Host: 127.0.0.1:<port>` or `Host: localhost:<port>`, else it gets 403. This stops DNS rebinding: a foreign name that resolves to `127.0.0.1` still sends its own name.                                                                                      |
| Custom header on writes    | `POST` and `DELETE` need the header `X-Agent-Evals: 1`. A cross-site page cannot send a custom header without a CORS preflight, and the viewer never allows one.                                                                                                                      |
| Origin check on writes     | A write that carries an `Origin` header must come from `http://127.0.0.1:<port>` or `http://localhost:<port>`, else it gets 403. A write without `Origin` (from a script or `curl` on the machine) is allowed.                                                                        |
| JSON only on writes        | A write's `Content-Type` must be `application/json`, else 415.                                                                                                                                                                                                                        |
| Body limit                 | A request body may hold at most 64 KiB, else 413 and the connection is closed. A body over 1 MiB is cut off.                                                                                                                                                                          |
| Paths stay inside the root | A run id must be a relative path without `..`, without a drive letter and without a null byte (else 400). The `run.json` it names is resolved with every symbolic link and must lie inside the root (else 404).                                                                       |
| Bounded labels             | Each label is checked: key fields at most 500 characters, `labeller` at most 200, `note` at most 2,000, a trial index of at most 1,000,000, and `label` one of `pass`, `fail`, `unknown`.                                                                                             |
| One fixed output file      | The only file the viewer writes is the labels file, through a temporary file and a rename, so a reader never sees half a file.                                                                                                                                                        |
| Content Security Policy    | The page is served with `default-src 'none'`, a fresh random nonce per page load for its one inline script and one inline style, `connect-src 'self'`, `img-src 'self' data:`, `base-uri 'none'`, `form-action 'none'` and `frame-ancestors 'none'`. It loads nothing from elsewhere. |
| Text-only rendering        | The page builds every element with `createElement` and puts every value from a run (messages, arguments, results, reasons) into text nodes. No transcript content is ever parsed as HTML.                                                                                             |
| Response headers           | Every response has `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY` and `Cross-Origin-Resource-Policy: same-origin`.                                                                                             |

What it does not protect against: other users and processes on the same machine can reach the port,
and the viewer has no login. Run it on your own machine, over results you are allowed to read.

## HTTP API

The page uses this API; scripts on the same machine can use it too. Every answer is JSON, except the
page itself. An error is `{ "error": "<message>" }` with the status below.

| Method   | Path               | Parameters                                                                                                 | Answer                                                                                                                                                                                                                                    |
| -------- | ------------------ | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/`, `/index.html` |                                                                                                            | The page (HTML).                                                                                                                                                                                                                          |
| `GET`    | `/api/runs`        | `k` (1 to 50, default the viewer's k)                                                                      | The run list: `[{ id, runId?, startedAt?, finishedAt?, targets, suites, trials, pass1, groups, error? }]`, newest first. `groups` is `[{ suite, target, pass1, passHatK }]`; `error` is set for a folder whose `run.json` cannot be read. |
| `GET`    | `/api/run`         | `id` (required), `k`                                                                                       | `{ id, run, summary }`: the whole `run.json` and its [summary](transcript-format.md#summary).                                                                                                                                             |
| `GET`    | `/api/diff`        | `before`, `after` (run ids, required), `k`, `minDrop` (in (0, 1], default 0.34)                            | The [diff](transcript-format.md#rundiff) of the two runs.                                                                                                                                                                                 |
| `GET`    | `/api/labels`      |                                                                                                            | `{ file, labels }`: the labels file's path and its labels.                                                                                                                                                                                |
| `POST`   | `/api/labels`      | body: a label, a list of labels, or `{ "labels": [...] }`                                                  | `{ file, labels }` after adding the labels, each replacing any label with the same key.                                                                                                                                                   |
| `DELETE` | `/api/labels`      | body: a label key (`suite?`, `taskId`, `target`, `trial`, `grader`, `dimension`; other fields are ignored) | `{ file, labels }` after removing the label with that key. Removing a label that does not exist is not an error.                                                                                                                          |

Status codes:

| Status | When                                                                                                                                                   |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 200    | Success.                                                                                                                                               |
| 400    | A missing or malformed `id`, `k` outside 1 to 50, `minDrop` outside (0, 1], a body that is not JSON, `labels` that is not a list, or an invalid label. |
| 403    | A foreign `Host`, a write without `X-Agent-Evals: 1`, or a write from a foreign `Origin`.                                                              |
| 404    | An unknown path, or no `run.json` for the id inside the root.                                                                                          |
| 405    | A method the path does not allow.                                                                                                                      |
| 413    | A body over 64 KiB.                                                                                                                                    |
| 415    | A write whose `Content-Type` is not `application/json`.                                                                                                |
| 422    | The run's `run.json` exists but is not a valid run.                                                                                                    |
| 500    | Anything else, such as a labels file on disk that is not valid.                                                                                        |

The checks run in this order: the host, the path, the method, then for writes the header, the origin,
the content type and the body.

```ts doctest
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  defineSuite,
  readLabelsFile,
  runEval,
  scriptedAdapter,
  startViewer,
  writeReports,
} from '@agent-evals/core';

// A results folder with one run.
const root = mkdtempSync(join(tmpdir(), 'agent-evals-viewer-'));
const suite = defineSuite({
  name: 'demo',
  kind: 'regression',
  tasks: [
    { id: 'greet', input: { turns: ['Hi'] }, graders: [{ type: 'facts', facts: ['hello'] }] },
  ],
});
const run = await runEval({
  suites: [suite],
  targets: [
    { name: 'bot', adapter: scriptedAdapter({ replies: { greet: [{ text: 'Hello!' }] } }) },
  ],
  trials: 1,
  outDir: join(root, 'first'),
});
writeReports(run, join(root, 'first'));

const viewer = await startViewer({ root });
try {
  const runs = await (await fetch(`${viewer.url}api/runs`)).json();
  assert.deepEqual(
    runs.map((entry: { id: string }) => entry.id),
    ['first'],
  );

  const { summary } = await (await fetch(`${viewer.url}api/run?id=first`)).json();
  assert.equal(summary.tasks[0].pass1, 1);

  const label = {
    suite: 'demo',
    taskId: 'greet',
    target: 'bot',
    trial: 0,
    grader: 'judge',
    dimension: 'polite',
    label: 'pass',
  };
  // A write without the custom header is refused.
  const refused = await fetch(`${viewer.url}api/labels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(label),
  });
  assert.equal(refused.status, 403);

  const saved = await fetch(`${viewer.url}api/labels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Evals': '1' },
    body: JSON.stringify({ labels: [label] }),
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(readLabelsFile(viewer.labelsFile), [label]);

  const outside = await fetch(`${viewer.url}api/run?id=../elsewhere`);
  assert.equal(outside.status, 400);
} finally {
  await viewer.close();
}
```
