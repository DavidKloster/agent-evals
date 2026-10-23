import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it, vi } from 'vitest';

import { commandAdapter } from '../src/adapters/command.ts';
import { loadConfig, resolveConfig, type EvalConfig } from '../src/config.ts';
import { defineSuite } from '../src/core/loader.ts';
import type { Target, TranscriptEventInput, TrialContext } from '../src/core/types.ts';
import { runEval } from '../src/harness/run.ts';

const agent = [
  process.execPath,
  fileURLToPath(new URL('support/command-agent.mjs', import.meta.url)),
];
const dir = mkdtempSync(join(tmpdir(), 'agent-evals-command-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const suiteOf = (turns: string[]) =>
  defineSuite({
    name: 's',
    kind: 'regression',
    tasks: [
      {
        id: 'invoice',
        input: { turns, context: { page: 'inbox' } },
        graders: [{ type: 'tool_called', tool: 'get_invoice' }],
      },
    ],
  });

/** Runs one trial of a task with the given user messages. */
async function runOne(turns: string[], target: Target, retries = 0) {
  const run = await runEval({ suites: [suiteOf(turns)], targets: [target], trials: 1, retries });
  return run.trials[0]!;
}

const cmd = (options: Partial<Parameters<typeof commandAdapter>[0]> = {}): Target => ({
  name: 'cmd',
  adapter: commandAdapter({ command: agent, ...options }),
});

const notes = (events: TranscriptEventInput[]) =>
  events.flatMap((e) => (e.type === 'note' ? [e as { text: string; data?: unknown }] : []));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The time limit of a test that waits for a kill: SIGKILL comes 2 s after SIGTERM, and CI machines are slow. */
const killTestMs = 15_000;

/** Waits until the process is gone; false if it is still alive after `ms`. */
async function ends(pid: number, ms = 5_000): Promise<boolean> {
  for (const end = Date.now() + ms; alive(pid); await delay(50)) if (Date.now() > end) return false;
  return true;
}

/** A started session outside the harness, with its own abort controller and transcript. */
async function startSession() {
  const controller = new AbortController();
  const events: TranscriptEventInput[] = [];
  const suite = suiteOf(['hang']);
  const context: TrialContext = {
    suite,
    task: suite.tasks[0]!,
    target: 'cmd',
    trial: 0,
    signal: controller.signal,
    record: (event) => events.push(event),
  };
  const session = await commandAdapter({ command: agent }).start(context);
  return { session, controller, events };
}

describe('commandAdapter', () => {
  it('maps the events of each turn, keeps one process across turns and closes its stdin at the end', async () => {
    const closedFile = join(dir, 'closed');
    const trial = await runOne(
      ['Is RE-1 open?', 'And RE-2?'],
      cmd({ env: { CLOSED_FILE: closedFile } }),
    );
    expect(trial).toMatchObject({ status: 'completed', passed: true, outcome: { turns: 2 } });
    expect(trial.metrics).toMatchObject({ turns: 2, toolCalls: 2, modelCalls: 2, costUsd: 0.02 });
    const replies = trial.transcript.flatMap((e) =>
      e.type === 'message' && e.role === 'assistant' ? [e.text] : [],
    );
    expect(replies).toEqual(['turn 1: Is RE-1 open?', 'turn 2: And RE-2?']);
    expect(notes(trial.transcript)[0]!.data).toMatchObject({
      start: {
        type: 'start',
        suite: 's',
        task: { id: 'invoice', input: { context: { page: 'inbox' } } },
        target: 'cmd',
        trial: 0,
      },
    });
    // The agent saw its stdin end and exited by itself: the harness's abort at the trial's end didn't kill it.
    expect(readFileSync(closedFile, 'utf8')).toBe('2');
  });

  it("fails the turn as the agent's error on an error event, keeping the partial answer", async () => {
    const trial = await runOne(['fail'], cmd());
    expect(trial).toMatchObject({ status: 'agent_error', error: 'TooManyToolRounds' });
    expect(trial.transcript).toContainEqual(
      expect.objectContaining({ type: 'message', role: 'assistant', text: 'Partial' }),
    );
  });

  it('fails the turn as an infrastructure error on an error event with infra: true', async () => {
    const trial = await runOne(['busy'], cmd(), 1);
    expect(trial).toMatchObject({
      status: 'infra_error',
      attempts: 2,
      infraErrors: ['HTTP 503 from the backend', 'HTTP 503 from the backend'],
    });
  });

  it("reports an exit before done as the agent's error with stderr's tail, and exit code 75 as infrastructure", async () => {
    const crashed = await runOne(['crash'], cmd());
    expect(crashed.status).toBe('agent_error');
    expect(crashed.error).toMatch(/^the command exited with code 1 before its turn ended/);
    expect(crashed.error).toContain('RuntimeError: boom');
    expect(crashed.error).not.toContain('log line 1\n');
    const tempfail = await runOne(['tempfail'], cmd());
    expect(tempfail.status).toBe('infra_error');
    expect(tempfail.error).toContain('exited with code 75');
    expect(tempfail.error).toContain('the backend is down');
  });

  it('reports a program that cannot be started as an infrastructure error', async () => {
    const trial = await runOne(['hi'], {
      name: 'cmd',
      adapter: commandAdapter({ command: ['agent-evals-no-such-program'] }),
    });
    expect(trial.status).toBe('infra_error');
    expect(trial.error).toContain('could not start agent-evals-no-such-program');
  });

  it("fails the turn as the agent's error on a stdout line that is not a JSON event", async () => {
    const trial = await runOne(['log'], cmd());
    expect(trial.status).toBe('agent_error');
    expect(trial.error).toContain('Loading model weights...');
    expect(trial.error).toContain('not a JSON event');
  });

  it(
    'kills the process when the signal aborts a turn, with SIGKILL when it ignores SIGTERM',
    async () => {
      const { session, controller, events } = await startSession();
      try {
        const reply = session.send('hang');
        await vi.waitFor(() => expect(notes(events).map((n) => n.text)).toContain('hanging'));
        const { pid } = notes(events)[0]!.data as { pid: number };
        controller.abort(new Error('the trial took too long'));
        await expect(reply).rejects.toThrow('the trial took too long');
        expect(await ends(pid)).toBe(true);
      } finally {
        await session.close?.();
      }
    },
    killTestMs,
  );

  // Windows has no process groups: there only the process itself is ended.
  it.skipIf(process.platform === 'win32')(
    'kills what the process started too, as a wrapper like `uv run` starts the agent',
    async () => {
      const { session, controller, events } = await startSession();
      try {
        const reply = session.send('hang with a child');
        await vi.waitFor(() => expect(notes(events).map((n) => n.text)).toContain('hanging'));
        const { child } = notes(events)[1]!.data as { child: number };
        controller.abort(new Error('the trial took too long'));
        await expect(reply).rejects.toThrow('the trial took too long');
        expect(await ends(child)).toBe(true);
      } finally {
        await session.close?.();
      }
    },
    killTestMs,
  );

  it('is built from a YAML config, with a relative cwd resolved against the config file', async () => {
    mkdirSync(join(dir, 'agent'), { recursive: true });
    const file = join(dir, 'eval.yaml');
    writeFileSync(
      file,
      [
        'suites: []',
        'targets:',
        '  - name: cmd',
        '    adapter: command',
        `    options: { command: [${agent.map((part) => JSON.stringify(part)).join(', ')}], cwd: agent }`,
      ].join('\n'),
    );
    const { config, baseDir } = await loadConfig(file);
    const trial = await runOne(['cwd'], resolveConfig(config, baseDir).targets[0]!);
    expect(trial.transcript.at(-1)).toMatchObject({ text: realpathSync(join(dir, 'agent')) });
    // A shell line in one string would start a program named after it and fail every trial.
    const shellLine = {
      suites: [],
      targets: [{ name: 'cmd', adapter: 'command', options: { command: 'python agent.py' } }],
    } as unknown as EvalConfig;
    expect(() => resolveConfig(shellLine, dir)).toThrow('a list of strings');
  });
});
