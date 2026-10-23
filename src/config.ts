import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { commandAdapter, type CommandOptions } from './adapters/command.ts';
import { httpSseAdapter } from './adapters/http-sse.ts';
import { openAIToolsAdapter, type OpenAIToolsOptions } from './adapters/openai-tools.ts';
import { scriptedAdapter, type ScriptedOptions } from './adapters/scripted.ts';
import { loadSuite, readDataFile } from './core/loader.ts';
import type { ChatClient, Grader, Suite, Target, TrialContext } from './core/types.ts';
import { builtinGraders } from './graders/builtin.ts';
import type { FactMatcher } from './graders/code.ts';
import { registry, type GraderRegistry } from './graders/grade.ts';
import { checkToolResultMaxChars } from './graders/judge.ts';
import { OpenAICompatible } from './llm/openai-compatible.ts';

/** A model behind an OpenAI-compatible API; the key comes from the environment variable `apiKeyEnv`. */
export interface EndpointSpec {
  baseUrl?: string;
  /** Default OPENROUTER_API_KEY. */
  apiKeyEnv?: string;
  extraBody?: Record<string, unknown>;
  /** `response_format: json_object` for a judge's JSON verdict (default true; false for a provider that rejects it). */
  jsonMode?: boolean;
}

/** A target as a YAML config names it: a built-in adapter and its options. */
export type TargetSpec =
  | {
      name: string;
      description?: string;
      adapter: 'openai-tools';
      options: Omit<OpenAIToolsOptions, 'apiKey' | 'baseUrl'> & EndpointSpec;
    }
  | { name: string; description?: string; adapter: 'scripted'; options: ScriptedOptions }
  | {
      name: string;
      description?: string;
      adapter: 'http-sse';
      options: { url: string; headers?: Record<string, string> };
    }
  | { name: string; description?: string; adapter: 'command'; options: CommandOptions };

/**
 * A run's configuration: in YAML or JSON for the built-in adapters, or as the default export of a TypeScript module for
 * a project's own adapters, graders and hooks.
 */
export interface EvalConfig {
  /** Suite files (relative to the config) or suites built in code. */
  suites: (string | Suite)[];
  targets: (Target | TargetSpec)[];
  /** A project's graders, next to the built-in ones. */
  graders?: Grader[];
  /** A project's fact matchers (`amount:`, `date:`) for the `facts` and `forbid` graders. */
  factMatchers?: FactMatcher[];
  /**
   * The model graders' judge: a client, or a model behind an endpoint. `toolResultMaxChars` is how much of each tool
   * result a judge sees (default 600); a judge grader's own `toolResultMaxChars` wins.
   */
  judge?:
    | { client: ChatClient; models?: string[]; toolResultMaxChars?: number }
    | (EndpointSpec & { models: string[]; toolResultMaxChars?: number });
  /** `reference` replays the reference solutions' user messages (a dry run). */
  userSimulator?:
    { client: ChatClient; model?: string } | (EndpointSpec & { model: string }) | 'reference';
  trials?: number;
  k?: number;
  concurrency?: number;
  retries?: number;
  timeoutMs?: number;
  /** The time limit of each `beforeTrial` and `afterTrial` call (default 60000). */
  hookTimeoutMs?: number;
  /** The run's folder (relative to the config); the CLI adds the run's time. */
  out?: string;
  hooks?: {
    beforeTrial?(context: TrialContext): Promise<void> | void;
    afterTrial?(context: TrialContext): Promise<void> | void;
  };
  meta?: Record<string, unknown>;
}

/** Every key a configuration reads; the record's type keeps the list complete. Other keys are ignored. */
const configKeyRecord: Record<keyof EvalConfig, true> = {
  suites: true,
  targets: true,
  graders: true,
  factMatchers: true,
  judge: true,
  userSimulator: true,
  trials: true,
  k: true,
  concurrency: true,
  retries: true,
  timeoutMs: true,
  hookTimeoutMs: true,
  out: true,
  hooks: true,
  meta: true,
};
export const configKeys = Object.keys(configKeyRecord) as (keyof EvalConfig)[];

export interface ResolvedConfig {
  suites: Suite[];
  targets: Target[];
  graders: GraderRegistry;
  judge?: ChatClient;
  judgeModels?: string[];
  judgeToolResultMaxChars?: number;
  userSimulator?: { client: ChatClient; model?: string } | 'reference';
  trials?: number;
  k: number;
  concurrency?: number;
  retries?: number;
  timeoutMs?: number;
  hookTimeoutMs?: number;
  out?: string;
  hooks?: EvalConfig['hooks'];
  meta?: Record<string, unknown>;
}

