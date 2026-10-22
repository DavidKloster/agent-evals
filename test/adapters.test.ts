import { describe, expect, it } from 'vitest';

import { httpSseAdapter } from '../src/adapters/http-sse.ts';
import { openAIToolsAdapter } from '../src/adapters/openai-tools.ts';
import { referenceTurns, scriptedAdapter } from '../src/adapters/scripted.ts';
import { defineSuite } from '../src/core/loader.ts';
import type { Suite } from '../src/core/types.ts';
import { runEval } from '../src/harness/run.ts';
import { readSse } from '../src/llm/sse.ts';

/** A Response whose body streams the given SSE blocks. */
function sseResponse(blocks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const block of blocks) controller.enqueue(encoder.encode(block));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
}

const chunk = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;

const invoiceTask = {
  id: 'due-date',
  input: {
    turns: ['Wann ist RE-1 fällig?'],
    context: {
      system: 'Antworte kurz.',
      tools: [
        {
          name: 'get_invoice',
          parameters: { type: 'object', properties: { number: { type: 'string' } } },
          responses: [{ when: { number: 'RE-1' }, result: { due: '2026-06-11' } }],
        },
        { name: 'pay_invoice', write: true, responses: [{ result: { ok: true } }] },
      ],
    },
  },
  graders: [{ type: 'tool_called', tool: 'get_invoice', args: { number: 'RE-1' } }],
};

const suiteOf = (tasks: unknown[]): Suite => defineSuite({ name: 's', kind: 'regression', tasks });

describe('readSse', () => {
  it('reads events split across chunks, skips comments and joins multi-line data', async () => {
    const events = [];
    for await (const e of readSse(
      sseResponse([': hi\n\nevent: te', 'xt\ndata: a\ndata: b\n\n', 'data: c']).body!,
    ))
      events.push([e.event, e.data]);
    expect(events).toEqual([
      ['text', 'a\nb'],
      ['message', 'c'],
    ]);
  });
});

