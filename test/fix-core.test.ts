import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { EvalFileError, defineSuite, loadSuite } from '../src/core/loader.ts';
import { taskSchema } from '../src/core/schema.ts';
import { toolUses } from '../src/core/transcript.ts';
import type { ReferenceSolution, Suite } from '../src/core/types.ts';
import { builtinGraders } from '../src/graders/builtin.ts';
import { validateSuite } from '../src/harness/validate.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function suiteDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-evals-fix-core-'));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

function errorOf(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a throw');
}

const reference: ReferenceSolution = {
  transcript: [{ type: 'message', role: 'assistant', text: 'It is 42.' }],
};

describe('F2: duplicate grader ids', () => {
  it('the loader refuses an explicit id that equals an unnamed grader of the same type', () => {
    const dir = suiteDir({
      'suite.yaml': 'name: demo\nkind: regression\n',
      'tasks/a.yaml':
        'id: a\ninput: { turns: [hi] }\ngraders:\n  - { type: facts, facts: ["1"] }\n  - { type: facts, id: facts, facts: ["2"] }\n',
    });
    const error = errorOf(() => loadSuite(join(dir, 'suite.yaml')));
    expect(error).toBeInstanceOf(EvalFileError);
    expect(error.message).toMatch(/tasks\/a\.yaml: task a: the grader id facts is used twice/);
  });

  it("counts the suite's default graders, and defineSuite refuses them too", () => {
    const error = errorOf(() =>
      defineSuite({
        name: 's',
        kind: 'regression',
        defaults: { graders: [{ type: 'no_error' }] },
        tasks: [
          { id: 'ok', input: { turns: ['x'] }, graders: [{ type: 'facts', facts: ['1'] }] },
          { id: 'dup', input: { turns: ['x'] }, graders: [{ type: 'facts', id: 'no_error' }] },
        ],
      }),
    );
    expect(error).toBeInstanceOf(EvalFileError);
    expect(error.message).toMatch(/s\[1\]: task dup: the grader id no_error is used twice/);
    expect(error.message).not.toMatch(/task ok/);
  });

  it('validate reports duplicate ids of a suite built by hand', async () => {
    const suite: Suite = {
      name: 's',
      kind: 'regression',
      tasks: [
        {
          id: 'dup',
          input: { turns: ['q'] },
          graders: [
            { type: 'facts', facts: ['42'] },
            { type: 'facts', id: 'facts#2', facts: ['42'] },
            { type: 'facts', facts: ['42'] },
          ],
          reference,
        },
      ],
    };
    const check = await validateSuite(suite, { graders: builtinGraders() });
    expect(check.tasks[0]!.ok).toBe(false);
    expect(check.tasks[0]!.problems).toContain('the grader id facts#2 is used twice');
  });
});

describe('F8: a missing tasks path', () => {
  it('names the suite file and the path, with the other problems', () => {
    const dir = suiteDir({
      'suite.yaml': 'name: demo\nkind: regression\ntasks: [tasks, missing, gone.yaml]\n',
      'tasks/a.yaml': 'id: A!\ninput: { turns: [hi] }\ngraders: [{ type: no_error }]\n',
    });
    const error = errorOf(() => loadSuite(join(dir, 'suite.yaml')));
    expect(error).toBeInstanceOf(EvalFileError);
    expect(error.message).toMatch(/suite\.yaml: tasks: missing does not exist/);
    expect(error.message).toMatch(/suite\.yaml: tasks: gone\.yaml does not exist/);
    expect(error.message).toMatch(/tasks\/a\.yaml: id: lower case/);
    expect(error.message).not.toMatch(/ENOENT/);
  });

  it('names the default tasks folder when it is missing', () => {
    const dir = suiteDir({ 'suite.yaml': 'name: demo\nkind: regression\n' });
    const error = errorOf(() => loadSuite(join(dir, 'suite.yaml')));
    expect(error).toBeInstanceOf(EvalFileError);
    expect(error.message).toMatch(/suite\.yaml: tasks: tasks does not exist/);
  });
});

describe('F10: the last tool result wins', () => {
  it('a later result without an error clears an earlier error', () => {
    const uses = toolUses([
      { type: 'tool_call', at: 1, id: 'c1', name: 'get', args: {} },
      { type: 'tool_result', at: 2, id: 'c1', name: 'get', result: null, error: 'timeout' },
      { type: 'tool_result', at: 3, id: 'c1', name: 'get', result: { ok: true } },
      { type: 'tool_call', at: 4, id: 'c2', name: 'get', args: {} },
      { type: 'tool_result', at: 5, id: 'c2', name: 'get', result: 1 },
      { type: 'tool_result', at: 6, id: 'c2', name: 'get', result: null, error: 'gone' },
    ]);
    expect(uses[0]).toEqual({ id: 'c1', name: 'get', args: {}, at: 1, result: { ok: true } });
    expect(uses[1]).toMatchObject({ result: null, error: 'gone' });
  });
});

describe('F19: a task needs at least one grader, counting the suite defaults', () => {
  it('the loader refuses a task without graders in a suite without default graders', () => {
    const dir = suiteDir({
      'suite.yaml': 'name: demo\nkind: regression\n',
      'tasks/a.yaml': 'id: a\ninput: { turns: [hi] }\ngraders: []\n',
    });
    const error = errorOf(() => loadSuite(join(dir, 'suite.yaml')));
    expect(error).toBeInstanceOf(EvalFileError);
    expect(error.message).toMatch(/tasks\/a\.yaml: task a: graders: the task has no grader/);
  });

  it("accepts graders: [] when the suite's defaults supply one", () => {
    const dir = suiteDir({
      'suite.yaml': 'name: demo\nkind: regression\ndefaults:\n  graders: [{ type: no_error }]\n',
      'tasks/a.yaml': 'id: a\ninput: { turns: [hi] }\ngraders: []\n',
    });
    expect(loadSuite(join(dir, 'suite.yaml')).tasks.map((t) => t.id)).toEqual(['a']);
    expect(taskSchema.safeParse({ id: 'a', input: { turns: ['x'] }, graders: [] }).success).toBe(
      true,
    );
  });

  it('defineSuite refuses it too', () => {
    const error = errorOf(() =>
      defineSuite({
        name: 's',
        kind: 'capability',
        tasks: [{ id: 'a', input: { turns: ['x'] }, graders: [] }],
      }),
    );
    expect(error).toBeInstanceOf(EvalFileError);
    expect(error.message).toMatch(/s\[0\]: task a: graders: the task has no grader/);
  });
});

describe('review S2: mock tool when paths', () => {
  it("refuses a mock tool's malformed when path at load time, naming the task and the tool", async () => {
    const { defineSuite: define } = await import('../src/core/loader.ts');
    expect(() =>
      define({
        name: 's',
        kind: 'regression',
        defaults: {
          context: {
            tools: [{ name: 'get_invoice', responses: [{ when: { 'a[0]b': 1 }, result: 1 }] }],
          },
        },
        tasks: [{ id: 't', input: { turns: ['q'] }, graders: [{ type: 'no_error' }] }],
      }),
    ).toThrow(/task t: mock tool get_invoice, response 0: invalid path "a\[0\]b"/);
  });
});
