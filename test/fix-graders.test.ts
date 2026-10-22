import { describe, expect, it } from 'vitest';

import type {
  ChatClient,
  ChatRequest,
  Grader,
  GradeContext,
  Task,
  TranscriptEvent,
} from '../src/core/types.ts';
import { builtinGraders } from '../src/graders/builtin.ts';
import { codeGraders, factHolds, type FactMatcher } from '../src/graders/code.ts';
import { gradeTrial, registry } from '../src/graders/grade.ts';
import { matchAt, mismatchOf, parsePath, valueAt } from '../src/graders/matchers.ts';

const transcript: TranscriptEvent[] = [
  { type: 'message', at: 1, role: 'user', text: 'Welche Rechnungen sind offen?' },
  { type: 'message', at: 2, role: 'assistant', text: 'Offen ist RE-1.' },
];

function judgeClient(answer: (prompt: string) => string): ChatClient {
  return {
    complete(request: ChatRequest) {
      return Promise.resolve({ text: answer(request.messages.at(-1)?.content ?? '') });
    },
  };
}

const verdict = (v: string) => JSON.stringify({ reason: `because ${v}`, verdict: v });

const rubric = [
  { name: 'names', question: 'Does it name RE-1?', pass: 'yes', fail: 'no' },
  { name: 'numbers', question: 'Is every number right?', pass: 'yes', fail: 'no' },
  { name: 'tone', question: 'Is the tone polite?', pass: 'yes', fail: 'no' },
];

const judgeTask = (onUnknown?: string): Task => ({
  id: 't',
  input: { turns: ['Welche Rechnungen sind offen?'] },
  graders: [{ type: 'judge', rubric, ...(onUnknown ? { onUnknown } : {}) }],
});

describe('F1: onUnknown ignore sets aside only the unknown dimensions', () => {
  it('a failed dimension still fails the judge grader', async () => {
    const client = judgeClient((prompt) =>
      prompt.includes('Is every number')
        ? verdict('unknown')
        : prompt.includes('Is the tone')
          ? verdict('fail')
          : verdict('pass'),
    );
    const [result] = await gradeTrial(judgeTask('ignore'), transcript, null, {
      graders: builtinGraders(),
      judge: client,
    });
    expect(result).toMatchObject({ passed: false, unknown: true, weight: 1, score: 0.5 });
    expect(result!.assertions.map((a) => [a.name, a.unknown ?? false])).toEqual([
      ['names', false],
      ['numbers', true],
      ['tone', false],
    ]);
  });

  it('the decided dimensions decide: unknown ones are left out of the score', async () => {
    const client = judgeClient((prompt) =>
      prompt.includes('Is every number') ? verdict('unknown') : verdict('pass'),
    );
    const [result] = await gradeTrial(judgeTask('ignore'), transcript, null, {
      graders: builtinGraders(),
      judge: client,
    });
    expect(result).toMatchObject({ passed: true, unknown: true, weight: 1, score: 1 });
  });

  it('every dimension unknown sets the whole grader aside (weight 0)', async () => {
    const client = judgeClient(() => verdict('unknown'));
    const [result] = await gradeTrial(judgeTask('ignore'), transcript, null, {
      graders: builtinGraders(),
      judge: client,
    });
    expect(result).toMatchObject({ passed: true, unknown: true, weight: 0 });
  });

  it('onUnknown fail (the default) still fails on an unknown dimension', async () => {
    const client = judgeClient((prompt) =>
      prompt.includes('Is every number') ? verdict('unknown') : verdict('pass'),
    );
    const [result] = await gradeTrial(judgeTask(), transcript, null, {
      graders: builtinGraders(),
      judge: client,
    });
    expect(result).toMatchObject({ passed: false, unknown: true, weight: 1 });
  });

  it('works for any grader that marks its unknown assertions; an unmarked unknown sets the grader aside', async () => {
    const marked: Grader = {
      type: 'marked',
      kind: 'code',
      grade: () => ({
        unknown: true,
        assertions: [
          { name: 'a', passed: false },
          { name: 'b', passed: false, unknown: true },
        ],
      }),
    };
    const unmarked: Grader = {
      type: 'unmarked',
      kind: 'code',
      grade: () => ({ unknown: true, assertions: [{ name: 'a', passed: false }] }),
    };
    const task: Task = {
      id: 't',
      input: { turns: ['x'] },
      graders: [
        { type: 'marked', onUnknown: 'ignore' },
        { type: 'unmarked', onUnknown: 'ignore' },
      ],
    };
    const [a, b] = await gradeTrial(task, transcript, null, {
      graders: registry([marked, unmarked]),
    });
    expect(a).toMatchObject({ passed: false, weight: 1, score: 0 });
    expect(b).toMatchObject({ passed: true, weight: 0 });
  });
});

