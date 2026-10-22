/**
 * agent-evals: evals for AI agents on the method of Anthropic's "Demystifying evals for AI agents" (README.md).
 * The public API: the model, the loader, the harness, the graders, the metrics, the reports and the adapters.
 */

export * from './core/types.ts';
export { EvalFileError, defineSuite, loadSuite, parseTasks, readDataFile } from './core/loader.ts';
export { jsonSchemas, suiteSchema, taskSchema } from './core/schema.ts';
export {
  answerOf,
  completeTranscript,
  messages,
  metricsOf,
  toolUses,
  type ToolUse,
} from './core/transcript.ts';

export { runEval, type RunOptions } from './harness/run.ts';
export { regradeRun } from './harness/regrade.ts';
export { validateSuite, type SuiteCheck, type TaskCheck } from './harness/validate.ts';
export { SimulatedUser, stopToken } from './harness/simulated-user.ts';

export { builtinGraders } from './graders/builtin.ts';
export {
  gradeTrial,
  duplicateGraderIds,
  gradersOf,
  registry,
  scoreOf,
  scoringOf,
  type GradeOptions,
  type GraderRegistry,
} from './graders/grade.ts';
export {
  codeGraders,
  factHolds,
  factsGrader,
  forbidGrader,
  isQuestion,
  normalizeText,
  type FactMatcher,
  type FactText,
} from './graders/code.ts';
export {
  checkToolResultMaxChars,
  comparePair,
  consensus,
  DEFAULT_TOOL_RESULT_MAX_CHARS,
  judgeFailure,
  modelGraders,
  parseVerdict,
  type ComparePairOptions,
  type JudgeDetails,
  type JudgeSpec,
  type PairResult,
  type RubricDimension,
} from './graders/judge.ts';
export {
  canonicalJson,
  checkPaths,
  deepEqual,
  isPlaceholder,
  leafValues,
  matchAt,
  matchesAll,
  matchValue,
  mismatchOf,
  parsePath,
  stringLeaves,
  valueAt,
  valuesAt,
  type Matcher,
  type ParsedPath,
} from './graders/matchers.ts';

export {
  mean,
  p50,
  p90,
  passAtK,
  passHatK,
  percentile,
  summarize,
  type GroupSummary,
  type Summary,
  type TaskSummary,
} from './metrics/stats.ts';
export { diffRuns, type RunDiff, type TaskDiff } from './metrics/diff.ts';
export {
  DEFAULT_GRADUATION,
  graduationCandidates,
  saturation,
  type GraduationCandidate,
  type SaturationNote,
} from './metrics/lifecycle.ts';
export {
  calibrate,
  cohensKappa,
  labellingSheet,
  loadLabels,
  writeLabellingSheet,
  type LabellingEntry,
} from './metrics/calibration.ts';

export {
  failureTable,
  loadReviews,
  ungradedTrials,
  type FailureRow,
  type UngradedRow,
} from './report/reviews.ts';
export { markdownReport, type ReportOptions } from './report/markdown.ts';
export { escapeHtml, htmlReport } from './report/html.ts';
export {
  readRun,
  writeReports,
  type ReportPaths,
  type WriteReportsOptions,
} from './report/write.ts';

export {
  scriptedAdapter,
  referenceTurns,
  type ScriptedOptions,
  type ScriptedTurn,
} from './adapters/scripted.ts';
export { openAIToolsAdapter, type OpenAIToolsOptions } from './adapters/openai-tools.ts';
export {
  mockEnvironment,
  ToolError,
  type MockTool,
  type ToolEnvironment,
} from './adapters/mock-tools.ts';
export {
  defaultEventMapper,
  httpSseAdapter,
  type EventMapper,
  type HttpSseOptions,
  type TurnState,
} from './adapters/http-sse.ts';
export {
  OpenAICompatible,
  type Completion,
  type OpenAICompatibleOptions,
  type ToolDefinition,
} from './llm/openai-compatible.ts';
export { readSse, sseJson, type SseEvent } from './llm/sse.ts';

export { startViewer, type Viewer, type ViewerOptions } from './viewer/server.ts';
export { upsertLabels, removeLabel, readLabelsFile } from './viewer/labels-store.ts';

export {
  loadConfig,
  resolveConfig,
  type EvalConfig,
  type ResolvedConfig,
  type TargetSpec,
} from './config.ts';
