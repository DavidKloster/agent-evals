/**
 * The model of an eval, in the terms of Anthropic's "Demystifying evals for AI agents":
 * - a **task** is one test: its input and its success criteria (graders), with a reference solution that passes them;
 * - a **trial** is one attempt at a task by one **target** (an adapter with its options, such as a model);
 * - a **grader** scores one aspect of a trial through **assertions**;
 * - the **transcript** is the complete record of a trial: messages, model calls, tool calls, results and times;
 * - the **outcome** is the final state of the environment after the trial, read by the adapter, not what the agent claims;
 * - a **suite** is a set of tasks with one goal: a capability suite (a hill to climb) or a regression suite (near 100 %).
 * The evaluation harness is this package; the agent harness is what an adapter drives.
 */

export type Role = 'user' | 'assistant' | 'system';

/** Where a failure lies: the agent, the eval's infrastructure, a timeout, or a grader that broke. */
export type ErrorKind = 'agent' | 'infra' | 'timeout' | 'grader';

/** One event of a transcript. `at` is the wall-clock time in milliseconds since the epoch. */
export type TranscriptEvent =
  | {
      type: 'message';
      at: number;
      role: Role;
      text: string;
      /** For an assistant message: when its first token arrived. */
      firstTokenAt?: number;
    }
  | {
      type: 'model_call';
      at: number;
      model: string;
      provider?: string;
      startedAt: number;
      firstTokenAt?: number;
      endedAt: number;
      inputTokens?: number;
      outputTokens?: number;
      /** What the provider's usage says the call cost, in USD. */
      costUsd?: number;
      error?: string;
    }
  | { type: 'tool_call'; at: number; id: string; name: string; args: unknown }
  | { type: 'tool_result'; at: number; id: string; name: string; result: unknown; error?: string }
  | { type: 'error'; at: number; kind: ErrorKind; message: string }
  | { type: 'note'; at: number; text: string; data?: unknown };

export type Transcript = TranscriptEvent[];

/** The distributive form of Omit, so a union of events keeps its members. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An event as a task file or an adapter writes it: the time is optional and filled in by the recorder. */
export type TranscriptEventInput = DistributiveOmit<TranscriptEvent, 'at'> & { at?: number };

/** One grader of a task, as the task file names it: the grader's `type` and its parameters. */
export interface GraderSpec {
  type: string;
  /** Unique within the task; the type when left out (and `type#2` for the second one of a type). */
  id?: string;
  /** The grader's weight in a weighted or hybrid score (default 1). */
  weight?: number;
  /** In hybrid scoring, a required grader must pass whatever the weighted score. */
  required?: boolean;
  [param: string]: unknown;
}

/**
 * How a task's grader results become one verdict:
 * - `binary`: every grader passes;
 * - `weighted`: the weighted mean of the grader scores reaches `threshold`;
 * - `hybrid`: every `required` grader passes and the weighted mean reaches `threshold`.
 * The weighted mean is the partial credit and is reported in every mode.
 */
export interface Scoring {
  mode: 'binary' | 'weighted' | 'hybrid';
  threshold?: number;
}

/** A second model that plays the user of a conversational task, with a fixed persona and goal. */
export interface SimulatedUserSpec {
  persona: string;
  goal: string;
  /** The user's first message; the simulated user writes it when left out. */
  firstMessage?: string;
  /** The most user messages the conversation takes, the first one included (default 6). */
  maxTurns?: number;
}

export interface TaskInput {
  /** What the user types, one message per turn. */
  turns?: string[];
  /** A simulated user in place of fixed turns, or after them. */
  user?: SimulatedUserSpec;
  /** Anything the adapter needs for this task (the page to start on, who asks, the mock tools), passed through as is. */
  context?: Record<string, unknown>;
}

/** A solution that passes every grader: it proves the task is solvable and its graders fair. */
export interface ReferenceSolution {
  /** The transcript of a correct trial; the answer's messages and the tool calls the graders look at are enough. */
  transcript?: TranscriptEventInput[];
  /** The outcome a correct trial leaves. */
  outcome?: unknown;
}

export interface Task {
  id: string;
  description?: string;
  tags?: string[];
  input: TaskInput;
  graders: GraderSpec[];
  scoring?: Scoring;
  trials?: number;
  timeoutMs?: number;
  reference?: ReferenceSolution;
  /** Why the task exists: the issue, the failure it comes from. */
  source?: string;
  /** The file the task was loaded from. */
  file?: string;
}

