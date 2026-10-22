import { describe, expect, it } from 'vitest';

import { answerOf } from '../src/core/transcript.ts';
import type { GradeContext, GraderOutput, Task, TranscriptEvent } from '../src/core/types.ts';
import { codeGraders, factHolds, isQuestion, type FactMatcher } from '../src/graders/code.ts';

const task: Task = { id: 't', input: { turns: ['Hallo'] }, graders: [] };

function context(transcript: TranscriptEvent[], outcome?: unknown): GradeContext {
  return { task, transcript, outcome, ...answerOf(transcript), target: 'scripted' };
}

let clock = 0;
const user = (text: string): TranscriptEvent => ({
  type: 'message',
  at: clock++,
  role: 'user',
  text,
});
const assistant = (text: string): TranscriptEvent => ({
  type: 'message',
  at: clock++,
  role: 'assistant',
  text,
});
const call = (name: string, args: unknown, id = `c${clock}`): TranscriptEvent => ({
  type: 'tool_call',
  at: clock++,
  id,
  name,
  args,
});
const result = (id: string, name: string, error?: string): TranscriptEvent => ({
  type: 'tool_result',
  at: clock++,
  id,
  name,
  result: {},
  ...(error ? { error } : {}),
});
const modelCall = (): TranscriptEvent => ({
  type: 'model_call',
  at: clock,
  model: 'm',
  startedAt: clock,
  endedAt: clock++,
});

function grade(
  type: string,
  transcript: TranscriptEvent[],
  params: Record<string, unknown>,
  outcome?: unknown,
  matchers?: FactMatcher[],
) {
  const grader = codeGraders(matchers).find((g) => g.type === type);
  if (!grader) throw new Error(`no grader ${type}`);
  return grader.grade(context(transcript, outcome), {
    type,
    ...params,
  }) as GraderOutput;
}

const passed = (output: GraderOutput) => output.assertions.every((a) => a.passed);

describe('tool_called', () => {
  const transcript = [
    user('Zeig mir die Rechnung von Müller'),
    call('search_documents', { query: 'Müller', filter: { type: 'invoice' } }),
    call('open_document', { documentId: 'doc-42' }),
    assistant('Hier ist sie.'),
  ];

  it('passes when some call has the tool and matching args', () => {
    expect(
      passed(
        grade('tool_called', transcript, { tool: 'open_document', args: { documentId: 'DOC-42' } }),
      ),
    ).toBe(true);
    expect(
      passed(
        grade('tool_called', transcript, {
          tool: 're:^search_',
          args: { 'filter.type': { oneOf: ['invoice'] } },
        }),
      ),
    ).toBe(true);
  });

  it('fails on a call with the wrong args and says why', () => {
    const output = grade('tool_called', transcript, {
      tool: 'open_document',
      args: { documentId: 'doc-7' },
    });
    expect(passed(output)).toBe(false);
    expect(output.assertions[1]?.message).toMatch(/documentId: expected "doc-7"/);
    expect(output.assertions[1]?.actual).toEqual(['open_document({"documentId":"doc-42"})']);
  });

  it('fails when the tool was never called', () => {
    const output = grade('tool_called', transcript, { tool: 'delete_document' });
    expect(passed(output)).toBe(false);
    expect(output.assertions).toHaveLength(1);
  });

  it('checks the count of matching calls', () => {
    const twice = [...transcript, call('open_document', { documentId: 'doc-42' })];
    expect(passed(grade('tool_called', twice, { tool: 'open_document', count: 2 }))).toBe(true);
    expect(passed(grade('tool_called', twice, { tool: 'open_document', count: { max: 1 } }))).toBe(
      false,
    );
    expect(passed(grade('tool_called', transcript, { tool: 'delete_document', count: 0 }))).toBe(
      true,
    );
  });

  it('checks the first call: the tool chosen for the context', () => {
    expect(
      passed(grade('tool_called', transcript, { tool: 'search_documents', first: true })),
    ).toBe(true);
    const output = grade('tool_called', transcript, { tool: 'open_document', first: true });
    expect(passed(output)).toBe(false);
    expect(output.assertions.at(-1)?.message).toBe('the first call is search_documents');
  });

  it('throws without a tool', () => {
    expect(() => grade('tool_called', transcript, {})).toThrow(/needs tool/);
  });
});

