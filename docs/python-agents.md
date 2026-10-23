# Evaluating a Python agent

An agent written in Python (a LangGraph graph, a plain SDK loop, a workflow engine) is often not
reachable over HTTP. The `command` adapter runs it as a process instead: one process per trial,
user messages as JSON lines on its stdin, its events as JSON lines on its stdout. Nothing in the
protocol is Python-specific, so the same works for an agent in any language.

## The target

```yaml
# eval.config.yaml
suites: [regression/suite.yaml]
targets:
  - name: my-agent
    adapter: command
    options:
      command: [uv, run, python, eval_bridge.py]
      cwd: ../agent # relative to this file
      env: { MY_AGENT_MODE: eval }
```

| Option    | Type     | Default               | Meaning                                                                 |
| --------- | -------- | --------------------- | ----------------------------------------------------------------------- |
| `command` | string[] | required              | The program and its arguments. It is started without a shell.           |
| `cwd`     | string   | the current directory | The working directory. In a config file, a relative path is the file's. |
| `env`     | object   |                       | Environment variables set over the environment `agent-evals` runs in.   |

The process gets the whole environment of `agent-evals`, its API keys included. Trials run in
parallel (`concurrency`, default 4), so as many processes run at once. In a TypeScript config, the
same target is `{ name: 'my-agent', adapter: commandAdapter({ command, cwd, env }) }`.

## The protocol

**stdin.** The first line is the start record; then each user message is one line:

```text
{"type":"start","suite":"invoices","task":{"id":"due-date","input":{"context":{"page":"inbox"}}},"target":"my-agent","trial":0}
{"type":"user","text":"When is RE-1 due?"}
```

`task.input.context` is the task's `input.context` merged over the suite's `defaults.context` (`{}`
when neither has one). `trial` is the 0-based trial index. stdin is closed when the trial ends.

**stdout.** One JSON object per line, with a `type`. The events and their fields are the same as the
`http-sse` adapter's:

| `type`        | Fields                                                                                          | What it does                                                                           |
| ------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `text`        | `text`                                                                                          | Adds a piece of the reply. The first one's arrival is the turn's first token.          |
| `tool_call`   | `id`, `name`, `args`                                                                            | Records a tool call.                                                                   |
| `tool_result` | `id`, `name`, `result`, `error?`                                                                | Records the call's result.                                                             |
| `usage`       | `model`, `inputTokens?`, `outputTokens?`, `costUsd?`, `startedAt?`, `firstTokenAt?`, `endedAt?` | Records a model call (times in ms since the epoch; the line's arrival when left out).  |
| `note`        | `text`, `data?`                                                                                 | Records a [note](transcript-format.md#note).                                           |
| `outcome`     | `outcome`                                                                                       | Sets the trial's outcome, any JSON value. The last one counts.                         |
| `done`        |                                                                                                 | Ends the turn; the reply is the joined `text`.                                         |
| `error`       | `message`, `infra?`                                                                             | Ends the turn as a failure: the agent's, or the infrastructure's with `"infra": true`. |

- Events are recorded when their line arrives. Other types and blank lines are ignored.
- The harness reads the outcome right after the last turn, before it closes stdin. Write `outcome`
  before the turn's `done`.
- A line that is not a JSON object with a `type` fails the turn as the agent's error. Logs belong on
  **stderr**, which is never parsed; its last lines are quoted when the process fails.
- Flush stdout after every line: a pipe is block-buffered.

## Errors and the end of a process

| What happens                                                | The trial                               |
| ----------------------------------------------------------- | --------------------------------------- |
| `{"type":"error","message":"…"}`                            | `agent_error`                           |
| A stdout line that is not a JSON event                      | `agent_error`                           |
| The process exits before the turn's `done`                  | `agent_error`, with the code and stderr |
| The process exits with code **75** before the turn's `done` | infrastructure error: retried           |
| `{"type":"error","message":"…","infra":true}`               | infrastructure error: retried           |
| The program can't be started (not found, not executable)    | infrastructure error: retried           |
| The trial's time limit passes                               | `timeout`                               |

Code 75 is `EX_TEMPFAIL` ("try again later") from `sysexits.h`. Use it, or an `error` event with
`"infra": true`, when a system the agent needs is down or rate-limited: a 503, a 429, a stack that
isn't up. An infrastructure error is retried and never counted as the agent's failure (see
[Troubleshooting](troubleshooting.md#infrastructure-errors-and-retries)).

When the trial ends, stdin is closed. A process should then clean up and exit; after 5 seconds it is
sent SIGTERM, and SIGKILL 2 seconds later. When the time limit cuts a turn short, the process gets
SIGTERM at once. On Linux and macOS the process runs in its own process group, and the signals go to
the whole group, so what a wrapper such as `uv run` started ends too. On Windows only the process
itself is ended.

## A minimal script

Standard library only. Replace `answer` with a call of your agent:

```python
"""eval_bridge.py: drives the agent for agent-evals, one process per trial."""

import json
import sys

sys.stdin.reconfigure(encoding="utf-8")


def emit(event):
    print(json.dumps(event), flush=True)


def answer(message, history, context):
    """Your agent goes here. This stand-in remembers the conversation and echoes the message."""
    history.append(message)
    return f"Turn {len(history)}: {message}"


start = json.loads(sys.stdin.readline())
context = start["task"]["input"]["context"]  # what the task file puts under input.context
print(f"trial {start['trial']} of {start['task']['id']}", file=sys.stderr)  # logs go to stderr
history = []
for line in sys.stdin:
    message = json.loads(line)["text"]
    try:
        reply = answer(message, history, context)
    except ConnectionError as error:  # a backend that is down: an infrastructure error
        emit({"type": "error", "message": str(error), "infra": True})
        continue
    except Exception as error:  # anything else is the agent's failure
        emit({"type": "error", "message": repr(error)})
        continue
    emit({"type": "tool_call", "id": f"call-{len(history)}", "name": "echo", "args": {"text": message}})
    emit({"type": "tool_result", "id": f"call-{len(history)}", "name": "echo", "result": reply})
    emit({"type": "text", "text": reply})
    emit({"type": "outcome", "outcome": {"turns": len(history)}})
    emit({"type": "done"})
# stdin is closed: the trial is over. Clean up here.
```

Each process is one conversation, so state in the script (here `history`) lasts exactly one trial.
Read the outcome from the environment the agent changed (the database rows, the sent mails), not
from its words: the [outcome grader](graders.md#outcome) checks it.