export type SuiteKind = 'capability' | 'regression';

export interface Suite {
  name: string;
  kind: SuiteKind;
  description?: string;
  /** Who keeps the suite's tasks and graders up to date. */
  owner?: string;
  defaults?: {
    /** Graders every task of the suite gets in addition to its own. */
    graders?: GraderSpec[];
    scoring?: Scoring;
    trials?: number;
    timeoutMs?: number;
    /** Merged under every task's `input.context` (the mock tools all tasks share, the system prompt). */
    context?: Record<string, unknown>;
  };
  /** A capability suite whose pass@1 reaches the threshold is saturated: add harder tasks. */
  saturation?: { threshold: number };
  /** A task whose pass^k is 1 in each of the last `runs` runs is a candidate to move to the regression suite. */
  graduation?: { k: number; runs: number };
  tasks: Task[];
  /** The folder of the suite's file. */
  dir?: string;
}

export interface Assertion {
  name: string;
  passed: boolean;
  expected?: unknown;
  actual?: unknown;
  message?: string;
  /**
   * The grader couldn't decide this assertion (a judge's "unknown" dimension). With `onUnknown: ignore` only these are
   * set aside; the decided ones still count.
   */
  unknown?: true;
}

/** What a grader returns: its assertions, optionally its own score and an Unknown verdict. */
export interface GraderOutput {
  assertions: Assertion[];
  /** 0..1; the share of passed assertions when left out. */
  score?: number;
  /** The grader couldn't decide (a judge's "Unknown"). */
  unknown?: boolean;
  /** Anything worth keeping for the report: a judge's reasons, the raw verdicts. */
  details?: unknown;
}

export interface GraderResult extends GraderOutput {
  id: string;
  type: string;
  score: number;
  passed: boolean;
  weight: number;
  required: boolean;
  /** The grader threw: it counts as failed and is reported as a grader error, never as the agent's. */
  error?: string;
}

/** A chat client the model graders and the simulated user use. */
export interface ChatClient {
  complete(request: ChatRequest): Promise<ChatResponse>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Ask for a JSON object as the answer. */
  json?: boolean;
  signal?: AbortSignal;
}

