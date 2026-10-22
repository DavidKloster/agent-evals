import { InfraError, type ChatClient, type ChatRequest, type ChatResponse } from '../core/types.ts';
import { readSse, sseJson } from './sse.ts';

/**
 * A client of an OpenAI-compatible chat completions API (OpenRouter, a local server, a provider's own endpoint). It streams,
 * so the time to the first token is measured, and reads the usage of the last chunk (OpenRouter adds the cost in USD).
 */
export interface OpenAICompatibleOptions {
  /** e.g. `https://openrouter.ai/api/v1`. */
  baseUrl: string;
  /** The key itself; read from the environment by the caller, never logged. */
  apiKey?: string;
  model: string;
  /** Fields merged into every request body: `reasoning`, `provider` (OpenRouter's routing), `max_tokens`. */
  extraBody?: Record<string, unknown>;
  headers?: Record<string, string>;
  /** Ask OpenRouter for the cost in the usage (default true for an openrouter.ai base URL). */
  openRouterUsage?: boolean;
  /**
   * Send `response_format: { type: "json_object" }` when `complete()` is asked for JSON (a judge's verdict). Default
   * true; set it to false for a provider or model that rejects the field (the judge then relies on its prompt alone).
   */
  jsonMode?: boolean;
  fetch?: typeof fetch;
}

export interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
}

export interface ToolDefinition {
  name: string;
  description?: string;
  /** JSON Schema of the arguments. */
  parameters?: Record<string, unknown>;
}

export interface Completion {
  text: string;
  toolCalls: WireToolCall[];
  finishReason: string | null;
  model: string;
  provider?: string;
  startedAt: number;
  firstTokenAt?: number;
  endedAt: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

/**
 * HTTP statuses of the eval's own infrastructure, credentials or the provider's capacity: never the agent's failure.
 * 401 and 403 mean the eval's key is wrong or lacks access.
 */
const infraStatuses = new Set([401, 403, 408, 429, 502, 503, 504]);

export class OpenAICompatible implements ChatClient {
  // Private, so the key it holds never ends up in a serialized client.
  private readonly options: OpenAICompatibleOptions;

  constructor(options: OpenAICompatibleOptions) {
    this.options = options;
  }

  /** One streamed completion with optional tools. */
  async chat(
    messages: WireMessage[],
    options: {
      tools?: ToolDefinition[];
      model?: string;
      temperature?: number;
      maxTokens?: number;
      /** Ask for a JSON object as the answer (`response_format`). */
      json?: boolean;
      signal?: AbortSignal;
    } = {},
  ): Promise<Completion> {
    const { baseUrl, apiKey, extraBody, headers } = this.options;
    const openRouterUsage = this.options.openRouterUsage ?? /openrouter\.ai/.test(baseUrl);
    const body: Record<string, unknown> = {
      model: options.model ?? this.options.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
      ...(options.tools?.length
        ? {
            tools: options.tools.map((tool) => ({
              type: 'function',
              function: {
                name: tool.name,
                description: tool.description ?? '',
                parameters: tool.parameters ?? { type: 'object', properties: {} },
              },
            })),
          }
        : {}),
      ...(options.json ? { response_format: { type: 'json_object' } } : {}),
      ...(openRouterUsage ? { usage: { include: true } } : {}),
      ...extraBody,
    };
    const startedAt = Date.now();
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(
        `${baseUrl.replace(/\/$/, '')}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
            ...headers,
          },
          body: JSON.stringify(body),
          signal: options.signal,
          redirect: 'error',
        },
      );
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new InfraError(
        `the request to ${baseUrl} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok || !response.body) {
      const text = (await response.text().catch(() => '')).slice(0, 500);
      // A 400 is mostly a wrong model name or a field the model doesn't take: name the model.
      const about = response.status === 400 ? ` (model ${String(body.model)})` : '';
      const message = `HTTP ${response.status} from ${baseUrl}${about}: ${text}`;
      throw infraStatuses.has(response.status) ? new InfraError(message) : new Error(message);
    }

    const completion: Completion = {
      text: '',
      toolCalls: [],
      finishReason: null,
      model: String(body.model),
      startedAt,
      endedAt: startedAt,
    };
    const partial = new Map<number, WireToolCall>();
    for await (const event of readSse(response.body)) {
      if (event.data === '[DONE]') break;
      const chunk = sseJson(event);
      if (chunk.error) {
        // OpenRouter reports a provider's failure inside the stream, with the status as its code.
        const code = Number((chunk.error as { code?: unknown }).code);
        const text = `the stream failed: ${JSON.stringify(chunk.error).slice(0, 500)}`;
        throw infraStatuses.has(code) || code >= 500 ? new InfraError(text) : new Error(text);
      }
      if (typeof chunk.model === 'string') completion.model = chunk.model;
      if (typeof chunk.provider === 'string') completion.provider = chunk.provider;
      const choice = (
        chunk.choices as
          { delta?: Record<string, unknown>; finish_reason?: string | null }[] | undefined
      )?.[0];
      const delta = choice?.delta;
      if (delta) {
        if (typeof delta.content === 'string' && delta.content !== '') {
          completion.firstTokenAt ??= event.at;
          completion.text += delta.content;
        }
        for (const call of (delta.tool_calls as
          | { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]
          | undefined) ?? []) {
          completion.firstTokenAt ??= event.at;
          const index = call.index ?? 0;
          const current = partial.get(index) ?? {
            id: '',
            type: 'function' as const,
            function: { name: '', arguments: '' },
          };
          if (call.id) current.id = call.id;
          if (call.function?.name) current.function.name += call.function.name;
          if (call.function?.arguments) current.function.arguments += call.function.arguments;
          partial.set(index, current);
        }
      }
      if (choice?.finish_reason) completion.finishReason = choice.finish_reason;
      const usage = chunk.usage as
        { prompt_tokens?: number; completion_tokens?: number; cost?: number } | undefined;
      if (usage) {
        completion.inputTokens = usage.prompt_tokens;
        completion.outputTokens = usage.completion_tokens;
        if (typeof usage.cost === 'number') completion.costUsd = usage.cost;
      }
    }
    completion.toolCalls = [...partial.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, call]) => ({ ...call, id: call.id || `call_${index}` }));
    completion.endedAt = Date.now();
    return completion;
  }

  /** The ChatClient of the judges and the simulated user: one answer, no tools. */
  async complete(request: ChatRequest): Promise<ChatResponse> {
    const completion = await this.chat(request.messages, {
      model: request.model,
      temperature: request.temperature,
      maxTokens: request.maxTokens,
      json: request.json && (this.options.jsonMode ?? true),
      signal: request.signal,
    });
    return {
      text: completion.text,
      model: completion.model,
      inputTokens: completion.inputTokens,
      outputTokens: completion.outputTokens,
      costUsd: completion.costUsd,
    };
  }
}
