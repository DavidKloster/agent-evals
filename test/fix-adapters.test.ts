import { describe, expect, it } from 'vitest';

import { mockEnvironment } from '../src/adapters/mock-tools.ts';
import { openAIToolsAdapter } from '../src/adapters/openai-tools.ts';
import { scriptedAdapter } from '../src/adapters/scripted.ts';
import { resolveConfig } from '../src/config.ts';
import { defineSuite } from '../src/core/loader.ts';
import { InfraError, type Suite, type TrialContext } from '../src/core/types.ts';
import { runEval } from '../src/harness/run.ts';
import { OpenAICompatible } from '../src/llm/openai-compatible.ts';

/** Fixes F4, F9, F14, F15 (config) and F21 of the release table. */

const suiteOf = (tasks: unknown[]): Suite => defineSuite({ name: 's', kind: 'regression', tasks });

function contextOf(task: unknown): TrialContext {
  const suite = suiteOf([task]);
  return {
    suite,
    task: suite.tasks[0]!,
    target: 't',
    trial: 0,
    signal: new AbortController().signal,
    record: () => {},
  };
}

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

const answer = (text: string) => [
  `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\n`,
  'data: [DONE]\n\n',
];

describe('F4: mock write tools', () => {
  const task = {
    id: 'pay',
    input: {
      turns: ['Pay RE-1'],
      context: {
        tools: [
          {
            name: 'pay_invoice',
            write: true,
            responses: [
              { when: { number: 'RE-1' }, result: { ok: true } },
              { when: { number: 'RE-2' }, error: 'already paid' },
            ],
          },
        ],
      },
    },
    graders: [{ type: 'outcome', expect: { writes: { length: 1 } } }],
  };

  it('counts a write only when it succeeded and records a failed one with its error', async () => {
    const env = mockEnvironment(contextOf(task));
    const signal = new AbortController().signal;
    await expect(env.call('pay_invoice', { number: 'RE-2' }, signal)).rejects.toThrow(
      'already paid',
    );
    await expect(env.call('pay_invoice', { number: 'RE-9' }, signal)).rejects.toThrow(
      'no data for these arguments',
    );
    await expect(env.call('pay_invoice', { number: 'RE-1' }, signal)).resolves.toEqual({
      ok: true,
    });
    expect(env.outcome()).toEqual({
      writes: [{ tool: 'pay_invoice', args: { number: 'RE-1' } }],
      failedWrites: [
        { tool: 'pay_invoice', args: { number: 'RE-2' }, error: 'already paid' },
        { tool: 'pay_invoice', args: { number: 'RE-9' }, error: 'no data for these arguments' },
      ],
      state: null,
    });
  });

  it('leaves both lists empty without write calls', () => {
    expect(mockEnvironment(contextOf(task)).outcome()).toEqual({
      writes: [],
      failedWrites: [],
      state: null,
    });
  });
});

describe('F9: JSON mode of complete()', () => {
  const capture = () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch = ((_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string) as Record<string, unknown>);
      return Promise.resolve(sseResponse(answer('{"ok":true}')));
    }) as typeof globalThis.fetch;
    return { bodies, fetch };
  };

  it('asks for a JSON object when the request wants JSON', async () => {
    const { bodies, fetch } = capture();
    const client = new OpenAICompatible({ baseUrl: 'http://x/v1', model: 'm', fetch });
    const reply = await client.complete({
      messages: [{ role: 'user', content: 'hi' }],
      json: true,
    });
    expect(reply.text).toBe('{"ok":true}');
    expect(bodies[0]).toMatchObject({ response_format: { type: 'json_object' } });
  });

  it('sends no response_format without json, or when jsonMode is off', async () => {
    const { bodies, fetch } = capture();
    await new OpenAICompatible({ baseUrl: 'http://x/v1', model: 'm', fetch }).complete({
      messages: [{ role: 'user', content: 'hi' }],
    });
    await new OpenAICompatible({
      baseUrl: 'http://x/v1',
      model: 'm',
      fetch,
      jsonMode: false,
    }).complete({ messages: [{ role: 'user', content: 'hi' }], json: true });
    expect(bodies.map((b) => 'response_format' in b)).toEqual([false, false]);
  });
});

