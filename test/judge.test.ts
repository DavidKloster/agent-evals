import { describe, expect, it } from 'vitest';

import { answerOf } from '../src/core/transcript.ts';
import type {
  ChatClient,
  ChatRequest,
  GradeContext,
  Task,
  TranscriptEvent,
} from '../src/core/types.ts';
import { builtinGraders } from '../src/graders/builtin.ts';
import { gradeTrial } from '../src/graders/grade.ts';
import {
  comparePair,
  consensus,
  modelGraders,
  parseVerdict,
  type JudgeDetails,
  type JudgeSpec,
} from '../src/graders/judge.ts';

/** A judge that answers from a script: a function of the request, so parallel calls stay deterministic. */
function scripted(
  answer: (request: ChatRequest, prompt: string) => string,
): ChatClient & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    requests,
    complete(request) {
      requests.push(request);
      return Promise.resolve({ text: answer(request, request.messages.at(-1)?.content ?? '') });
    },
  };
}

const verdict = (v: string, reason = `because ${v}`) => JSON.stringify({ reason, verdict: v });

const transcript: TranscriptEvent[] = [
  { type: 'message', at: 1, role: 'user', text: 'Welche Rechnungen von Müller sind offen?' },
  {
    type: 'tool_call',
    at: 2,
    id: 'c1',
    name: 'search_invoices',
    args: { vendor: 'Müller', status: 'open' },
  },
  {
    type: 'tool_result',
    at: 3,
    id: 'c1',
    name: 'search_invoices',
    result: { items: [{ number: 'RE-1' }] },
  },
  { type: 'message', at: 4, role: 'assistant', text: 'Offen ist RE-1 über 119,50 €.' },
];

const task: Task = {
  id: 't',
  input: { turns: ['Welche Rechnungen von Müller sind offen?'] },
  graders: [],
};

const rubric = [
  {
    name: 'correct',
    question: 'Does the answer name the open invoices?',
    pass: 'It names RE-1.',
    fail: 'It misses RE-1.',
  },
  {
    name: 'grounded',
    question: 'Is every number from a tool result?',
    pass: 'All from results.',
    fail: 'Invented numbers.',
  },
];

function context(judge?: ChatClient, judgeModels?: string[]): GradeContext {
  return {
    task,
    transcript,
    outcome: undefined,
    ...answerOf(transcript),
    target: 'x',
    judge,
    judgeModels,
  };
}

const judge = modelGraders()[0]!;

async function run(client: ChatClient, spec: Partial<JudgeSpec>, models?: string[]) {
  return judge.grade(context(client, models), { type: 'judge', rubric, ...spec });
}

describe('judge', () => {
  it('makes one isolated call per dimension and model', async () => {
    const client = scripted(() => verdict('pass'));
    const output = await run(client, { models: ['m1', 'm2', 'm3'] });
    expect(client.requests).toHaveLength(6);
    for (const request of client.requests) {
      const prompt = request.messages.at(-1)?.content ?? '';
      // Each call asks exactly one dimension.
      expect(prompt.includes('Does the answer name') !== prompt.includes('Is every number')).toBe(
        true,
      );
      expect(request.json).toBe(true);
      expect(request.temperature).toBe(0);
    }
    expect(client.requests.map((r) => r.model).sort()).toEqual([
      'm1',
      'm1',
      'm2',
      'm2',
      'm3',
      'm3',
    ]);
    expect(output.assertions.map((a) => [a.name, a.passed])).toEqual([
      ['correct', true],
      ['grounded', true],
    ]);
    expect(output.unknown).toBe(false);
  });

  it('shows the input, tool calls and answer by default, with the dimension and the unknown option', async () => {
    const client = scripted(() => verdict('pass'));
    await run(client, { rubric: rubric[0], instructions: 'Amounts are in EUR.' });
    const prompt = client.requests[0]?.messages.at(-1)?.content ?? '';
    expect(prompt).toContain('User message 1: Welche Rechnungen von Müller sind offen?');
    expect(prompt).toContain('search_invoices({"vendor":"Müller","status":"open"})');
    expect(prompt).toContain('RE-1');
    expect(prompt).toContain('Offen ist RE-1 über 119,50 €.');
    expect(prompt).toContain('Pass when: It names RE-1.');
    expect(prompt).toContain('Fail when: It misses RE-1.');
    expect(prompt).toContain('Notes: Amounts are in EUR.');
    expect(prompt).toMatch(/"unknown" when/);
    expect(prompt.indexOf('"reason"')).toBeLessThan(prompt.indexOf('"verdict"'));
    expect(prompt).not.toContain('final state');
  });

  it('uses the run judge models, else the client default', async () => {
    const client = scripted(() => verdict('pass'));
    await run(client, { rubric: rubric[0] }, ['run-model']);
    await run(client, { rubric: rubric[0] });
    expect(client.requests.map((r) => r.model)).toEqual(['run-model', undefined]);
  });

  it('takes the majority across judge models and reports the votes', async () => {
    const client = scripted((request, prompt) =>
      prompt.includes('Does the answer name')
        ? verdict(request.model === 'm3' ? 'fail' : 'pass')
        : verdict('fail'),
    );
    const output = await run(client, { models: ['m1', 'm2', 'm3'] });
    const details = output.details as JudgeDetails;
    expect(details.dimensions.map((d) => [d.name, d.verdict])).toEqual([
      ['correct', 'pass'],
      ['grounded', 'fail'],
    ]);
    expect(details.dimensions[0]?.votes).toEqual([
      { model: 'm1', verdict: 'pass', reason: 'because pass' },
      { model: 'm2', verdict: 'pass', reason: 'because pass' },
      { model: 'm3', verdict: 'fail', reason: 'because fail' },
    ]);
    expect(details.dimensions[0]?.question).toBe('Does the answer name the open invoices?');
    expect(output.assertions.map((a) => a.passed)).toEqual([true, false]);
  });

  it('marks the output unknown when a dimension is unknown, and gradeTrial applies onUnknown', async () => {
    const client = scripted((_, prompt) =>
      prompt.includes('Is every number') ? verdict('unknown') : verdict('pass'),
    );
    const output = await run(client, {});
    expect(output.unknown).toBe(true);
    expect(output.assertions[1]).toMatchObject({ passed: false, actual: 'unknown' });

    const withGraders = (onUnknown?: string): Task => ({
      ...task,
      graders: [{ type: 'judge', rubric, ...(onUnknown ? { onUnknown } : {}) }],
    });
    const [failed] = await gradeTrial(withGraders(), transcript, undefined, {
      graders: builtinGraders(),
      judge: client,
    });
    expect(failed).toMatchObject({ passed: false, unknown: true });
    const [ignored] = await gradeTrial(withGraders('ignore'), transcript, undefined, {
      graders: builtinGraders(),
      judge: client,
    });
    expect(ignored).toMatchObject({ passed: true, weight: 1, score: 1 });
  });

  it('throws without a judge client or a rubric', async () => {
    await expect(
      Promise.resolve(judge.grade(context(), { type: 'judge', rubric })),
    ).rejects.toThrow('the judge grader needs a judge client');
    await expect(
      run(
        scripted(() => ''),
        { rubric: [] },
      ),
    ).rejects.toThrow(/rubric/);
  });
});