describe('tool_not_called and tool_calls', () => {
  const transcript = [call('search', {}), call('search', { q: 1 }), call('open', {})];

  it('tool_not_called fails on any call of a named tool', () => {
    expect(passed(grade('tool_not_called', transcript, { tools: ['delete', 're:^approve'] }))).toBe(
      true,
    );
    const output = grade('tool_not_called', transcript, { tool: 'OPEN' });
    expect(passed(output)).toBe(false);
    expect(output.assertions[0]?.actual).toEqual(['open({})']);
  });

  it('tool_calls limits the calls overall or per tool', () => {
    expect(passed(grade('tool_calls', transcript, { max: 3 }))).toBe(true);
    expect(passed(grade('tool_calls', transcript, { max: 2 }))).toBe(false);
    expect(passed(grade('tool_calls', transcript, { tool: 'search', min: 2, max: 2 }))).toBe(true);
    expect(passed(grade('tool_calls', transcript, { tool: 'open', min: 2 }))).toBe(false);
  });
});

describe('no_placeholder_args', () => {
  it('catches a placeholder id, a hack that would pass a name-only check', () => {
    const output = grade(
      'no_placeholder_args',
      [call('open_document', { documentId: '<documentId>' })],
      {},
    );
    expect(passed(output)).toBe(false);
    expect(output.assertions[0]?.actual).toEqual(['open_document documentId="<documentId>"']);
    expect(
      passed(
        grade(
          'no_placeholder_args',
          [call('x', { ids: ['00000000-0000-0000-0000-000000000000'] })],
          {},
        ),
      ),
    ).toBe(false);
  });

  it('passes on real values and limits the check to tools', () => {
    expect(
      passed(grade('no_placeholder_args', [call('open', { documentId: 'doc-42', page: 1 })], {})),
    ).toBe(true);
    expect(
      passed(grade('no_placeholder_args', [call('note', { text: '' })], { tools: ['open'] })),
    ).toBe(true);
  });
});

describe('no_repeated_calls', () => {
  it('finds deep-equal repeated calls whatever the key order', () => {
    const output = grade(
      'no_repeated_calls',
      [call('search', { a: 1, b: 2 }), call('search', { b: 2, a: 1 })],
      {},
    );
    expect(passed(output)).toBe(false);
    expect(output.assertions[0]?.actual).toEqual(['search({"a":1,"b":2}) ×2']);
  });

  it('passes on different args and ignores polling tools', () => {
    expect(
      passed(
        grade('no_repeated_calls', [call('search', { q: 'a' }), call('search', { q: 'b' })], {}),
      ),
    ).toBe(true);
    expect(
      passed(
        grade('no_repeated_calls', [call('status', {}), call('status', {})], {
          ignore: ['status'],
        }),
      ),
    ).toBe(true);
    expect(
      passed(
        grade('no_repeated_calls', [call('status', {}), call('status', {})], { tools: ['search'] }),
      ),
    ).toBe(true);
  });
});

describe('outcome', () => {
  const state = { invoice: { status: 'approved', amount: 119.5 }, tasks: [{ open: false }] };

  it('matches paths of the outcome', () => {
    expect(
      passed(
        grade(
          'outcome',
          [],
          {
            expect: {
              'invoice.status': 'APPROVED',
              'invoice.amount': { min: 100 },
              'tasks[0].open': false,
            },
          },
          state,
        ),
      ),
    ).toBe(true);
    const output = grade('outcome', [], { expect: { 'invoice.status': 'rejected' } }, state);
    expect(passed(output)).toBe(false);
    expect(output.assertions[0]).toMatchObject({
      name: 'outcome invoice.status',
      actual: 'approved',
    });
  });

  it('compares the whole outcome', () => {
    expect(
      passed(
        grade(
          'outcome',
          [],
          { equals: { tasks: [{ open: false }], invoice: { amount: 119.5, status: 'approved' } } },
          state,
        ),
      ),
    ).toBe(true);
    expect(passed(grade('outcome', [], { expect: { '': { exists: true } } }, undefined))).toBe(
      false,
    );
  });

  it('ignores what the agent claims: only the outcome counts', () => {
    const claims = [assistant('Die Rechnung ist freigegeben.')];
    expect(
      passed(
        grade(
          'outcome',
          claims,
          { expect: { 'invoice.status': 'approved' } },
          { invoice: { status: 'open' } },
        ),
      ),
    ).toBe(false);
  });
});

