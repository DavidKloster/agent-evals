import type { TrialContext } from '../core/types.ts';
import { matchesAll } from '../graders/matchers.ts';
import type { ToolDefinition } from '../llm/openai-compatible.ts';

/** The tools an agent may call in a trial, and the state they leave: the trial's outcome. */
export interface ToolEnvironment {
  tools: ToolDefinition[];
  call(name: string, args: unknown, signal: AbortSignal): Promise<unknown>;
  outcome(): unknown;
}

/**
 * A mock tool as a task file declares it under `input.context.tools`: its definition and canned responses. The first
 * response whose `when` matches the arguments answers (argument path → matcher, as in the `tool_called` grader); a
 * response without `when` matches anything. A write tool's successful calls are the outcome's `writes`; a call that
 * failed (its response is an `error`, or no response matches) is in `failedWrites` with its error instead.
 */
export interface MockTool extends ToolDefinition {
  write?: boolean;
  responses?: { when?: Record<string, unknown>; result?: unknown; error?: string }[];
}

/** A tool call the environment refused: the agent sees the error, as it would see a failed API call. */
export class ToolError extends Error {
  override name = 'ToolError';
}

/** The mock environment of a task: `input.context.tools` and `input.context.state` (copied, so trials share nothing). */
export function mockEnvironment(context: TrialContext): ToolEnvironment {
  const declared = (context.task.input.context?.tools ?? []) as MockTool[];
  const state: unknown = structuredClone(context.task.input.context?.state ?? null);
  const writes: { tool: string; args: unknown }[] = [];
  const failedWrites: { tool: string; args: unknown; error: string }[] = [];
  return {
    tools: declared.map(({ name, description, parameters }) => ({ name, description, parameters })),
    call(name, args) {
      const tool = declared.find((t) => t.name === name);
      if (!tool) return Promise.reject(new ToolError(`unknown tool ${name}`));
      const response = (tool.responses ?? []).find((r) => !r.when || matchesAll(args, r.when));
      if (!response || response.error) {
        const error = response?.error ?? 'no data for these arguments';
        if (tool.write) failedWrites.push({ tool: name, args, error });
        return Promise.reject(new ToolError(error));
      }
      if (tool.write) writes.push({ tool: name, args });
      return Promise.resolve(structuredClone(response.result ?? null));
    },
    outcome: () => ({ writes, failedWrites, state }),
  };
}