describe('F14: the scripted first token', () => {
  it('is measured after the delay, not computed from it', async () => {
    const task = { id: 'slow', input: { turns: ['hi'] }, graders: [{ type: 'no_error' }] };
    const adapter = scriptedAdapter({ replies: { slow: [{ text: 'ok', delayMs: 20 }] } });
    const session = await adapter.start(contextOf(task));
    const realNow = Date.now.bind(Date);
    let skew = 0;
    // The clock jumps while the scripted agent waits: a measured first token sees the jump.
    setTimeout(() => (skew = 10_000), 1);
    Date.now = () => realNow() + skew;
    try {
      const before = realNow();
      const reply = await session.send('hi');
      expect(reply.firstTokenAt).toBeGreaterThanOrEqual(before + 10_000);
      expect(reply.firstTokenAt).toBeLessThanOrEqual(Date.now());
    } finally {
      Date.now = realNow;
    }
  });
});

describe('F15: a judge config without models', () => {
  it('is refused with a clear error', () => {
    expect(() =>
      resolveConfig({ suites: [], targets: [], judge: { models: [] } }, '.', {
        OPENROUTER_API_KEY: 'k',
      }),
    ).toThrow(/judge.*models.*at least one/i);
  });

  it('is refused for a judge client with an empty model list too', () => {
    const client = { complete: () => Promise.resolve({ text: '' }) };
    expect(() =>
      resolveConfig({ suites: [], targets: [], judge: { client, models: [] } }, '.'),
    ).toThrow(/judge.*models.*at least one/i);
  });
});

describe("F21: a provider's refusal", () => {
  const task = { id: 'q', input: { turns: ['hi'] }, graders: [{ type: 'no_error' }] };
  const statusFetch = (status: number) =>
    (() =>
      Promise.resolve(
        new Response('{"error":"nope"}', { status }),
      )) as unknown as typeof globalThis.fetch;

  it.each([401, 403])(
    "treats HTTP %i as an infrastructure error (the eval's key)",
    async (status) => {
      const client = new OpenAICompatible({
        baseUrl: 'http://x/v1',
        model: 'm',
        fetch: statusFetch(status),
      });
      const error = await client.chat([{ role: 'user', content: 'hi' }]).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(InfraError);
      expect((error as Error).message).toMatch(new RegExp(`HTTP ${status}`));

      const run = await runEval({
        suites: [suiteOf([task])],
        targets: [
          {
            name: 't',
            adapter: openAIToolsAdapter({
              baseUrl: 'http://x/v1',
              model: 'm',
              fetch: statusFetch(status),
            }),
          },
        ],
        trials: 1,
        retries: 0,
      });
      expect(run.trials[0]!.status).toBe('infra_error');
    },
  );

  it('names the model on a 400', async () => {
    const client = new OpenAICompatible({
      baseUrl: 'http://x/v1',
      model: 'vendor/no-such-model',
      fetch: statusFetch(400),
    });
    const error = await client.chat([{ role: 'user', content: 'hi' }]).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(InfraError);
    expect((error as Error).message).toContain('vendor/no-such-model');
    expect((error as Error).message).toContain('HTTP 400');
  });

  it('treats a 401 inside the stream as an infrastructure error', async () => {
    const fetch = (() =>
      Promise.resolve(
        sseResponse([`data: ${JSON.stringify({ error: { code: 401, message: 'bad key' } })}\n\n`]),
      )) as unknown as typeof globalThis.fetch;
    const client = new OpenAICompatible({ baseUrl: 'http://x/v1', model: 'm', fetch });
    await expect(client.chat([{ role: 'user', content: 'hi' }])).rejects.toBeInstanceOf(InfraError);
  });
});
