import type { Adapter, AgentReply, AgentSession, TrialContext } from '../core/types.ts';
import {
  OpenAICompatible,
  type OpenAICompatibleOptions,
  type WireMessage,
} from '../llm/openai-compatible.ts';
import { mockEnvironment, type ToolEnvironment } from './mock-tools.ts';

export interface OpenAIToolsOptions extends OpenAICompatibleOptions {
  /** The system prompt; a task overrides it with `input.context.system`. */
  system?: string;
  /** The tools and their effects; the task's mock tools (`input.context.tools`) by default. */
  environment?: (context: TrialContext) => ToolEnvironment | Promise<ToolEnvironment>;
  /** Model calls per user turn before the turn fails as the agent's error (default 8). */
  maxRounds?: number;
  temperature?: number;
  maxTokens?: number;
}

const truncate = (text: string, max = 20_000) =>
  text.length > max ? `${text.slice(0, max)}…` : text;

/**
 * An agent harness of its own: a chat-with-tools loop against an OpenAI-compatible API (OpenRouter among them). Each
 * user turn calls the model until it answers without a tool call; every call, tool call and result goes into the
 * transcript. Use it to compare models on a task's mock tools, or as the template of an adapter for a real agent.
 */
export function openAIToolsAdapter(options: OpenAIToolsOptions): Adapter {
  const client = new OpenAICompatible(options);
  return {
    async start(context: TrialContext): Promise<AgentSession> {
      const environment = await (options.environment ?? mockEnvironment)(context);
      const system = (context.task.input.context?.system as string | undefined) ?? options.system;
      const history: WireMessage[] = system ? [{ role: 'system', content: system }] : [];
      const maxRounds = options.maxRounds ?? 8;
      return {
        async send(message: string): Promise<AgentReply> {
          history.push({ role: 'user', content: message });
          let firstTokenAt: number | undefined;
          for (let round = 0; round < maxRounds; round++) {
            let completion;
            try {
              completion = await client.chat(history, {
                tools: environment.tools,
                temperature: options.temperature,
                maxTokens: options.maxTokens,
                signal: context.signal,
              });
            } catch (error) {
              context.record({
                type: 'model_call',
                model: options.model,
                startedAt: Date.now(),
                endedAt: Date.now(),
                error: error instanceof Error ? error.message : String(error),
              });
              throw error;
            }
            context.record({
              type: 'model_call',
              model: completion.model,
              provider: completion.provider,
              startedAt: completion.startedAt,
              firstTokenAt: completion.firstTokenAt,
              endedAt: completion.endedAt,
              inputTokens: completion.inputTokens,
              outputTokens: completion.outputTokens,
              costUsd: completion.costUsd,
            });
            firstTokenAt ??= completion.firstTokenAt;
            history.push({
              role: 'assistant',
              content: completion.text || null,
              ...(completion.toolCalls.length ? { tool_calls: completion.toolCalls } : {}),
            });
            if (completion.toolCalls.length === 0) return { text: completion.text, firstTokenAt };
            for (const call of completion.toolCalls) {
              let args: unknown;
              try {
                args = JSON.parse(call.function.arguments || '{}');
              } catch {
                args = { _unparsed: call.function.arguments };
              }
              context.record({ type: 'tool_call', id: call.id, name: call.function.name, args });
              let content: string;
              try {
                const result = await environment.call(call.function.name, args, context.signal);
                context.record({
                  type: 'tool_result',
                  id: call.id,
                  name: call.function.name,
                  result,
                });
                content = truncate(JSON.stringify(result));
              } catch (error) {
                const text = error instanceof Error ? error.message : String(error);
                context.record({
                  type: 'tool_result',
                  id: call.id,
                  name: call.function.name,
                  result: null,
                  error: text,
                });
                content = JSON.stringify({ error: text });
              }
              history.push({ role: 'tool', tool_call_id: call.id, content });
            }
          }
          throw new Error(`no answer after ${maxRounds} model calls in one turn`);
        },
        outcome: () => environment.outcome(),
      };
    },
  };
}