const defaultBaseUrl = 'https://openrouter.ai/api/v1';

function apiKey(spec: EndpointSpec, env: NodeJS.ProcessEnv): string {
  const name = spec.apiKeyEnv ?? 'OPENROUTER_API_KEY';
  const key = env[name];
  if (!key) throw new Error(`the environment variable ${name} holds no API key`);
  return key;
}

function client(spec: EndpointSpec, model: string, env: NodeJS.ProcessEnv): OpenAICompatible {
  return new OpenAICompatible({
    baseUrl: spec.baseUrl ?? defaultBaseUrl,
    apiKey: apiKey(spec, env),
    model,
    extraBody: spec.extraBody,
    jsonMode: spec.jsonMode,
  });
}

function target(spec: Target | TargetSpec, baseDir: string, env: NodeJS.ProcessEnv): Target {
  if (!('adapter' in spec) || typeof spec.adapter !== 'string') return spec;
  const { name, description } = spec;
  switch (spec.adapter) {
    case 'openai-tools': {
      const { baseUrl, apiKeyEnv, ...options } = spec.options;
      return {
        name,
        description: description ?? options.model,
        adapter: openAIToolsAdapter({
          ...options,
          baseUrl: baseUrl ?? defaultBaseUrl,
          apiKey: apiKey({ apiKeyEnv }, env),
        }),
      };
    }
    case 'scripted':
      return { name, description, adapter: scriptedAdapter(spec.options) };
    case 'http-sse':
      return {
        name,
        description,
        adapter: httpSseAdapter({ url: spec.options.url, headers: spec.options.headers }),
      };
    case 'command': {
      const { command, cwd, env: variables } = spec.options;
      return {
        name,
        description,
        // A relative cwd is the config's, like every other path in it.
        adapter: commandAdapter({
          command,
          cwd: cwd === undefined ? undefined : resolve(baseDir, cwd),
          env: variables,
        }),
      };
    }
  }
}

export function resolveConfig(
  config: EvalConfig,
  baseDir: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedConfig {
  const suites = config.suites.map((s) =>
    typeof s === 'string' ? loadSuite(resolve(baseDir, s)) : s,
  );
  const graders = registry([...builtinGraders(config.factMatchers).values()], config.graders ?? []);
  let judge: ChatClient | undefined;
  let judgeModels: string[] | undefined;
  if (config.judge?.models !== undefined && config.judge.models.length === 0)
    throw new Error(
      'the judge config has an empty `models` list: name at least one model (or leave `models` out of a judge client)',
    );
  if (config.judge && 'client' in config.judge) {
    judge = config.judge.client;
    judgeModels = config.judge.models;
  } else if (config.judge) {
    if (!Array.isArray(config.judge.models))
      throw new Error('the judge config needs `models`: a list of at least one model');
    judgeModels = config.judge.models;
    judge = client(config.judge, judgeModels[0]!, env);
  }
  const judgeToolResultMaxChars = checkToolResultMaxChars(
    config.judge?.toolResultMaxChars,
    'the judge config',
  );
  let userSimulator: ResolvedConfig['userSimulator'];
  if (
    config.userSimulator === 'reference' ||
    (config.userSimulator && 'client' in config.userSimulator)
  )
    userSimulator = config.userSimulator;
  else if (config.userSimulator)
    userSimulator = {
      client: client(config.userSimulator, config.userSimulator.model, env),
      model: config.userSimulator.model,
    };
  return {
    suites,
    targets: config.targets.map((t) => target(t, baseDir, env)),
    graders,
    judge,
    judgeModels,
    judgeToolResultMaxChars,
    userSimulator,
    trials: config.trials,
    k: config.k ?? 3,
    concurrency: config.concurrency,
    retries: config.retries,
    timeoutMs: config.timeoutMs,
    hookTimeoutMs: config.hookTimeoutMs,
    out: config.out === undefined ? undefined : resolve(baseDir, config.out),
    hooks: config.hooks,
    meta: config.meta,
  };
}

/** Reads a YAML or JSON config, or imports a TypeScript or JavaScript module's default export. */
export async function loadConfig(file: string): Promise<{ config: EvalConfig; baseDir: string }> {
  const path = resolve(file);
  const config = /\.(m?[jt]s)$/.test(path)
    ? ((await import(pathToFileURL(path).href)) as { default: EvalConfig }).default
    : (readDataFile(path) as EvalConfig);
  return { config, baseDir: dirname(path) };
}
