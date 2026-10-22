import { randomBytes } from 'node:crypto';
import { readdirSync, realpathSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { HumanLabel, RunResult } from '../core/types.ts';
import { diffRuns } from '../metrics/diff.ts';
import { summarize } from '../metrics/stats.ts';
import { readRun } from '../report/write.ts';
import { LabelValidationError, readLabelsFile, removeLabel, upsertLabels } from './labels-store.ts';
import { viewerPage } from './page.ts';

/**
 * The local results viewer: a developer tool over a results folder, not part of any product. It binds 127.0.0.1 only,
 * checks the Host header against DNS rebinding and needs a custom header on writes, since any page the developer
 * opens can send requests to localhost.
 */

export interface ViewerOptions {
  /** The results folder: run folders (each holding a run.json) up to three levels below it. */
  root: string;
  /** The labels file the judge calibration reads (default `<root>/labels.yaml`). */
  labelsFile?: string;
  /** 0 or left out picks a free port. */
  port?: number;
  /** Only 127.0.0.1: the viewer serves transcripts and writes files, so it never listens on a network. */
  host?: '127.0.0.1';
  /** The k of pass@k and pass^k (default 3). */
  k?: number;
}

export interface Viewer {
  url: string;
  port: number;
  labelsFile: string;
  close(): Promise<void>;
}

/** One run folder in the run list: the headline numbers, never the transcripts. */
export interface RunListEntry {
  id: string;
  runId?: string;
  startedAt?: string;
  finishedAt?: string;
  targets: string[];
  suites: { name: string; kind: string }[];
  trials: number;
  /** The mean pass@1 over every task and target. */
  pass1: number | null;
  groups: { suite: string; target: string; pass1: number | null; passHatK: number | null }[];
  /** The folder's run.json couldn't be read. */
  error?: string;
}

const HOST = '127.0.0.1';
const MAX_BODY = 64 * 1024;
const MAX_DEPTH = 3;
const SKIP_DIRS = new Set(['node_modules', 'transcripts']);

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const isInside = (dir: string, root: string) => dir === root || dir.startsWith(root + sep);

/** The run folders under the root, as ids relative to it (`.` for the root itself). */
function findRunDirs(root: string, k: number): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.name === 'run.json' && entry.isFile())) found.push(dir);
    if (depth >= k) return;
    // Dirent.isDirectory is false for a symlink, so the walk never leaves the root.
    for (const entry of entries)
      if (entry.isDirectory() && !entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name))
        walk(join(dir, entry.name), depth + 1);
  };
  walk(root, 0);
  return found;
}

const toId = (root: string, dir: string) => relative(root, dir).split(sep).join('/') || '.';

const mean = (values: number[]) =>
  values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;

function listEntry(id: string, run: RunResult, k: number): RunListEntry {
  const summary = summarize(run, { k });
  return {
    id,
    runId: run.id,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    targets: run.targets.map((target) => target.name),
    suites: run.suites.map((suite) => ({ name: suite.name, kind: suite.kind })),
    trials: run.trials.length,
    pass1: mean(summary.tasks.flatMap((task) => (task.pass1 === null ? [] : [task.pass1]))),
    groups: summary.groups.map((group) => ({
      suite: group.suite,
      target: group.target,
      pass1: group.pass1,
      passHatK: group.passHatK,
    })),
  };
}

function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name];
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY) chunks.push(chunk);
      // Past the limit the rest is drained, so the client gets the 413 instead of a reset; a flood is cut off.
      else if (size > 16 * MAX_BODY) req.destroy();
    });
    req.on('end', () => {
      if (size > MAX_BODY) reject(new HttpError(413, `the body exceeds ${MAX_BODY} bytes`));
      else resolveBody(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, 'the body is not JSON');
  }
}

function intParam(params: URLSearchParams, name: string, fallback: number, max: number): number {
  const raw = params.get(name);
  if (raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max)
    throw new HttpError(400, `${name} must be an integer from 1 to ${max}`);
  return value;
}

function send(
  res: ServerResponse,
  status: number,
  type: string,
  body: string,
  extra: Record<string, string> = {},
) {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Resource-Policy': 'same-origin',
    ...extra,
  });
  res.end(body);
}

const sendJson = (res: ServerResponse, status: number, value: unknown) =>
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(value));

