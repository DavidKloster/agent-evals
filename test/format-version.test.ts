import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { scriptedAdapter } from '../src/adapters/scripted.ts';
import { defineSuite } from '../src/core/loader.ts';
import { FORMAT_VERSION, type RunResult } from '../src/core/types.ts';
import { runEval } from '../src/harness/run.ts';
import { readRun, writeReports } from '../src/report/write.ts';

// D16: run.json and every transcript line carry the format version, and a reader refuses a newer one.
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-evals-format-'));
  dirs.push(dir);
  return dir;
};

const suite = defineSuite({
  name: 'demo',
  kind: 'capability',
  tasks: [{ id: 't', input: { turns: ['q'] }, graders: [{ type: 'facts', facts: ['a'] }] }],
});
const target = { name: 'a', adapter: scriptedAdapter({ replies: { t: () => ({ text: 'a' }) } }) };

const minimalRun = (extra: Record<string, unknown> = {}) =>
  ({
    id: 'r',
    startedAt: '2026-10-22T00:00:00.000Z',
    finishedAt: '2026-10-22T00:00:01.000Z',
    targets: [],
    suites: [],
    trials: [],
    ...extra,
  }) as RunResult;

describe('format versions (D16)', () => {
  it('starts at 1', () => {
    expect(FORMAT_VERSION).toBe(1);
  });

  it('is in a run, first in run.json, and on every transcript line', async () => {
    const out = tempDir();
    const run = await runEval({ suites: [suite], targets: [target], trials: 1, outDir: out });
    expect(run.formatVersion).toBe(FORMAT_VERSION);
    writeReports(run, out);
    expect(readFileSync(join(out, 'run.json'), 'utf8')).toMatch(/^\{\n {2}"formatVersion": 1,/);
    const folder = join(out, 'transcripts', 'demo', 'a');
    const lines = readFileSync(join(folder, readdirSync(folder)[0]!), 'utf8')
      .trim()
      .split('\n');
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines)
      expect(JSON.parse(line) as Record<string, unknown>).toMatchObject({ formatVersion: 1 });
  });

  it('writes the current version for a run built without one, and keeps the version a run carries', () => {
    const out = tempDir();
    writeReports(minimalRun(), out);
    expect(readRun(out).formatVersion).toBe(FORMAT_VERSION);
    // readRun converts nothing, so a run keeps the version its content is in (only 1 exists today).
    writeReports(minimalRun({ formatVersion: 1 }), out);
    expect(readFileSync(join(out, 'run.json'), 'utf8')).toMatch(/^\{\n {2}"formatVersion": 1,/);
  });

  it("never lets an event's own formatVersion key override the line's", async () => {
    const out = tempDir();
    const replayed = defineSuite({
      name: 'demo',
      kind: 'capability',
      tasks: [
        {
          id: 't',
          input: { turns: ['q'] },
          graders: [{ type: 'facts', facts: ['a'] }],
          reference: {
            transcript: [
              { type: 'note', text: 'n', formatVersion: 7 },
              { type: 'message', role: 'assistant', text: 'a' },
            ],
          },
        },
      ],
    });
    await runEval({
      suites: [replayed],
      targets: [{ name: 'a', adapter: scriptedAdapter({ replayReference: true }) }],
      trials: 1,
      outDir: out,
    });
    const folder = join(out, 'transcripts', 'demo', 'a');
    const lines = readFileSync(join(folder, readdirSync(folder)[0]!), 'utf8')
      .trim()
      .split('\n');
    expect(lines.some((line) => line.includes('"type":"note"'))).toBe(true);
    for (const line of lines) expect(line).toMatch(/^\{"formatVersion":1,/);
  });

  it('reads a run.json without a version (written before 0.1.0) as version 1', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'run.json'), JSON.stringify(minimalRun()));
    expect(readRun(dir).trials).toEqual([]);
  });

  it('refuses a run.json from a newer format, and a malformed version', () => {
    const dir = tempDir();
    const write = (formatVersion: unknown) =>
      writeFileSync(join(dir, 'run.json'), JSON.stringify(minimalRun({ formatVersion })));
    write(2);
    expect(() => readRun(dir)).toThrow(
      /format version 2, newer than the 1 this version of agent-evals reads: upgrade agent-evals/,
    );
    for (const bad of [0, 1.5, '1', null]) {
      write(bad);
      expect(() => readRun(dir)).toThrow(/formatVersion must be a positive whole number/);
    }
  });
});
