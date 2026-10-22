import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';

import { parse } from 'yaml';
import type { z } from 'zod';

import { duplicateGraderIds, gradersOf } from '../graders/grade.ts';
import { checkToolResultMaxChars } from '../graders/judge.ts';
import { checkPaths } from '../graders/matchers.ts';
import { suiteSchema, taskSchema } from './schema.ts';
import type { Suite, Task } from './types.ts';

/** A suite or task file that doesn't match its format; the message names every problem with its file and path. */
export class EvalFileError extends Error {
  override name = 'EvalFileError';
}

const dataFile = /\.(ya?ml|json)$/i;

export function readDataFile(file: string): unknown {
  const text = readFileSync(file, 'utf8');
  return extname(file).toLowerCase() === '.json' ? JSON.parse(text) : parse(text);
}

function problems(file: string, error: z.ZodError): string[] {
  return error.issues.map(
    (issue) => `${file}: ${issue.path.join('.') || '(root)'}: ${issue.message}`,
  );
}

/** The tasks of one file: a task, or a list of tasks. */
export function parseTasks(data: unknown, file = '(inline)'): Task[] {
  const items = Array.isArray(data) ? data : [data];
  const errors: string[] = [];
  const tasks: Task[] = [];
  items.forEach((item, index) => {
    const parsed = taskSchema.safeParse(item);
    const where = Array.isArray(data) ? `${file}[${index}]` : file;
    if (parsed.success) tasks.push({ ...(parsed.data as Task), file });
    else errors.push(...problems(where, parsed.error));
  });
  if (errors.length) throw new EvalFileError(errors.join('\n'));
  return tasks;
}

function taskFiles(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isFile() && dataFile.test(entry.name))
    .map((entry) => join(path, entry.name))
    .sort();
}

/** Loads a suite file and its tasks; fails with every problem at once. */
export function loadSuite(file: string): Suite {
  const path = resolve(file);
  const parsed = suiteSchema.safeParse(readDataFile(path));
  if (!parsed.success) throw new EvalFileError(problems(file, parsed.error).join('\n'));
  const { tasks: taskPaths, ...rest } = parsed.data;
  const dir = dirname(path);
  // A context file holds what every task shares (the mock tools), so the task files stay short.
  const context = rest.defaults?.context;
  const suite = {
    ...rest,
    defaults: rest.defaults && {
      ...rest.defaults,
      context:
        typeof context === 'string'
          ? (readDataFile(resolve(dir, context)) as Record<string, unknown>)
          : context,
    },
  };
  const errors: string[] = [];
  const tasks: Task[] = [];
  for (const taskPath of taskPaths ?? ['tasks']) {
    if (!existsSync(resolve(dir, taskPath))) {
      errors.push(`${file}: tasks: ${taskPath} does not exist`);
      continue;
    }
    for (const taskFile of taskFiles(resolve(dir, taskPath))) {
      try {
        tasks.push(...parseTasks(readDataFile(taskFile), relative(dir, taskFile)));
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  }
  const merged = withDefaultContext(tasks, suite.defaults?.context);
  errors.push(...duplicateIds(tasks), ...graderProblems(tasks, suite), ...mockToolProblems(merged));
  if (errors.length) throw new EvalFileError(errors.join('\n'));
  return { ...suite, tasks: merged, dir };
}

/** Builds a suite in code, for tasks generated from another data set (a question list, a benchmark). */
export function defineSuite(suite: Omit<Suite, 'tasks'> & { tasks: unknown[] }): Suite {
  const tasks = suite.tasks.flatMap((task, index) => parseTasks(task, `${suite.name}[${index}]`));
  const merged = withDefaultContext(tasks, suite.defaults?.context);
  const errors = [
    ...duplicateIds(tasks),
    ...graderProblems(tasks, suite),
    ...mockToolProblems(merged),
  ];
  if (errors.length) throw new EvalFileError(errors.join('\n'));
  return { ...suite, tasks: merged };
}

/** The suite's default context under each task's own (a task's key wins). */
function withDefaultContext(tasks: Task[], context: Record<string, unknown> | undefined): Task[] {
  if (!context) return tasks;
  return tasks.map((task) => ({
    ...task,
    input: { ...task.input, context: { ...context, ...task.input.context } },
  }));
}

function duplicateIds(tasks: Task[]): string[] {
  const seen = new Map<string, string>();
  const errors: string[] = [];
  for (const task of tasks) {
    const first = seen.get(task.id);
    if (first !== undefined) errors.push(`${task.file}: the id ${task.id} is taken by ${first}`);
    else seen.set(task.id, task.file ?? '');
  }
  return errors;
}

/**
 * The paths of the mock tools' `when` matchers (`input.context.tools`, the suite's shared ones included): a bad path is
 * a mistake in the file, so it is refused here rather than failing each call as the agent's tool error.
 */
function mockToolProblems(tasks: Task[]): string[] {
  return tasks.flatMap((task) => {
    const tools = task.input.context?.tools;
    if (!Array.isArray(tools)) return [];
    return tools.flatMap((tool: { name?: unknown; responses?: { when?: unknown }[] }, t) =>
      (Array.isArray(tool?.responses) ? tool.responses : []).flatMap((response, r) => {
        if (!response?.when || typeof response.when !== 'object') return [];
        try {
          checkPaths(response.when as Record<string, unknown>);
          return [];
        } catch (error) {
          const name = typeof tool.name === 'string' ? tool.name : `#${t}`;
          return [
            `${task.file}: task ${task.id}: mock tool ${name}, response ${r}: ${error instanceof Error ? error.message : String(error)}`,
          ];
        }
      }),
    );
  });
}

/**
 * Each task needs a grader, the suite's default graders counted (a task without one would pass every trial), and its
 * grader ids must be unique (the reports and the labels name a grader by its id). A judge's `toolResultMaxChars` is
 * checked here too, so a typo shows at load and not only once a judge grades.
 */
function graderProblems(tasks: Task[], suite: Pick<Suite, 'defaults'>): string[] {
  return tasks.flatMap((task) => {
    const where = `${task.file}: task ${task.id}`;
    const specs = gradersOf(task, suite);
    if (specs.length === 0)
      return [`${where}: graders: the task has no grader and the suite no default graders`];
    const limits = specs.flatMap((spec) => {
      if (spec.type !== 'judge') return [];
      try {
        checkToolResultMaxChars(spec.toolResultMaxChars, `${where}: grader ${spec.id}`);
        return [];
      } catch (error) {
        return [error instanceof Error ? error.message : String(error)];
      }
    });
    return [
      ...duplicateGraderIds(task, suite).map((id) => `${where}: the grader id ${id} is used twice`),
      ...limits,
    ];
  });
}
