import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { EvalFileError, loadSuite, parseTasks, readDataFile } from '../src/core/loader.ts';
import { jsonSchemas } from '../src/core/schema.ts';
import { builtinGraders } from '../src/graders/builtin.ts';
import { validateSuite } from '../src/harness/validate.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function suiteDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-evals-suite-'));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

describe('the package core', () => {
  it('imports nothing outside the package but node builtins, zod and yaml', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith('.ts')) files.push(path);
      }
    };
    walk(join(root, 'src'));
    const offending = files.flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)]
        .map((m) => m[1]!)
        .filter((spec) =>
          spec.startsWith('.')
            ? !resolve(dirname(file), spec).startsWith(join(root, 'src'))
            : !/^(node:|zod$|yaml$)/.test(spec),
        )
        .map((spec) => `${relative(root, file)}: ${spec}`),
    );
    expect(offending).toEqual([]);
  });

  it('keeps the JSON Schemas in schema/ in step with the zod schema', () => {
    const schemas = jsonSchemas();
    for (const name of ['task', 'suite'] as const) {
      const file = JSON.parse(
        readFileSync(join(root, 'schema', `${name}.schema.json`), 'utf8'),
      ) as unknown;
      expect(file, `schema/${name}.schema.json is stale: run npm run schema`).toEqual(
        JSON.parse(JSON.stringify(schemas[name])),
      );
    }
  });
});

describe('loadSuite', () => {
  it('loads the suite file and every task file of its folders, in name order', () => {
    const dir = suiteDir({
      'suite.yaml':
        'name: demo\nkind: regression\nowner: evals\ndefaults:\n  graders: [{ type: no_error }]\n',
      'tasks/b.yaml': 'id: b\ninput: { turns: [hi] }\ngraders: []\n',
      'tasks/a.json': JSON.stringify([
        { id: 'a1', input: { turns: ['x'] }, graders: [] },
        { id: 'a2', input: { turns: ['y'] }, graders: [] },
      ]),
      'tasks/notes.txt': 'ignored',
    });
    const suite = loadSuite(join(dir, 'suite.yaml'));
    expect(suite).toMatchObject({ name: 'demo', kind: 'regression', owner: 'evals', dir });
    expect(suite.tasks.map((t) => [t.id, t.file])).toEqual([
      ['a1', join('tasks', 'a.json')],
      ['a2', join('tasks', 'a.json')],
      ['b', join('tasks', 'b.yaml')],
    ]);
  });

  it('names every problem with its file: unknown fields, missing input, duplicate ids', () => {
    const dir = suiteDir({
      'suite.yaml': 'name: demo\nkind: regression\n',
      'tasks/a.yaml': 'id: a\ninput: { turns: [hi] }\ngraders: []\n',
      'tasks/b.yaml': 'id: a\ninput: { turns: [hi] }\ngraders: []\n',
      'tasks/c.yaml': 'id: C!\ninput: {}\ngraders: []\nextra: 1\n',
    });
    let message = '';
    try {
      loadSuite(join(dir, 'suite.yaml'));
    } catch (error) {
      expect(error).toBeInstanceOf(EvalFileError);
      message = (error as Error).message;
    }
    expect(message).toMatch(/tasks\/b\.yaml: the id a is taken by tasks\/a\.yaml/);
    expect(message).toMatch(/tasks\/c\.yaml: id: lower case/);
    expect(message).toMatch(/tasks\/c\.yaml: input: a task needs turns or a simulated user/);
    expect(message).toMatch(/tasks\/c\.yaml: .*extra/);
  });

  it('refuses a suite of an unknown kind', () => {
    const dir = suiteDir({ 'suite.yaml': 'name: demo\nkind: smoke\n' });
    expect(() => loadSuite(join(dir, 'suite.yaml'))).toThrow(/kind/);
  });
});

describe('validateSuite', () => {
  it('fails a task without a reference, with an unknown grader, or whose reference fails its graders', async () => {
    const tasks = parseTasks([
      {
        id: 'ok',
        input: { turns: ['q'] },
        graders: [{ type: 'facts', facts: ['42'] }],
        reference: { transcript: [{ type: 'message', role: 'assistant', text: 'It is 42.' }] },
      },
      { id: 'no-reference', input: { turns: ['q'] }, graders: [{ type: 'facts', facts: ['42'] }] },
      {
        id: 'unfair',
        input: { turns: ['q'] },
        graders: [{ type: 'facts', facts: ['43'] }, { type: 'nonsense' }],
        reference: { transcript: [{ type: 'message', role: 'assistant', text: 'It is 42.' }] },
      },
      {
        id: 'judged',
        input: { turns: ['q'] },
        graders: [
          {
            type: 'judge',
            rubric: [{ name: 'helpful', question: 'Helpful?', pass: 'yes', fail: 'no' }],
          },
        ],
        reference: { transcript: [{ type: 'message', role: 'assistant', text: 'It is 42.' }] },
      },
    ]);
    const check = await validateSuite(
      { name: 's', kind: 'capability', tasks },
      { graders: builtinGraders() },
    );
    expect(check.ok).toBe(false);
    expect(Object.fromEntries(check.tasks.map((t) => [t.taskId, t.ok]))).toEqual({
      ok: true,
      'no-reference': false,
      unfair: false,
      judged: true,
    });
    expect(check.tasks.find((t) => t.taskId === 'unfair')!.problems.join('\n')).toMatch(
      /unknown grader type nonsense/,
    );
    expect(check.skippedModelGraders).toBe(1);
  });
});

describe('the report-to-task template', () => {
  it('is a valid task file, so a copy starts from a file the loader takes', () => {
    const [task] = parseTasks(readDataFile(join(root, 'templates', 'task-from-report.yaml')));
    expect(task!.tags).toEqual(['from-report']);
    expect(task!.graders.find((g) => g.required)).toMatchObject({ type: 'tool_not_called' });
  });
});