describe('openAIToolsAdapter', () => {
  it('loops over tool calls against the mock tools and records calls, results, usage and the outcome', async () => {
    const requests: Record<string, unknown>[] = [];
    const fakeFetch = ((_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      requests.push(body);
      if (requests.length === 1)
        return Promise.resolve(
          sseResponse([
            chunk({
              model: 'test/m',
              choices: [
                {
                  delta: {
                    tool_calls: [
                      { index: 0, id: 'c1', function: { name: 'get_invoice', arguments: '{"num' } },
                    ],
                  },
                },
              ],
            }),
            chunk({
              choices: [
                { delta: { tool_calls: [{ index: 0, function: { arguments: 'ber":"RE-1"}' } }] } },
              ],
            }),
            chunk({
              choices: [{ delta: {}, finish_reason: 'tool_calls' }],
              usage: { prompt_tokens: 50, completion_tokens: 5, cost: 0.0002 },
            }),
            'data: [DONE]\n\n',
          ]),
        );
      return Promise.resolve(
        sseResponse([
          chunk({ choices: [{ delta: { content: 'Am 11.06.' } }] }),
          chunk({
            choices: [{ delta: { content: '2026.' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 80, completion_tokens: 7, cost: 0.0003 },
          }),
          'data: [DONE]\n\n',
        ]),
      );
    }) as typeof fetch;

    const run = await runEval({
      suites: [suiteOf([invoiceTask])],
      targets: [
        {
          name: 'm',
          adapter: openAIToolsAdapter({
            baseUrl: 'https://openrouter.ai/api/v1',
            apiKey: 'k',
            model: 'test/m',
            fetch: fakeFetch,
          }),
        },
      ],
      trials: 1,
    });
    const [trial] = run.trials;
    expect(trial).toMatchObject({ status: 'completed', passed: true });
    expect(trial!.transcript.at(-1)).toMatchObject({
      type: 'message',
      role: 'assistant',
      text: 'Am 11.06.2026.',
    });
    expect(trial!.metrics).toMatchObject({
      modelCalls: 2,
      toolCalls: 1,
      inputTokens: 130,
      outputTokens: 12,
      costUsd: 0.0005,
    });
    expect(trial!.outcome).toEqual({ writes: [], failedWrites: [], state: null });
    expect(requests[0]).toMatchObject({ model: 'test/m', stream: true, usage: { include: true } });
    expect((requests[0]!.messages as { role: string }[])[0]).toEqual({
      role: 'system',
      content: 'Antworte kurz.',
    });
    const second = requests[1]!.messages as { role: string; content: string }[];
    expect(second.at(-1)).toMatchObject({ role: 'tool', content: '{"due":"2026-06-11"}' });
  });

  it('turns a rate limit into an infrastructure error and a bad request into an agent error', async () => {
    const status = { value: 429 };
    const fakeFetch = (() =>
      Promise.resolve(new Response('busy', { status: status.value }))) as unknown as typeof fetch;
    const target = {
      name: 'm',
      adapter: openAIToolsAdapter({ baseUrl: 'http://x', model: 'm', fetch: fakeFetch }),
    };
    const limited = await runEval({
      suites: [suiteOf([invoiceTask])],
      targets: [target],
      trials: 1,
      retries: 0,
    });
    expect(limited.trials[0]!.status).toBe('infra_error');
    status.value = 400;
    const refused = await runEval({
      suites: [suiteOf([invoiceTask])],
      targets: [target],
      trials: 1,
      retries: 0,
    });
    expect(refused.trials[0]!.status).toBe('agent_error');
  });
});

describe('httpSseAdapter', () => {
  it('maps the default events to the transcript and opens and closes a session per trial', async () => {
    const log: string[] = [];
    const fakeFetch = ((url: string, init: RequestInit) => {
      log.push(`${url} ${init.body as string}`);
      return Promise.resolve(
        sseResponse([
          'event: tool_call\ndata: {"id":"1","name":"search","args":{"q":"RE-1"}}\n\n',
          'event: tool_result\ndata: {"id":"1","name":"search","result":[1]}\n\n',
          'event: text\ndata: {"text":"Gefunden"}\n\n',
          'event: usage\ndata: {"model":"m","inputTokens":3,"outputTokens":4,"costUsd":0.01}\n\n',
          'event: done\ndata: {}\n\n',
        ]),
      );
    }) as unknown as typeof fetch;
    const run = await runEval({
      suites: [suiteOf([{ ...invoiceTask, graders: [{ type: 'tool_called', tool: 'search' }] }])],
      targets: [
        {
          name: 'h',
          adapter: httpSseAdapter<{ id: string }>({
            open: (c) => ({ id: `conv-${c.trial}` }),
            url: (s) => `http://agent/conversations/${s.id}/turns`,
            body: (message) => ({ question: message }),
            outcome: (s) => ({ conversation: s.id }),
            close: (s) => void log.push(`close ${s.id}`),
            fetch: fakeFetch,
          }),
        },
      ],
      trials: 1,
    });
    expect(run.trials[0]).toMatchObject({ passed: true, outcome: { conversation: 'conv-0' } });
    expect(run.trials[0]!.metrics).toMatchObject({ toolCalls: 1, modelCalls: 1, costUsd: 0.01 });
    expect(log).toEqual([
      'http://agent/conversations/conv-0/turns {"question":"Wann ist RE-1 fällig?"}',
      'close conv-0',
    ]);
  });

  it("fails the turn as the agent's error on an error event, and as infrastructure on a cut stream", async () => {
    const blocks = { value: ['event: error\ndata: {"message":"TooManyToolRounds"}\n\n'] };
    const fakeFetch = (() => Promise.resolve(sseResponse(blocks.value))) as unknown as typeof fetch;
    const target = {
      name: 'h',
      adapter: httpSseAdapter({ url: 'http://agent', fetch: fakeFetch }),
    };
    const failed = await runEval({
      suites: [suiteOf([invoiceTask])],
      targets: [target],
      trials: 1,
    });
    expect(failed.trials[0]).toMatchObject({ status: 'agent_error', error: 'TooManyToolRounds' });
    blocks.value = ['event: text\ndata: {"text":"Hal"}\n\n'];
    const cut = await runEval({
      suites: [suiteOf([invoiceTask])],
      targets: [target],
      trials: 1,
      retries: 0,
    });
    expect(cut.trials[0]!.status).toBe('infra_error');
  });
});

describe('scriptedAdapter', () => {
  it('replays a reference solution turn by turn with its outcome', async () => {
    const task = {
      ...invoiceTask,
      reference: {
        transcript: [
          { type: 'message', role: 'user', text: 'Wann ist RE-1 fällig?' },
          { type: 'tool_call', id: 'r1', name: 'get_invoice', args: { number: 'RE-1' } },
          { type: 'message', role: 'assistant', text: 'Am 11.06.2026.' },
        ],
        outcome: { writes: [] },
      },
    };
    expect(referenceTurns(task.reference.transcript as never)).toHaveLength(1);
    const run = await runEval({
      suites: [suiteOf([task])],
      targets: [{ name: 'ref', adapter: scriptedAdapter({ replayReference: true }) }],
      trials: 1,
    });
    expect(run.trials[0]).toMatchObject({ passed: true, outcome: { writes: [] } });
  });
});
