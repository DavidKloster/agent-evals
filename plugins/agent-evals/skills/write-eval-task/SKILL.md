---
name: write-eval-task
description: Use when turning an agent failure, a bad transcript, a bug or a user's report into an eval task, adding a task to an agent-evals suite, or deciding whether a task belongs in the capability or the regression suite.
---

# Writing an eval task

A task is one YAML file in a suite's `tasks/` folder: the input, the graders, and a reference solution that passes them. A task from a failure is a regression test for an agent: it must go **red** on the failure and **green** on the reference. Run the CLI as the `agent-evals` skill says (`npx @agent-evals/core <command>`).

## Steps

1. **Name the pattern** in one line: what the user asked, what the agent did, what it should have done.
2. **Start from the template.** Copy `node_modules/@agent-evals/core/templates/task-from-report.yaml` into the capability suite's `tasks/` folder as `<task-id>.yaml`, and point its first-line `$schema` comment at `node_modules/@agent-evals/core/schema/task.schema.json`, relative to the file. A finished example: [from-report-status-not-pay.yaml](https://github.com/DavidKloster/agent-evals/blob/main/examples/invoice-desk/capability/tasks/from-report-status-not-pay.yaml).
3. **Invent the data.** Write a question of the same shape on data the eval's mock tools hold (the `responses` in `tools.yaml`, or the suite's `defaults.context`). Keep no name, number, amount, date or text from the report (what the mock data already holds is invented, so reuse it freely); `source:` names only the report's ID, or `user report, synthetic rewrite` without one. When no mock data fits, add an invented record to the mock tools, then dry-run every suite that shares them (step 6 without `--task`).
4. **Grade in this order.** Each reported failure as a `required: true` grader (a wrong language or form of address: `language`, `formality`); then the outcome (`outcome`: `expect: { writes: { length: 0 } }` for "changed nothing"; a refused write lands in `failedWrites`, so add `failedWrites: { length: 0 }` for "didn't even try"); then the calls (`tool_called` with `args`); then the answer's facts (`facts`, with alternatives in a nested list, and `forbid` for a wrong fact). With several graders, `scoring: { mode: hybrid, threshold: 0.6 }` keeps the required ones strict. Parameters: [Graders](https://github.com/DavidKloster/agent-evals/blob/main/docs/graders.md).
5. **Write the reference**: the user message, the tool calls the graders look at, a correct answer, and the `outcome` (`{ writes: [], failedWrites: [], state: null }` when nothing is written). Its facts must be in the assistant's text: `facts` ignores the user's own messages. `validate` doesn't call the mock tools, so check by hand that each reference call matches a `when` of its tool.
6. **Green:** `npx @agent-evals/core validate <suite.yaml>` prints `OK` for the suite, and `npx @agent-evals/core run --config <dry-run config> --task <task-id> --out <temp dir>` passes every trial (the dry-run config replays the references with `replayReference: true`; the example calls it `eval.replay.yaml`). Delete the output.
7. **Red:** replay the reported failure and watch the task fail. A scratch config next to the dry-run config (paths in a config are relative to it) replays what the agent did: its answer, its tool calls with their results (an `error` for a call that failed), and in `outcomes` what it changed (`writes`) or tried to (`failedWrites`):

   ```yaml config
   suites: [capability/suite.yaml]
   targets:
     - name: reported-failure
       adapter: scripted
       options:
         replies:
           <task-id>:
             - text: '<the bad answer>'
               events:
                 - { type: tool_call, id: c1, name: <tool>, args: {} }
                 - { type: tool_result, id: c1, name: <tool>, result: null, error: '<its error>' }
         outcomes:
           <task-id>:
             writes: []
             failedWrites: [{ tool: <tool>, args: {}, error: '<its error>' }]
             state: null
   ```

   `npx @agent-evals/core run --config <scratch config> --task <task-id> --trials 1 --out <temp dir>` must print `FAIL`, and its `report.md` must list the grader you wrote for the reported failure among the failed ones: the suite's `no_error` fails on a replayed tool error by itself. A task that passes the reported failure tests nothing: tighten its graders. Delete the scratch config and its output.

8. **Balance.** When the fix could overshoot (it wrote when it shouldn't), keep or add the opposite task (it should write when asked).

## Capability or regression

- A new task from a failure goes into the **capability** suite: the agent can't do it reliably yet.
- The **regression** suite holds what must keep passing. A task moves there when `npx @agent-evals/core graduate <older run> <newer run>` lists it (it passed every trial of the last runs); the move is a pull request.
- More: [Writing tasks and running suites](https://github.com/DavidKloster/agent-evals/blob/main/docs/writing-tasks.md).
