import type { ChatClient, GraderResult, RunResult, Suite } from '../core/types.ts';
import {
  gradersOf,
  gradeTrial,
  scoreOf,
  scoringOf,
  type GraderRegistry,
} from '../graders/grade.ts';
import { checkToolResultMaxChars, judgeFailure } from '../graders/judge.ts';

/**
 * Grades a run's stored transcripts and outcomes again with the suites' current tasks and graders, without calling the
 * agent: after a grader or a task was found unfair while reading transcripts, the scores are fixed before anyone trusts
 * them. Without a judge the model graders' earlier results are kept. A trial whose task is gone keeps its grades. A trial
 * whose grading failed (`gradingError`) is graded again when a judge is given; a judge that fails again leaves it
 * ungraded with the new error.
 */
export async function regradeRun(
  run: RunResult,
  options: {
    suites: Suite[];
    graders: GraderRegistry;
    judge?: ChatClient;
    judgeModels?: string[];
    judgeToolResultMaxChars?: number;
  },
): Promise<RunResult> {
  checkToolResultMaxChars(options.judgeToolResultMaxChars, 'judgeToolResultMaxChars');
  const trials = [];
  for (const trial of run.trials) {
    const suite = options.suites.find((s) => s.name === trial.suite);
    const task = suite?.tasks.find((t) => t.id === trial.taskId);
    // Without a judge, a trial whose judge failed still lacks the judge's verdict.
    const stillUngraded = !options.judge && trial.gradingError !== undefined;
    if (!suite || !task || trial.status === 'infra_error' || stillUngraded) {
      trials.push(trial);
      continue;
    }
    const { ungraded: _before, gradingError: _failed, ...rest } = trial;
    let grades: GraderResult[];
    try {
      grades = await gradeTrial(task, trial.transcript, trial.outcome, {
        graders: options.graders,
        suite,
        target: trial.target,
        judge: options.judge,
        judgeModels: options.judgeModels,
        judgeToolResultMaxChars: options.judgeToolResultMaxChars,
        skipModelGraders: !options.judge,
      });
    } catch (error) {
      // The judge stayed down: the trial is ungraded, as in a run.
      trials.push({
        ...rest,
        grades: [],
        ungraded: true,
        gradingError: judgeFailure(error),
        score: 0,
        passed: false,
      });
      continue;
    }
    if (!options.judge) {
      // Keep the judge's earlier verdicts in the task's order of graders.
      const kept = trial.grades.filter((g) => options.graders.get(g.type)?.kind === 'model');
      grades = [...grades, ...kept];
    }
    const { score, passed } = scoreOf(grades, scoringOf(task, suite));
    const ungraded = grades.length === 0 && gradersOf(task, suite).length > 0;
    trials.push({
      ...rest,
      grades,
      ...(ungraded ? { ungraded } : {}),
      score: trial.status === 'completed' && !ungraded ? score : 0,
      passed: trial.status === 'completed' && !ungraded && passed,
    });
  }
  return { ...run, trials, meta: { ...run.meta, regradedAt: new Date().toISOString() } };
}
