// An agent for the command adapter's tests. It speaks the protocol of docs/python-agents.md; each user message names
// what it does. On the start record it writes a note with its pid and the record; when its stdin closes, it writes how
// many turns it took to the file CLOSED_FILE names, so a test can tell a clean exit from a kill.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
/** Writes to stderr, then exits: a pipe on Windows is asynchronous, so exiting at once could lose the text. */
const exitWith = (code, text) => process.stderr.write(text, () => process.exit(code));

let turns = 0;
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

input.on('line', (line) => {
  const event = JSON.parse(line);
  if (event.type === 'start') {
    emit({ type: 'note', text: 'started', data: { pid: process.pid, start: event } });
    return;
  }
  turns++;
  switch (event.text) {
    case 'fail':
      emit({ type: 'text', text: 'Partial' });
      emit({ type: 'error', message: 'TooManyToolRounds' });
      break;
    case 'busy':
      emit({ type: 'error', message: 'HTTP 503 from the backend', infra: true });
      break;
    case 'crash': {
      const log = Array.from({ length: 15 }, (_, i) => `log line ${i + 1}`).join('\n');
      exitWith(1, `${log}\nTraceback (most recent call last):\nRuntimeError: boom\n`);
      break;
    }
    case 'tempfail':
      exitWith(75, 'the backend is down\n');
      break;
    case 'log':
      process.stdout.write('Loading model weights...\n');
      break;
    case 'cwd':
      emit({ type: 'text', text: process.cwd() });
      emit({ type: 'done' });
      break;
    case 'hang':
      // An agent that ignores SIGTERM: only SIGKILL ends it.
      process.on('SIGTERM', () => undefined);
      emit({ type: 'note', text: 'hanging' });
      break;
    case 'hang with a child': {
      // What a wrapper such as `uv run` does: the real agent is a child that shares the output.
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'inherit',
      });
      emit({ type: 'note', text: 'hanging', data: { child: child.pid } });
      break;
    }
    default:
      emit({ type: 'tool_call', id: `call-${turns}`, name: 'get_invoice', args: { turn: turns } });
      emit({
        type: 'tool_result',
        id: `call-${turns}`,
        name: 'get_invoice',
        result: { open: true },
      });
      emit({ type: 'text', text: `turn ${turns}: ` });
      emit({ type: 'text', text: event.text });
      emit({
        type: 'usage',
        model: 'fixture-model',
        inputTokens: 3,
        outputTokens: 4,
        costUsd: 0.01,
      });
      emit({ type: 'outcome', outcome: { turns } });
      emit({ type: 'done' });
  }
});

input.on('close', () => {
  if (process.env.CLOSED_FILE) writeFileSync(process.env.CLOSED_FILE, String(turns));
});
