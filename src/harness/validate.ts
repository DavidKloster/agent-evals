import { completeTranscript } from '../core/transcript.ts';
import type { ChatClient, GraderResult, Suite } from '../core/types.ts';
import {
  duplicateGraderIds,
  gradersOf,
  gradeTrial,
  scoreOf,
  scoringOf,
  type GraderRegistry,
} from '../graders/grade.ts';
import { checkToolResultMaxChars } from '../graders/judge.ts';

export interface TaskCheck {
  taskId: string;
  ok: boolean;
  problems: string[];
  grades: GraderResult[];
}

export interface SuiteCheck {
  suite: string;
  ok: boolean;
  tasks: TaskCheck[];
  /** Model graders that weren't run because no judge was given. */
  skippedModelGraders: number;
}

/**
 * Checks that every task of a suite is solvable and its graders fair: each task names known graders, has a reference
 * solution, and its reference passes every grader. Without a judge the model graders are skipped (and counted), so the
 * check runs in CI.
 */
export async function validateSuite(
  suite: Suite,
  options: {
    graders: GraderRegistry;
    judge?: ChatClient;
    judgeModels?: string[];
    judgeToolResultMaxChars?: number;
  },
): Promise<SuiteCheck> {
  checkToolResultMaxChars(options.judgeToolResultMaxChars, 'judgeToolResultMaxChars');
  let skippedModelGraders = 0;
  const tasks: TaskCheck[] = [];
  for (const task of suite.tasks) {
    const problems: string[] = [];
    const specs = gradersOf(task, suite);
    if (specs.length === 0) problems.push('the task has no grader');
    for (const id of duplicateGraderIds(task, suite))
      problems.push(`the grader id ${id} is used twice`);
    for (const spec of specs) {
      const grader = options.graders.get(spec.type);
      if (!grader) problems.push(`${spec.id}: unknown grader type ${spec.type}`);
      else if (grader.kind === 'model' && !options.judge) skippedModelGraders++;
    }
    let grades: GraderResult[] = [];
    if (!task.reference) problems.push('the task has no reference solution');
    else {
      const transcript = completeTranscript(task.reference.transcript ?? []);
      grades = await gradeTrial(task, transcript, task.reference.outcome ?? null, {
        graders: options.graders,
        suite,
        judge: options.judge,
        judgeModels: options.judgeModels,
        judgeToolResultMaxChars: options.judgeToolResultMaxChars,
        skipModelGraders: !options.judge,
      });
      for (const grade of grades) {
        if (grade.error) problems.push(`${grade.id}: ${grade.error}`);
        else if (!grade.passed)
          problems.push(
            `${grade.id}: the reference fails ${grade.unknown ? '(unknown)' : ''}${grade.assertions
              .filter((a) => !a.passed)
              .map((a) => `${a.name}${a.message ? ` (${a.message})` : ''}`)
              .join('; ')}`,
          );
      }
      if (problems.length === 0 && !scoreOf(grades, scoringOf(task, suite)).passed)
        problems.push('the reference does not reach the scoring threshold');
    }
    tasks.push({ taskId: task.id, ok: problems.length === 0, problems, grades });
  }
  return { suite: suite.name, ok: tasks.every((t) => t.ok), tasks, skippedModelGraders };
}