describe('parseVerdict and consensus', () => {
  it('parses fenced JSON, extra text and odd case', () => {
    expect(parseVerdict('```json\n{"reason": "ok", "verdict": "PASS"}\n```')).toEqual({
      verdict: 'pass',
      reason: 'ok',
    });
    expect(parseVerdict('Sure! {"reason": "no RE-1", "verdict": "fail"} Hope it helps.')).toEqual({
      verdict: 'fail',
      reason: 'no RE-1',
    });
    expect(parseVerdict('{"reason": "cut off", "verdict": "pass"')).toMatchObject({
      verdict: 'pass',
    });
  });

  it('turns an unparseable answer into unknown with the raw text', () => {
    expect(parseVerdict('I think it is fine.')).toEqual({
      verdict: 'unknown',
      reason: 'unparseable judge answer: I think it is fine.',
    });
    expect(parseVerdict('{"verdict": "maybe"}').verdict).toBe('unknown');
  });

  it('decides by majority; ties and mostly unknown are unknown', () => {
    expect(consensus(['pass'])).toBe('pass');
    expect(consensus(['pass', 'pass', 'fail'])).toBe('pass');
    expect(consensus(['pass', 'fail'])).toBe('unknown');
    expect(consensus(['pass', 'fail', 'unknown'])).toBe('unknown');
    expect(consensus(['pass', 'unknown', 'unknown'])).toBe('unknown');
    expect(consensus(['fail', 'fail', 'unknown'])).toBe('fail');
  });
});

describe('comparePair', () => {
  const answer = (text: string): TranscriptEvent[] => [
    { type: 'message', at: 1, role: 'assistant', text },
  ];
  const a = { label: 'model-a', transcript: answer('GOOD answer') };
  const b = { label: 'model-b', transcript: answer('BAD answer') };
  const winnerIs = (prompt: string, text: string) => {
    // "1" when the text is in the first response.
    const first = prompt.indexOf('## Response 1');
    const second = prompt.indexOf('## Response 2');
    const at = prompt.indexOf(text);
    return JSON.stringify({ reason: 'r', winner: at > first && at < second ? '1' : '2' });
  };

  it('asks in both orders and finds a consistent winner', async () => {
    const client = scripted((_, prompt) => winnerIs(prompt, 'GOOD answer'));
    const result = await comparePair({
      client,
      input: 'Find the invoice',
      criterion: 'Which is better?',
      a,
      b,
    });
    expect(client.requests).toHaveLength(2);
    const prompts = client.requests.map((r) => r.messages.at(-1)?.content ?? '');
    expect(prompts[0]!.indexOf('GOOD')).toBeLessThan(prompts[0]!.indexOf('BAD'));
    expect(prompts[1]!.indexOf('BAD')).toBeLessThan(prompts[1]!.indexOf('GOOD'));
    expect(prompts[0]).not.toContain('model-a');
    expect(result.winner).toBe('a');
    expect(result.winnerLabel).toBe('model-a');
    expect(result.votes.map((v) => [v.order, v.winner])).toEqual([
      ['ab', 'a'],
      ['ba', 'a'],
    ]);
  });

  it('counts a position-biased judge as a tie', async () => {
    const client = scripted(() => JSON.stringify({ reason: 'first is better', winner: '1' }));
    const result = await comparePair({
      client,
      input: { turns: ['x'] },
      criterion: 'Which is better?',
      a,
      b,
    });
    expect(result.winner).toBe('tie');
    expect(result.winnerLabel).toBeUndefined();
  });

  it('takes the majority across models', async () => {
    const client = scripted((request, prompt) =>
      request.model === 'm3'
        ? JSON.stringify({ winner: 'unknown' })
        : winnerIs(prompt, 'BAD answer'),
    );
    const result = await comparePair({
      client,
      models: ['m1', 'm2', 'm3'],
      input: 'x',
      criterion: 'c',
      a,
      b,
    });
    expect(client.requests).toHaveLength(6);
    expect(result.winner).toBe('b');
  });
});