describe('F11: facts and forbid match the same text', () => {
  const context = (answer: string, user = 'Was steht da?'): GradeContext => ({
    task: { id: 't', input: { turns: [user] }, graders: [] },
    transcript: [
      { type: 'message', at: 1, role: 'user', text: user },
      { type: 'message', at: 2, role: 'assistant', text: answer },
    ],
    outcome: null,
    answer,
    finalAnswer: answer,
    target: 'a',
  });

  it('re: matches the raw text as well as the normalized text', () => {
    expect(factHolds('re:snake_case_name', 'The field is snake_case_name.')).toBe(true);
    expect(factHolds('re:\\*\\*warning\\*\\*', 'A **warning** here')).toBe(true);
    expect(factHolds('re:total: 5 €', 'The **total**:  5 €')).toBe(true);
    expect(factHolds('re:nothing', 'The total: 5 €')).toBe(false);
  });

  it('every custom matcher gets the raw text, from facts and from forbid alike', () => {
    const seen: string[] = [];
    const matcher: FactMatcher = {
      prefix: 'seen:',
      holds(fact, text) {
        seen.push(text);
        return text.includes(fact);
      },
    };
    const graders = new Map(codeGraders([matcher]).map((g) => [g.type, g]));
    const answer = 'Die Summe ist **1.234,56 €**.';
    const facts = graders.get('facts')!.grade(context(answer), {
      type: 'facts',
      facts: ['seen:**1.234,56'],
    }) as { assertions: { passed: boolean }[] };
    const forbid = graders.get('forbid')!.grade(context(answer), {
      type: 'forbid',
      patterns: ['seen:**1.234,56'],
    }) as { assertions: { passed: boolean }[] };
    expect(seen).toEqual([answer, answer]);
    expect(facts.assertions[0]!.passed).toBe(true);
    expect(forbid.assertions[0]!.passed).toBe(false);
  });

  it('an echo of the user is removed from the raw text too', () => {
    const user = 'Bitte prüfe die Rechnung RE-99 von snake_case GmbH genau.';
    const answer = `Sie fragten: "${user}" Ich finde sie nicht.`;
    const facts = new Map(codeGraders().map((g) => [g.type, g])).get('facts')!;
    const output = facts.grade(context(answer, user), {
      type: 'facts',
      facts: ['re:snake_case', 'RE-99', 're:finde sie nicht'],
    }) as { assertions: { passed: boolean }[] };
    expect(output.assertions.map((a) => a.passed)).toEqual([false, false, true]);
  });
});

