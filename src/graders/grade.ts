import { answerOf } from '../core/transcript.ts';
import type {
  Assertion,
  ChatClient,
  Grader,
  GraderOutput,
  GraderResult,
  GraderSpec,
  Scoring,
  Suite,
  Task,
  Transcript,
} from '../core/types.ts';

/** The graders a run knows, by type: the built-in ones and a project's own. */
export type GraderRegistry = Map<string, Grader>;

export function registry(...graders: Grader[][]): GraderRegistry {
  return new Map(graders.flat().map((grader) => [grader.type, grader]));
}

/** The suite's default graders, then the task's own; an id defaults to the type (`type#2` for the second). */
export function gradersOf(
  task: Task,
  suite?: Pick<Suite, 'defaults'>,
): (GraderSpec & { id: string })[] {
  const specs = [...(suite?.defaults?.graders ?? []), ...task.graders];
  const seen = new Map<string, number>();
  return specs.map((spec) => {
    if (spec.id) return { ...spec, id: spec.id };
    const n = (seen.get(spec.type) ?? 0) + 1;
    seen.set(spec.type, n);
    return { ...spec, id: n === 1 ? spec.type : `${spec.type}#${n}` };
  });
}

/** The grader ids that occur more than once in a task, the suite's default graders counted. */
export function duplicateGraderIds(task: Task, suite?: Pick<Suite, 'defaults'>): string[] {
  const counts = new Map<string, number>();
  for (const { id } of gradersOf(task, suite)) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...counts].filter(([, n]) => n > 1).map(([id]) => id);
}

export interface GradeOptions {
  graders: GraderRegistry;
  suite?: Suite;
  target?: string;
  judge?: ChatClient;
  judgeModels?: string[];
  /** How much of each tool result a judge sees, unless its grader says otherwise (default 600). */
  judgeToolResultMaxChars?: number;
  /** Skip the model graders (a reference check without a judge): they are left out of the score. */
  skipModelGraders?: boolean;
}

/** Runs every grader of the task on one trial. A grader that throws fails with a grader error, never an agent error. */
export async function gradeTrial(
  task: Task,
  transcript: Transcript,
  outcome: unknown,
  options: GradeOptions,
): Promise<GraderResult[]> {
  const { answer, finalAnswer } = answerOf(transcript);
  const context = {
    task,
    transcript,
    outcome,
    answer,
    finalAnswer,
    target: options.target ?? '',
    judge: options.judge,
    judgeModels: options.judgeModels,
    judgeToolResultMaxChars: options.judgeToolResultMaxChars,
  };
  const results: GraderResult[] = [];
  for (const spec of gradersOf(task, options.suite)) {
    const base = {
      id: spec.id,
      type: spec.type,
      weight: spec.weight ?? 1,
      required: spec.required ?? false,
    };
    const grader = options.graders.get(spec.type);
    if (!grader) {
      results.push({
        ...base,
        score: 0,
        passed: false,
        assertions: [],
        error: `unknown grader type ${spec.type}`,
      });
      continue;
    }
    if (grader.kind === 'model' && options.skipModelGraders) continue;
    try {
      const output = await grader.grade(context, spec);
      results.push({ ...output, ...base, ...verdictOf(output, spec, base.weight) });
    } catch (error) {
      // A judge that couldn't be reached is the eval's failure: the harness counts the trial as an infrastructure error.
      if (error instanceof Error && error.name === 'InfraError') throw error;
      results.push({
        ...base,
        score: 0,
        passed: false,
        assertions: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

/**
 * A grader's verdict from its output. An unknown output fails, unless the spec says `onUnknown: ignore`: then the
 * assertions marked `unknown` are set aside and the decided ones give the verdict and the score. When nothing is left to
 * decide (every assertion unknown, or the output is unknown without marking which), the whole grader is set aside: it
 * passes with weight 0.
 */
function verdictOf(
  output: GraderOutput,
  spec: GraderSpec,
  weight: number,
): { score: number; passed: boolean; unknown: boolean; weight: number } {
  const share = (assertions: Assertion[]): number =>
    assertions.length === 0 ? 1 : assertions.filter((a) => a.passed).length / assertions.length;
  const unknown = output.unknown === true || output.assertions.some((a) => a.unknown === true);
  const allPassed = output.assertions.every((a) => a.passed);
  if (!unknown)
    return { score: output.score ?? share(output.assertions), passed: allPassed, unknown, weight };
  if (spec.onUnknown !== 'ignore')
    return { score: output.score ?? share(output.assertions), passed: false, unknown, weight };
  const decided = output.assertions.filter((a) => a.unknown !== true);
  if (decided.length === 0 || decided.length === output.assertions.length)
    return { score: output.score ?? share(output.assertions), passed: true, unknown, weight: 0 };
  return {
    score: share(decided),
    passed: decided.every((a) => a.passed),
    unknown,
    weight,
  };
}

/** The task's verdict and its partial credit (the weighted mean of the grader scores). */
export function scoreOf(
  results: GraderResult[],
  scoring: Scoring = { mode: 'binary' },
): { score: number; passed: boolean } {
  const weight = results.reduce((sum, r) => sum + r.weight, 0);
  const score =
    weight === 0
      ? results.every((r) => r.passed)
        ? 1
        : 0
      : results.reduce((sum, r) => sum + r.weight * r.score, 0) / weight;
  const threshold = scoring.threshold ?? 1;
  const rounded = Number(score.toFixed(6));
  if (scoring.mode === 'binary') return { score: rounded, passed: results.every((r) => r.passed) };
  if (scoring.mode === 'weighted') return { score: rounded, passed: rounded >= threshold };
  return {
    score: rounded,
    passed: results.filter((r) => r.required).every((r) => r.passed) && rounded >= threshold,
  };
}

export function scoringOf(task: Task, suite?: Suite): Scoring {
  return task.scoring ?? suite?.defaults?.scoring ?? { mode: 'binary' };
}