describe('judge infrastructure errors', () => {
  it('retries a busy judge, then hands the harness an InfraError instead of failing the agent', async () => {
    const { modelGraders, setJudgeRetryMs } = await import('../src/graders/judge.ts');
    const { InfraError } = await import('../src/core/types.ts');
    setJudgeRetryMs(0);
    const grader = modelGraders().find((g) => g.type === 'judge')!;
    let calls = 0;
    const busyOnce: ChatClient = {
      complete: () =>
        ++calls === 1
          ? Promise.reject(new InfraError('HTTP 429'))
          : Promise.resolve({ text: '{"reason":"ok","verdict":"pass"}' }),
    };
    const spec = { type: 'judge', rubric: { name: 'd', question: 'q?', pass: 'p', fail: 'f' } };
    const base = {
      task: { id: 't', input: { turns: ['x'] }, graders: [] },
      transcript: [],
      outcome: null,
      answer: 'a',
      finalAnswer: 'a',
      target: 't',
    };
    const ok = await grader.grade({ ...base, judge: busyOnce }, spec);
    expect(ok.assertions[0]!.passed).toBe(true);
    expect(calls).toBe(2);
    const down: ChatClient = { complete: () => Promise.reject(new InfraError('HTTP 503')) };
    await expect(
      Promise.resolve(grader.grade({ ...base, judge: down }, spec)),
    ).rejects.toMatchObject({ name: 'InfraError' });
  });
});

describe('toolResultMaxChars: how much of each tool result the judge sees', () => {
  const long = 'x'.repeat(1000);
  const withResult: TranscriptEvent[] = [
    { type: 'message', at: 1, role: 'user', text: 'q' },
    { type: 'tool_call', at: 2, id: 'c1', name: 'read', args: {} },
    { type: 'tool_result', at: 3, id: 'c1', name: 'read', result: long },
    { type: 'message', at: 4, role: 'assistant', text: 'a' },
  ];
  // JSON.stringify adds the two quotes: the result is 1002 characters as the judge reads it.
  const promptOf = async (spec: Partial<JudgeSpec>, judgeToolResultMaxChars?: number) => {
    const client = scripted(() => verdict('pass'));
    await judge.grade(
      {
        ...context(client),
        transcript: withResult,
        ...answerOf(withResult),
        ...(judgeToolResultMaxChars === undefined ? {} : { judgeToolResultMaxChars }),
      },
      { type: 'judge', rubric: rubric[0]!, ...spec },
    );
    return client.requests[0]?.messages.at(-1)?.content ?? '';
  };

  it('cuts a result at 600 characters by default', async () => {
    const prompt = await promptOf({});
    expect(prompt).toContain(`result: "${'x'.repeat(599)}… (402 more characters)`);
  });

  it("takes the grader's own value over the run's", async () => {
    expect(await promptOf({ toolResultMaxChars: 2000 }, 100)).toContain(`result: "${long}"\n`);
    expect(await promptOf({ toolResultMaxChars: 50 })).toContain('… (952 more characters)');
  });

  it("takes the run's value (the config's judge.toolResultMaxChars) when the grader has none", async () => {
    expect(await promptOf({}, 100)).toContain('… (902 more characters)');
  });

  it('refuses a value that is not a positive whole number', async () => {
    for (const bad of [0, -1, 1.5, '600'])
      await expect(promptOf({ toolResultMaxChars: bad as number })).rejects.toThrow(
        /toolResultMaxChars must be a positive whole number/,
      );
  });

  it('cuts the results comparePair shows with its own option', async () => {
    const client = scripted(() => JSON.stringify({ reason: 'r', winner: 'tie' }));
    const candidate = (label: string) => ({ label, transcript: withResult });
    await comparePair({
      client,
      input: 'q',
      criterion: 'c',
      a: candidate('a'),
      b: candidate('b'),
      toolResultMaxChars: 2000,
    });
    expect(client.requests[0]?.messages.at(-1)?.content).toContain(`result: "${long}"\n`);
  });
});