/** Starts the viewer on 127.0.0.1. */
export async function startViewer(options: ViewerOptions): Promise<Viewer> {
  if (options.host !== undefined && (options.host as string) !== HOST)
    throw new Error(`the viewer binds ${HOST} only, not ${String(options.host)}`);
  let root: string;
  try {
    root = realpathSync(resolve(options.root));
  } catch {
    throw new Error(`${options.root}: no such folder`);
  }
  if (!statSync(root).isDirectory()) throw new Error(`${options.root}: not a folder`);
  const labelsFile = resolve(options.labelsFile ?? join(root, 'labels.yaml'));
  const defaultK = options.k ?? 3;
  let port = 0;

  /** The run.json of an id, strictly inside the root: 400 for a malformed id, 404 for anything not found there. */
  function runFile(id: string | null): string {
    if (!id) throw new HttpError(400, 'id is missing');
    if (
      id.includes('\0') ||
      isAbsolute(id) ||
      /^[a-zA-Z]:/.test(id) ||
      id.split(/[\\/]/).includes('..')
    )
      throw new HttpError(400, 'the id must be a folder inside the results folder');
    let file: string;
    try {
      file = realpathSync(join(root, id, 'run.json'));
    } catch {
      throw new HttpError(404, `no run ${id}`);
    }
    // realpath resolves every symlink on the way, so a link out of the root ends here.
    if (!isInside(file, root) || !statSync(file).isFile()) throw new HttpError(404, `no run ${id}`);
    return file;
  }

  function loadRun(id: string | null): RunResult {
    const file = runFile(id);
    try {
      return readRun(file);
    } catch (error) {
      throw new HttpError(422, error instanceof Error ? error.message : String(error));
    }
  }

  function listRuns(k: number): RunListEntry[] {
    const entries = findRunDirs(root, MAX_DEPTH).map((dir): RunListEntry => {
      const id = toId(root, dir);
      try {
        return listEntry(id, readRun(dir), k);
      } catch (error) {
        return {
          id,
          targets: [],
          suites: [],
          trials: 0,
          pass1: null,
          groups: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });
    // Newest first; folders that couldn't be read last.
    return entries.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
  }

  function guardWrite(req: IncomingMessage): void {
    // A custom header makes a cross-site request a preflighted one, which the viewer never allows.
    if (header(req, 'x-agent-evals') !== '1')
      throw new HttpError(403, 'the X-Agent-Evals header is missing');
    const origin = header(req, 'origin');
    if (origin && origin !== `http://${HOST}:${port}` && origin !== `http://localhost:${port}`)
      throw new HttpError(403, 'foreign origin');
    if (!/^application\/json\s*(;|$)/i.test(header(req, 'content-type')))
      throw new HttpError(415, 'the body must be application/json');
  }

  async function labelsBody(req: IncomingMessage): Promise<unknown> {
    guardWrite(req);
    return parseJson(await readBody(req));
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // DNS rebinding: a foreign name that resolves to 127.0.0.1 still carries its own Host header.
    const host = header(req, 'host').toLowerCase();
    if (host !== `${HOST}:${port}` && host !== `localhost:${port}`)
      throw new HttpError(403, 'foreign host');

    const url = new URL(req.url ?? '/', `http://${HOST}:${port}`);
    const method = req.method ?? 'GET';
    const allow = (methods: string[]) => {
      if (!methods.includes(method)) throw new HttpError(405, `${method} not allowed`);
    };

    switch (url.pathname) {
      case '/':
      case '/index.html': {
        allow(['GET']);
        const nonce = randomBytes(16).toString('base64');
        const csp = [
          "default-src 'none'",
          `script-src 'nonce-${nonce}'`,
          `style-src 'nonce-${nonce}'`,
          "connect-src 'self'",
          "img-src 'self' data:",
          "base-uri 'none'",
          "form-action 'none'",
          "frame-ancestors 'none'",
        ].join('; ');
        send(res, 200, 'text/html; charset=utf-8', viewerPage(nonce, defaultK), {
          'Content-Security-Policy': csp,
        });
        return;
      }
      case '/api/runs': {
        allow(['GET']);
        sendJson(res, 200, listRuns(intParam(url.searchParams, 'k', defaultK, 50)));
        return;
      }
      case '/api/run': {
        allow(['GET']);
        const k = intParam(url.searchParams, 'k', defaultK, 50);
        const id = url.searchParams.get('id');
        const run = loadRun(id);
        sendJson(res, 200, { id, run, summary: summarize(run, { k }) });
        return;
      }
      case '/api/diff': {
        allow(['GET']);
        const k = intParam(url.searchParams, 'k', defaultK, 50);
        const before = loadRun(url.searchParams.get('before'));
        const after = loadRun(url.searchParams.get('after'));
        const rawDrop = url.searchParams.get('minDrop');
        const minDrop = rawDrop === null || rawDrop === '' ? undefined : Number(rawDrop);
        if (minDrop !== undefined && !(minDrop > 0 && minDrop <= 1))
          throw new HttpError(400, 'minDrop must be in (0, 1]');
        sendJson(res, 200, diffRuns(before, after, { k, minDrop }));
        return;
      }
      case '/api/labels': {
        allow(['GET', 'POST', 'DELETE']);
        if (method === 'GET') {
          sendJson(res, 200, { file: labelsFile, labels: readLabelsFile(labelsFile) });
          return;
        }
        const body = await labelsBody(req);
        if (method === 'POST') {
          // A list, `{ labels: [...] }` or one label.
          const list: unknown = Array.isArray(body)
            ? body
            : body !== null && typeof body === 'object' && 'labels' in body
              ? body.labels
              : [body];
          if (!Array.isArray(list)) throw new HttpError(400, 'labels must be a list');
          sendJson(res, 200, {
            file: labelsFile,
            labels: upsertLabels(labelsFile, list as HumanLabel[]),
          });
        } else {
          sendJson(res, 200, {
            file: labelsFile,
            labels: removeLabel(labelsFile, body as HumanLabel),
          });
        }
        return;
      }
      default:
        throw new HttpError(404, 'not found');
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      const status =
        error instanceof HttpError
          ? error.status
          : error instanceof LabelValidationError
            ? 400
            : 500;
      const message = error instanceof Error ? error.message : String(error);
      if (res.headersSent) res.destroy();
      else
        send(res, status, 'application/json; charset=utf-8', JSON.stringify({ error: message }), {
          // A refused body may still be in flight: close rather than read it.
          ...(status === 413 ? { Connection: 'close' } : {}),
        });
    });
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, HOST, () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  port = (server.address() as AddressInfo).port;

  return {
    url: `http://${HOST}:${port}/`,
    port,
    labelsFile,
    close: () =>
      new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
        // Keep-alive connections would hold close() open.
        server.closeAllConnections();
      }),
  };
}