export interface ChatResponse {
  text: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface GradeContext {
  task: Task;
  transcript: Transcript;
  outcome: unknown;
  /** Every assistant message of the trial, joined by blank lines. */
  answer: string;
  /** The last assistant message. */
  finalAnswer: string;
  target: string;
  /** The judge's chat client, for model graders. */
  judge?: ChatClient;
  /** The judge models to ask (several for a consensus). */
  judgeModels?: string[];
  /** How much of each tool result a judge sees, unless its grader says otherwise (the config's `judge.toolResultMaxChars`). */
  judgeToolResultMaxChars?: number;
}

export interface Grader<P extends GraderSpec = GraderSpec> {
  type: string;
  /** Model graders cost money and need a judge: `validate` grades a reference without them when no judge is set. */
  kind: 'code' | 'model' | 'human';
  grade(context: GradeContext, spec: P): GraderOutput | Promise<GraderOutput>;
}

/** What the harness hands an adapter for one trial. */
export interface TrialContext {
  suite: Suite;
  task: Task;
  target: string;
  /** 0-based index of the trial within its task and target. */
  trial: number;
  /** Aborted when the trial times out. */
  signal: AbortSignal;
  /** Adds an event to the trial's transcript (the time defaults to now). */
  record: (event: TranscriptEventInput) => void;
}

export interface AgentReply {
  text: string;
  /** When the reply's first token arrived; the first model call's first token in the turn when left out. */
  firstTokenAt?: number;
  /** The agent ended the conversation (it needs no more user messages). */
  done?: boolean;
}

/** One agent session: a clean conversation for one trial. */
export interface AgentSession {
  send(message: string): Promise<AgentReply>;
  /** The final state of the environment, or a promise of it. */
  outcome?(): unknown;
  close?(): Promise<void> | void;
}

export interface Adapter {
  start(context: TrialContext): Promise<AgentSession>;
}

/** An adapter with a name and its options: what a run compares (models, prompts, configurations). */
export interface Target {
  name: string;
  adapter: Adapter;
  /** Shown in the report (the model, the endpoint, the reasoning effort). */
  description?: string;
}

/**
 * An error of the eval's infrastructure, not of the agent: a lost connection, a stack that isn't up, a rate limit of the
 * eval account. The harness retries the trial and counts these apart; they never count as the agent's failure.
 */
export class InfraError extends Error {
  override name = 'InfraError';
}

export type TrialStatus = 'completed' | 'agent_error' | 'timeout' | 'infra_error';

export interface TrialMetrics {
  durationMs: number;
  /** Per user turn: from sending to the first token. */
  ttftMs: number[];
  /** Per user turn: from sending to the agent's reply (the final answer or card of the turn). */
  replyMs: number[];
  turns: number;
  modelCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Whether every model call reported its cost (else costUsd is a lower bound). */
  costComplete: boolean;
}

export interface TrialResult {
  suite: string;
  suiteKind: SuiteKind;
  taskId: string;
  target: string;
  trial: number;
  status: TrialStatus;
  /** Attempts, the retries after infrastructure errors included. */
  attempts: number;
  infraErrors: string[];
  error?: string;
  outcome: unknown;
  grades: GraderResult[];
  /**
   * The trial has no verdict: every grader of the task is a model grader and the run had no judge, or the grading failed
   * (`gradingError`). Such a trial is left out of pass@k like an infrastructure error, so a dry run can't pass a task it
   * never graded.
   */
  ungraded?: boolean;
  /**
   * The grading failed after the attempt (the judge's provider stayed down: `the judge failed: …`). The attempt's own
   * status is kept; the trial is ungraded, not retried, and counted apart from `infraErrors`. `regrade` grades it again.
   */
  gradingError?: string;
  /** The weighted mean of the grader scores: the partial credit. */
  score: number;
  passed: boolean;
  metrics: TrialMetrics;
  transcript: Transcript;
  /** The JSONL file of the transcript, relative to the run's folder. */
  transcriptFile?: string;
  startedAt: string;
}

/**
 * The version of the run and transcript formats this package writes and reads (`formatVersion` in `run.json` and on
 * every transcript line). It goes up only with a change an older reader would misread; a reader refuses a newer one.
 */
export const FORMAT_VERSION = 1;

export interface RunResult {
  /** The format's version ({@link FORMAT_VERSION}); absent in runs written before 0.1.0, which read as 1. */
  formatVersion?: number;
  id: string;
  startedAt: string;
  finishedAt: string;
  targets: { name: string; description?: string }[];
  suites: {
    name: string;
    kind: SuiteKind;
    owner?: string;
    tasks: string[];
    saturation?: { threshold: number };
    /** The suite's graduation rule, which `graduationCandidates` reads. */
    graduation?: { k: number; runs: number };
  }[];
  trials: TrialResult[];
  /** Anything the caller adds: the commit, the stack, the judge. */
  meta?: Record<string, unknown>;
}

export type Verdict = 'pass' | 'fail' | 'unknown';

/**
 * A person's verdict on one dimension of one trial, from the labelling file: the gold standard a model judge is
 * calibrated against.
 */
export interface HumanLabel {
  suite?: string;
  taskId: string;
  target: string;
  trial: number;
  /** The judge grader's id in the task. */
  grader: string;
  /** The rubric dimension. */
  dimension: string;
  label: Verdict;
  labeller?: string;
  note?: string;
}

/** How well a model judge agrees with the human labels, per grader and dimension. */
export interface CalibrationReport {
  dimensions: {
    grader: string;
    dimension: string;
    /** Labelled trials the judge also graded. */
    n: number;
    /** The share of trials where judge and human give the same verdict. */
    agreement: number | null;
    /** Cohen's kappa over pass and fail (trials where either says unknown are left out). */
    kappa: number | null;
    /** How often the judge said unknown on a labelled trial. */
    unknownRate: number | null;
    /** Labelled entries a person left at (or set to) unknown: not counted in n, agreement or kappa. */
    humanUnknown: number;
    confusion: { judge: Verdict; human: Verdict; count: number }[];
  }[];
  /** Every labelled trial with the judge's verdict, so a person can check the sample. */
  sample: (HumanLabel & { judge: Verdict | null; judgeReason?: string })[];
}

/** What a person found when reading a failed trial's transcript. */
export type FailureClass = 'agent' | 'grader' | 'task' | 'infra';

/** One entry of the reviews file: the class of a failure and a note on what went wrong. */
export interface Review {
  suite?: string;
  taskId: string;
  target: string;
  /** The trial; every trial of the task and target when left out. */
  trial?: number;
  class: FailureClass;
  /** What went wrong, for the report's annotated examples. */
  annotation?: string;
  reviewer?: string;
}