describe('F12: a strict path parser', () => {
  const value = {
    a: { b: 1, list: [{ c: 'x' }, { c: 'y' }] },
    nested: [{ a: { b: 2 } }, { a: { other: 3 } }],
    'a.b': 'literal',
  };

  it('parses the supported forms', () => {
    expect(parsePath('')).toEqual({ segments: [] });
    expect(parsePath('.')).toEqual({ segments: [] });
    expect(parsePath('a.b')).toEqual({ segments: ['a', 'b'] });
    expect(parsePath('a[0]')).toEqual({ segments: ['a', 0] });
    expect(parsePath('a[0].b')).toEqual({ segments: ['a', 0, 'b'] });
    expect(parsePath('a[0][1]')).toEqual({ segments: ['a', 0, 1] });
    expect(parsePath('[2].a')).toEqual({ segments: [2, 'a'] });
    expect(parsePath('..key')).toEqual({ anywhere: 'key', segments: [] });
    expect(parsePath('..a.b')).toEqual({ anywhere: 'a', segments: ['b'] });
    expect(parsePath('..a[1].b')).toEqual({ anywhere: 'a', segments: [1, 'b'] });
  });

  it.each(['a[0]b', 'a..b', 'a[0', 'a]', 'a[x]', 'a[]', 'a.', '.a', '...a', '..', 'a.b..c'])(
    'refuses %s with an error naming the path',
    (path) => {
      expect(() => parsePath(path)).toThrow(`invalid path ${JSON.stringify(path)}`);
    },
  );

  it('..a.b looks for the key a anywhere, then b beneath it', () => {
    expect(matchAt(value, '..a.b', 2)).toBeNull();
    expect(matchAt(value, '..a.b', 1)).toBeNull();
    expect(matchAt(value, '..a.b', 3)).toMatch(/^\.\.a\.b: /);
    expect(matchAt(value, '..a.missing', { absent: true })).toBeNull();
    expect(matchAt(value, '..a.other', 3)).toBeNull();
    expect(valueAt(value, 'a.list[1].c')).toBe('y');
  });

  it('a bad path throws even where no value is matched, and mismatchOf checks every path first', () => {
    expect(() => matchAt(undefined, 'a[0]b', { absent: true })).toThrow(/invalid path "a\[0\]b"/);
    expect(() => mismatchOf({ a: 1 }, { a: 2, 'b[': 1 })).toThrow(/invalid path "b\["/);
  });

  it('tool_called checks its paths even when the tool was never called', async () => {
    const task: Task = {
      id: 't',
      input: { turns: ['x'] },
      graders: [{ type: 'tool_called', tool: 'search', args: { 'filter[0]x': 1 } }],
    };
    const [result] = await gradeTrial(task, transcript, null, { graders: builtinGraders() });
    expect(result?.error).toMatch(/invalid path "filter\[0\]x"/);
  });
});

describe('F11 review: the echo is stripped in linear time', () => {
  const graders = codeGradersForEcho();
  const facts = graders.find((g) => g.type === 'facts')!;
  const contextWith = (question: string, answer: string) => ({
    task: { id: 't', input: { turns: [question] }, graders: [] },
    transcript: [
      { type: 'message' as const, at: 1, role: 'user' as const, text: question },
      { type: 'message' as const, at: 2, role: 'assistant' as const, text: answer },
    ],
    outcome: null,
    answer,
    finalAnswer: answer,
    target: 't',
  });

  it('grades a bolded near-miss of a long question quickly', async () => {
    const words = Array.from({ length: 30 }, (_, i) => `word${i}`);
    const question = words.join(' ');
    const answer = [...words.slice(0, -1), 'different'].map((w) => `**${w}**`).join(' ');
    const started = Date.now();
    const output = await facts.grade(contextWith(question, answer), {
      type: 'facts',
      facts: ['re:different'],
    });
    expect(Date.now() - started).toBeLessThan(500);
    expect(output.assertions[0]!.passed).toBe(true);
  });

  it('handles a 10 KB user message without a regex error', async () => {
    const question = Array.from({ length: 1500 }, (_, i) => `item${i}`).join(' ');
    const output = await facts.grade(contextWith(question, `${question}\n\nThe total is 42.`), {
      type: 'facts',
      facts: ['re:item1499', '42'],
    });
    // The echoed question is stripped, so only the agent's own fact counts.
    expect(output.assertions.map((a) => a.passed)).toEqual([false, true]);
  });

  it('still strips a bolded echo from the raw text', async () => {
    const question = 'Which invoices from Schmidt are still open today?';
    const answer = `You asked: **Which invoices from Schmidt** are still open today? None.`;
    const output = await facts.grade(contextWith(question, answer), {
      type: 'facts',
      facts: ['re:schmidt'],
    });
    expect(output.assertions[0]!.passed).toBe(false);
  });
});

function codeGradersForEcho() {
  return codeGraders();
}