describe('facts and forbid', () => {
  const transcript = [
    user('Wie hoch ist die Rechnung von Müller?'),
    assistant('Die Rechnung von **Müller GmbH** über 1.234,56 € ist am `2026-03-01` eingegangen.'),
  ];

  it('finds facts across Markdown and non-breaking spaces, with partial credit', () => {
    const output = grade('facts', transcript, {
      facts: ['müller gmbh', '1.234,56 €', ['1. März', '2026-03-01'], 'Kostenstelle 4711'],
    });
    expect(output.assertions.map((a) => a.passed)).toEqual([true, true, true, false]);
    expect(output.score).toBe(0.75);
  });

  it('supports re: facts', () => {
    expect(passed(grade('facts', transcript, { facts: ['re:1\\.234,56\\s*€'] }))).toBe(true);
  });

  it('does not credit an answer that only repeats the question', () => {
    const echo = [
      user('Ist die Rechnung RE-2026-001 von Müller schon bezahlt?'),
      assistant('Ist die Rechnung RE-2026-001 von Müller schon bezahlt?'),
    ];
    expect(passed(grade('facts', echo, { facts: ['RE-2026-001'] }))).toBe(false);
    expect(passed(grade('facts', echo, { facts: ['RE-2026-001'], allowEcho: true }))).toBe(true);
  });

  it('reads the final answer only when asked', () => {
    const two = [assistant('Erst: 42'), assistant('Dann: 43')];
    expect(passed(grade('facts', two, { facts: ['42'] }))).toBe(true);
    expect(passed(grade('facts', two, { facts: ['42'], on: 'final' }))).toBe(false);
  });

  it('uses a project fact matcher by prefix', () => {
    const amount: FactMatcher = {
      prefix: 'amount:',
      holds: (fact, text) => text.replace(/\./g, '').replace(',', '.').includes(fact),
    };
    expect(
      passed(grade('facts', transcript, { facts: ['amount:1234.56'] }, undefined, [amount])),
    ).toBe(true);
    expect(factHolds('amount:1234.56', 'Summe 1234.56', [])).toBe(false);
  });

  it('forbid fails when a pattern holds', () => {
    expect(
      passed(grade('forbid', transcript, { patterns: ['re:\\bIBAN\\b', 'Kostenstelle'] })),
    ).toBe(true);
    const output = grade('forbid', transcript, { patterns: ['re:müller', 'Meier'] });
    expect(output.assertions.map((a) => a.passed)).toEqual([false, true]);
  });
});

describe('limits', () => {
  const transcript = [
    user('a'),
    modelCall(),
    call('x', {}),
    modelCall(),
    assistant('b'),
    user('c'),
    modelCall(),
    assistant('d'),
  ];

  it('counts turns, model calls and tool calls', () => {
    expect(
      passed(grade('limits', transcript, { maxTurns: 2, maxModelCalls: 3, maxToolCalls: 1 })),
    ).toBe(true);
    const output = grade('limits', transcript, {
      maxUserTurns: 1,
      maxModelCalls: 2,
      maxToolCalls: 0,
    });
    expect(output.assertions.map((a) => [a.passed, a.actual])).toEqual([
      [false, 2],
      [false, 3],
      [false, 1],
    ]);
  });
});

describe('language', () => {
  it('passes German in German and fails English', () => {
    const de = [
      assistant(
        'Die Rechnung ist noch nicht bezahlt. Ich kann sie für Sie freigeben, wenn Sie das möchten.',
      ),
    ];
    const en = [
      assistant('The invoice has not been paid yet. I can approve it for you if you want.'),
    ];
    expect(passed(grade('language', de, { language: 'de' }))).toBe(true);
    expect(passed(grade('language', en, { language: 'de' }))).toBe(false);
    expect(passed(grade('language', en, { language: 'en' }))).toBe(true);
    expect(grade('language', en, { language: 'de' }).assertions[0]?.actual).toMatchObject({
      de: 0,
    });
  });

  it('ignores code and fails an empty answer', () => {
    const code = [assistant('Das ist der Befehl: ```\nthe a and of the to with from\n```')];
    expect(passed(grade('language', code, { language: 'de' }))).toBe(true);
    expect(passed(grade('language', [], { language: 'en' }))).toBe(false);
  });
});

describe('formality', () => {
  it('passes Sie and fails du-forms', () => {
    expect(
      passed(
        grade('formality', [assistant('Können Sie mir die Rechnungsnummer nennen?')], {
          language: 'de',
          register: 'formal',
        }),
      ),
    ).toBe(true);
    for (const text of [
      'Kannst du mir helfen?',
      'Ich schicke dir den Link.',
      'Deine Rechnung ist da.',
      'Euer Antrag',
      'Das betrifft euch.',
    ]) {
      expect(passed(grade('formality', [assistant(text)], {})), text).toBe(false);
    }
  });

  it('does not flag words that only contain du, nor code or link targets', () => {
    const text =
      'Das Produkt dürfen Sie durchsuchen. Siehe [Hilfe](https://x.de/du/dir) und `cd dir`.';
    expect(passed(grade('formality', [assistant(text)], {}))).toBe(true);
  });

  it('rejects a register it does not support', () => {
    expect(() => grade('formality', [], { register: 'informal' })).toThrow(/formal only/);
  });
});

