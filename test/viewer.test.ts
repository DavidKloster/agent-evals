import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { GraderResult, HumanLabel, RunResult } from '../src/core/types.ts';
import { loadLabels } from '../src/metrics/calibration.ts';
import { writeReports } from '../src/report/write.ts';
import { readLabelsFile, removeLabel, upsertLabels } from '../src/viewer/labels-store.ts';
import { viewerPage } from '../src/viewer/page.ts';
import { startViewer, type Viewer } from '../src/viewer/server.ts';
import { runResult, trialResult, trialsOf } from './fixtures.ts';

const dirs: string[] = [];
let viewer: Viewer | undefined;

afterEach(async () => {
  await viewer?.close();
  viewer = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-evals-viewer-'));
  dirs.push(dir);
  return dir;
}

function label(partial: Partial<HumanLabel> = {}): HumanLabel {
  return {
    suite: 'core',
    taskId: 'task-1',
    target: 'model-a',
    trial: 0,
    grader: 'judge',
    dimension: 'grounded',
    label: 'pass',
    ...partial,
  };
}

const judgeGrade: GraderResult = {
  id: 'judge',
  type: 'judge',
  score: 1,
  passed: true,
  weight: 1,
  required: false,
  assertions: [{ name: 'grounded', passed: true }],
  details: {
    dimensions: [
      {
        name: 'grounded',
        question: 'Is it grounded?',
        verdict: 'pass',
        reason: 'cites',
        votes: [],
      },
    ],
  },
};

describe('the labels store', () => {
  it('creates the file, replaces a label with the same key and appends new ones', () => {
    const file = join(tempDir(), 'nested', 'labels.yaml');
    expect(readLabelsFile(file)).toEqual([]);

    upsertLabels(file, [label({ note: 'first look' })]);
    const all = upsertLabels(file, [
      label({ label: 'fail', labeller: 'dk', note: 'misses the source' }),
      label({ dimension: 'polite', label: 'unknown' }),
    ]);

    expect(all).toEqual([
      label({ label: 'fail', labeller: 'dk', note: 'misses the source' }),
      label({ dimension: 'polite', label: 'unknown' }),
    ]);
    expect(readFileSync(file, 'utf8')).toMatch(/^# /);
    expect(loadLabels(file)).toEqual(all);
  });

  it('tells labels apart by suite, task, target, trial, grader and dimension', () => {
    const file = join(tempDir(), 'labels.yaml');
    const all = upsertLabels(file, [
      label(),
      label({ suite: undefined }),
      label({ trial: 1 }),
      label({ target: 'model-b' }),
      label({ grader: 'judge#2' }),
    ]);
    expect(all).toHaveLength(5);
    expect(loadLabels(file)).toHaveLength(5);
  });

  it('keeps the helper fields of a labelling sheet entry it replaces', () => {
    const file = join(tempDir(), 'sheet.yaml');
    writeFileSync(
      file,
      '- suite: core\n  taskId: task-1\n  target: model-a\n  trial: 0\n  grader: judge\n  dimension: grounded\n' +
        '  question: Is it grounded?\n  label: unknown\n  labeller: ""\n  note: ""\n',
    );
    upsertLabels(file, [label({ labeller: 'dk' })]);
    expect(readFileSync(file, 'utf8')).toContain('question: Is it grounded?');
    expect(loadLabels(file)).toEqual([label({ labeller: 'dk' })]);
  });

  it('rejects a bad label, an overlong note and leaves the file alone', () => {
    const file = join(tempDir(), 'labels.yaml');
    upsertLabels(file, [label()]);
    const before = readFileSync(file, 'utf8');
    expect(() => upsertLabels(file, [label({ label: 'maybe' as never })])).toThrow(/label/);
    expect(() => upsertLabels(file, [label({ note: 'x'.repeat(2001) })])).toThrow(/note/);
    expect(() => upsertLabels(file, [label({ labeller: 'x'.repeat(201) })])).toThrow(/labeller/);
    expect(() => upsertLabels(file, [label({ trial: -1 })])).toThrow(/trial/);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('removes a label by its key', () => {
    const file = join(tempDir(), 'labels.yaml');
    upsertLabels(file, [label(), label({ dimension: 'polite' })]);
    const left = removeLabel(file, label({ dimension: 'polite' }));
    expect(left).toEqual([label()]);
    expect(loadLabels(file)).toEqual([label()]);
  });
});

describe('the viewer page', () => {
  it('carries the nonce on its script and style and loads nothing from outside', () => {
    const html = viewerPage('abc123');
    expect(html).toContain('<script nonce="abc123">');
    expect(html).toContain('<style nonce="abc123">');
    expect(html).not.toMatch(/(?:src|href)="https?:/);
    // Data reaches the page only as text: the script never assigns innerHTML.
    expect(html).not.toMatch(/innerHTML\s*=|insertAdjacentHTML|document\.write/);
  });
});

/** A plain HTTP request, so the test can send any Host header (fetch forbids setting it). */
function send(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    // An explicit length: Node sends a DELETE body without one, which the server can't frame.
    const length =
      options.body === undefined
        ? {}
        : { 'Content-Length': String(Buffer.byteLength(options.body)) };
    const headers = { ...length, ...options.headers };
    const req = request(url, { method: options.method ?? 'GET', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

const json = (body: string): unknown => JSON.parse(body);

function writeRun(root: string, dir: string, run: RunResult): void {
  writeReports(run, join(root, dir));
}

describe('the viewer server', () => {
  function fixtureRoot(): string {
    const root = tempDir();
    writeRun(
      root,
      'baseline',
      runResult(trialsOf(3, 3, { grades: [judgeGrade] }), undefined, {
        id: 'run-before',
        startedAt: '2026-10-20T10:00:00.000Z',
      }),
    );
    writeRun(
      root,
      join('nightly', '2026-10-22'),
      runResult([...trialsOf(3, 0), trialResult({ taskId: 'task-2' })], undefined, {
        id: 'run-after',
        startedAt: '2026-10-22T10:00:00.000Z',
      }),
    );
    return root;
  }

  it('refuses to bind anything but 127.0.0.1', async () => {
    await expect(startViewer({ root: tempDir(), host: '0.0.0.0' as '127.0.0.1' })).rejects.toThrow(
      /127\.0\.0\.1/,
    );
  });

  it('serves the page with a strict CSP', async () => {
    viewer = await startViewer({ root: fixtureRoot(), port: 0 });
    expect(viewer.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const res = await send(viewer.url);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(res.body).toContain(`<script nonce="${nonce}">`);
  });

  it('lists the runs under the root, newest first, without transcripts', async () => {
    viewer = await startViewer({ root: fixtureRoot(), port: 0 });
    const res = await send(`${viewer.url}api/runs`);
    expect(res.status).toBe(200);
    const runs = json(res.body) as { id: string; runId: string; trials: number; pass1: number }[];
    expect(runs.map((r) => r.id)).toEqual(['nightly/2026-10-22', 'baseline']);
    expect(runs[0]).toMatchObject({ runId: 'run-after', trials: 4 });
    expect(runs[1]).toMatchObject({ runId: 'run-before', trials: 3, pass1: 1 });
    expect(res.body).not.toContain('transcript');
  });

  it('returns a run with its trials and summary, and rejects ids outside the root', async () => {
    const root = fixtureRoot();
    viewer = await startViewer({ root, port: 0 });
    const res = await send(`${viewer.url}api/run?id=baseline`);
    expect(res.status).toBe(200);
    const body = json(res.body) as { run: RunResult; summary: { tasks: unknown[] } };
    expect(body.run.trials).toHaveLength(3);
    expect(body.run.trials[0]?.transcript.length).toBeGreaterThan(0);
    expect(body.summary.tasks).toHaveLength(1);

    expect((await send(`${viewer.url}api/run?id=../x`)).status).toBe(400);
    expect((await send(`${viewer.url}api/run?id=${encodeURIComponent(root)}`)).status).toBe(400);
    expect((await send(`${viewer.url}api/run?id=nowhere`)).status).toBe(404);

    // A symlink that leads out of the root is not followed.
    const outside = tempDir();
    writeRun(outside, 'secret', runResult(trialsOf(1, 1)));
    symlinkSync(join(outside, 'secret'), join(root, 'escape'));
    expect((await send(`${viewer.url}api/run?id=escape`)).status).toBe(404);
  });

  it('diffs two runs with the regression first', async () => {
    viewer = await startViewer({ root: fixtureRoot(), port: 0 });
    const res = await send(
      `${viewer.url}api/diff?before=baseline&after=${encodeURIComponent('nightly/2026-10-22')}&k=3`,
    );
    expect(res.status).toBe(200);
    const diff = json(res.body) as {
      regressions: number;
      tasks: { taskId: string; kind: string }[];
    };
    expect(diff.regressions).toBe(1);
    expect(diff.tasks[0]).toMatchObject({ taskId: 'task-1', kind: 'regression' });
    expect(diff.tasks.find((t) => t.taskId === 'task-2')?.kind).toBe('new');
  });

  it('writes labels only on a guarded JSON POST', async () => {
    const root = fixtureRoot();
    viewer = await startViewer({ root, port: 0 });
    const file = join(root, 'labels.yaml');
    const body = JSON.stringify({ labels: [label({ labeller: 'dk', note: 'cites the file' })] });
    const url = `${viewer.url}api/labels`;

    const noHeader = await send(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    expect(noHeader.status).toBe(403);
    const wrongType = await send(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'X-Agent-Evals': '1' },
      body,
    });
    expect(wrongType.status).toBe(415);
    const foreignOrigin = await send(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-Evals': '1',
        Origin: 'http://evil.example',
      },
      body,
    });
    expect(foreignOrigin.status).toBe(403);
    const tooBig = await send(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Evals': '1' },
      body: JSON.stringify({ labels: [label({ note: 'x'.repeat(70_000) })] }),
    });
    expect(tooBig.status).toBe(413);
    const invalid = await send(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Evals': '1' },
      body: JSON.stringify({ labels: [label({ label: 'maybe' as never })] }),
    });
    expect(invalid.status).toBe(400);
    expect(existsSync(file)).toBe(false);

    const ok = await send(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Agent-Evals': '1' },
      body,
    });
    expect(ok.status).toBe(200);
    expect(loadLabels(file)).toEqual([label({ labeller: 'dk', note: 'cites the file' })]);

    const listed = json((await send(url)).body) as { labels: HumanLabel[] };
    expect(listed.labels).toHaveLength(1);

    const removed = await send(url, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Evals': '1' },
      body: JSON.stringify(label()),
    });
    expect(removed.status).toBe(200);
    expect(loadLabels(file)).toEqual([]);
  });

  it('writes to the labels file it is given', async () => {
    const root = fixtureRoot();
    const file = join(tempDir(), 'calibration', 'labels.yaml');
    viewer = await startViewer({ root, labelsFile: file, port: 0 });
    const res = await send(`${viewer.url}api/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Evals': '1' },
      body: JSON.stringify([label()]),
    });
    expect(res.status).toBe(200);
    expect(loadLabels(file)).toEqual([label()]);
  });

  it('answers a foreign Host header with 403 (DNS rebinding)', async () => {
    viewer = await startViewer({ root: fixtureRoot(), port: 0 });
    const port = new URL(viewer.url).port;
    expect(
      (await send(`${viewer.url}api/runs`, { headers: { Host: 'evil.example' } })).status,
    ).toBe(403);
    expect(
      (await send(`${viewer.url}api/runs`, { headers: { Host: `evil.example:${port}` } })).status,
    ).toBe(403);
    expect(
      (await send(`${viewer.url}api/runs`, { headers: { Host: `localhost:${port}` } })).status,
    ).toBe(200);
  });

  it('answers unknown paths with 404 and other methods with 405', async () => {
    viewer = await startViewer({ root: fixtureRoot(), port: 0 });
    expect((await send(`${viewer.url}api/nothing`)).status).toBe(404);
    expect((await send(`${viewer.url}api/runs`, { method: 'PUT' })).status).toBe(405);
  });

  it('serves a run folder that is the root itself', async () => {
    const root = tempDir();
    mkdirSync(root, { recursive: true });
    writeReports(runResult(trialsOf(1, 1)), root);
    viewer = await startViewer({ root, port: 0 });
    const runs = json((await send(`${viewer.url}api/runs`)).body) as { id: string }[];
    expect(runs.map((r) => r.id)).toEqual(['.']);
    expect((await send(`${viewer.url}api/run?id=.`)).status).toBe(200);
  });
});
