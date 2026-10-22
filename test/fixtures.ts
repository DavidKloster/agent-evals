import type {
  GraderResult,
  RunResult,
  SuiteKind,
  Transcript,
  TrialMetrics,
  TrialResult,
} from '../src/core/types.ts';

/**
 * Builders for results in tests: every field has a sane default, so a test states only what it is about.
 */

export type TrialInput = Partial<Omit<TrialResult, 'metrics'>> & {
  metrics?: Partial<TrialMetrics>;
};

export function metrics(partial: Partial<TrialMetrics> = {}): TrialMetrics {
  return {
    durationMs: 1000,
    ttftMs: [100],
    replyMs: [500],
    turns: 1,
    modelCalls: 1,
    toolCalls: 0,
    inputTokens: 100,
    outputTokens: 50,
    costUsd: 0.001,
    costComplete: true,
    ...partial,
  };
}

export function graderResult(partial: Partial<GraderResult> = {}): GraderResult {
  const passed = partial.passed ?? true;
  return {
    id: partial.type ?? 'check',
    type: 'check',
    assertions: [{ name: 'check', passed }],
    score: passed ? 1 : 0,
    passed,
    weight: 1,
    required: false,
    ...partial,
  };
}

/** A user question and the assistant's answer, one second apart. */
export function transcriptOf(
  question = 'Where is my invoice?',
  answer = 'It is in the inbox.',
): Transcript {
  return [
    { type: 'message', at: 1000, role: 'user', text: question },
    {
      type: 'model_call',
      at: 1100,
      model: 'model-a',
      startedAt: 1000,
      firstTokenAt: 1100,
      endedAt: 1500,
    },
    { type: 'message', at: 1500, role: 'assistant', text: answer },
  ];
}

export function trialResult(partial: TrialInput = {}): TrialResult {
  const status = partial.status ?? 'completed';
  const infra = status === 'infra_error';
  const passed = partial.passed ?? status === 'completed';
  const { metrics: metricsPartial, ...rest } = partial;
  return {
    suite: 'core',
    suiteKind: 'capability',
    taskId: 'task-1',
    target: 'model-a',
    trial: 0,
    status,
    attempts: infra ? 3 : 1,
    infraErrors: infra ? ['connection refused', 'connection refused', 'connection refused'] : [],
    error: status === 'completed' ? undefined : `${status}`,
    outcome: null,
    grades: infra ? [] : [graderResult({ passed })],
    score: passed ? 1 : 0,
    passed,
    metrics: metrics(metricsPartial),
    transcript: transcriptOf(),
    startedAt: '2026-10-22T10:00:00.000Z',
    ...rest,
  };
}

/** `n` trials of one task and target, the first `c` passing. */
export function trialsOf(n: number, c: number, partial: TrialInput = {}): TrialResult[] {
  return Array.from({ length: n }, (_, trial) =>
    trialResult({ ...partial, trial, passed: trial < c }),
  );
}

/** A run of the trials; its suites and targets come from the trials unless given. */
export function runResult(
  trials: TrialResult[],
  suites?: RunResult['suites'],
  partial: Partial<Omit<RunResult, 'trials' | 'suites'>> = {},
): RunResult {
  const derived = new Map<string, { name: string; kind: SuiteKind; tasks: string[] }>();
  const targets: string[] = [];
  for (const trial of trials) {
    let suite = derived.get(trial.suite);
    if (!suite) {
      suite = { name: trial.suite, kind: trial.suiteKind, tasks: [] };
      derived.set(trial.suite, suite);
    }
    if (!suite.tasks.includes(trial.taskId)) suite.tasks.push(trial.taskId);
    if (!targets.includes(trial.target)) targets.push(trial.target);
  }
  return {
    id: 'run-1',
    startedAt: '2026-10-22T10:00:00.000Z',
    finishedAt: '2026-10-22T10:05:00.000Z',
    targets: targets.map((name) => ({ name })),
    suites: suites ?? [...derived.values()],
    trials,
    ...partial,
  };
}