describe('no_error', () => {
  it('fails on an agent error or a timeout, not on an infra error', () => {
    expect(
      passed(grade('no_error', [{ type: 'error', at: 1, kind: 'infra', message: 'down' }], {})),
    ).toBe(true);
    expect(
      passed(grade('no_error', [{ type: 'error', at: 1, kind: 'timeout', message: 'slow' }], {})),
    ).toBe(false);
  });

  it('fails on a tool error unless allowed', () => {
    const transcript = [call('open', {}, 'c1'), result('c1', 'open', 'not found')];
    expect(passed(grade('no_error', transcript, {}))).toBe(false);
    expect(passed(grade('no_error', transcript, { allowToolErrors: true }))).toBe(true);
    expect(passed(grade('no_error', [call('open', {}, 'c2'), result('c2', 'open')], {}))).toBe(
      true,
    );
  });
});

describe('asks_back', () => {
  it('recognises a question in the last paragraph', () => {
    expect(isQuestion('Ich habe zwei Rechnungen gefunden.\n\nWelche meinen Sie?')).toBe(true);
    expect(isQuestion('Welche meinen Sie? Ich warte.')).toBe(true);
    expect(isQuestion('**Welche meinen Sie?**')).toBe(true);
    // Seen in a live run: the question comes first, the options to choose from follow.
    expect(
      isQuestion(
        'Welche soll ich bezahlen?\n\n- **RE-1001**: 240,00 EUR\n- **RE-1007**: 89,90 EUR',
      ),
    ).toBe(true);
    expect(isQuestion('Siehe `GET /a?b=1` und [hier](https://x.de/?q=1).')).toBe(false);
    expect(isQuestion('Siehe https://x.de/a?b=1')).toBe(false);
  });

  it('passes a clarifying question without a write, fails one after a write', () => {
    const ask = [user('Gib die Rechnung frei'), assistant('Welche Rechnung meinen Sie?')];
    expect(
      passed(grade('asks_back', ask, { expected: true, writeTools: ['approve_invoice'] })),
    ).toBe(true);
    expect(passed(grade('asks_back', ask, { expected: false }))).toBe(false);
    const acted = [
      user('Gib die Rechnung frei'),
      call('approve_invoice', { id: 'inv-1' }),
      assistant('Erledigt. Noch etwas?'),
    ];
    expect(
      passed(grade('asks_back', acted, { expected: true, writeTools: ['approve_invoice'] })),
    ).toBe(false);
    expect(
      passed(grade('asks_back', acted, { expected: false, writeTools: ['approve_invoice'] })),
    ).toBe(true);
  });
});

describe('no_repeated_calls perTurn', () => {
  it('allows the same read again in a later turn, not twice in one turn', async () => {
    const { codeGraders } = await import('../src/graders/code.ts');
    const grader = codeGraders().find((g) => g.type === 'no_repeated_calls')!;
    const call = (at: number, id: string) => ({
      type: 'tool_call' as const,
      at,
      id,
      name: 'search',
      args: { q: 'x' },
    });
    const transcript = [
      { type: 'message' as const, at: 1, role: 'user' as const, text: 'a' },
      call(2, '1'),
      { type: 'message' as const, at: 3, role: 'user' as const, text: 'b' },
      call(4, '2'),
    ];
    const context = {
      task: { id: 't', input: {}, graders: [] },
      transcript,
      outcome: null,
      answer: '',
      finalAnswer: '',
      target: '',
    };
    const across = await grader.grade(context, { type: 'no_repeated_calls', perTurn: true });
    expect(across.assertions.every((a) => a.passed)).toBe(true);
    const plain = await grader.grade(context, { type: 'no_repeated_calls' });
    expect(plain.assertions.every((a) => a.passed)).toBe(false);
    const within = await grader.grade(
      { ...context, transcript: [...transcript, call(5, '3')] },
      { type: 'no_repeated_calls', perTurn: true },
    );
    expect(within.assertions.every((a) => a.passed)).toBe(false);
  });
});
