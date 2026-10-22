import { describe, expect, it } from 'vitest';

import { scriptedAdapter } from '../src/adapters/scripted.ts';
import { resolveConfig } from '../src/config.ts';
import { defineSuite } from '../src/core/loader.ts';
import type { ChatClient, ChatRequest } from '../src/core/types.ts';
import { builtinGraders } from '../src/graders/builtin.ts';
import { regradeRun } from '../src/harness/regrade.ts';
import { runEval } from '../src/harness/run.ts';
import { validateSuite } from '../src/harness/validate.ts';

// The config's judge.toolResultMaxChars reaches every place a judge grades: a run, a regrade and validate.
const long = 'y'.repeat(1000);
const transcript = [
  { type: 'message', role: 'user', text: 'q' },
  { type: 'tool_call', id: 'c1', name: 'read', args: {} },
  { type: 'tool_result', id: 'c1', name: 'read', result: long },
  { type: 'message', role: 'assistant', text: 'a' },
] as const;
const suite = defineSuite({
  name: 'demo',
  kind: 'capability',
  tasks: [
    {
      id: 't',
      input: { turns: ['q'] },
      graders: [{ type: 'judge', rubric: { name: 'd', question: 'q?', pass: 'p', fail: 'f' } }],
      reference: { transcript: [...transcript] },
    },
  ],
});

function recordingJudge(): ChatClient & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    complete(request: ChatRequest) {
      prompts.push(request.messages.at(-1)?.content ?? '');
      return Promise.resolve({ text: '{"reason":"r","verdict":"pass"}' });
    },
  };
}

const target = {
  name: 'scripted',
  adapter: scriptedAdapter({ replayReference: true }),
};

describe("the config's judge.toolResultMaxChars", () => {
  it('is resolved from the judge block and checked', () => {
    const client = recordingJudge();
    expect(
      resolveConfig({ suites: [], targets: [], judge: { client, toolResultMaxChars: 1500 } }, '.')
        .judgeToolResultMaxChars,
    ).toBe(1500);
    expect(
      resolveConfig(
        { suites: [], targets: [], judge: { models: ['m'], toolResultMaxChars: 2000 } },
        '.',
        { OPENROUTER_API_KEY: 'k' },
      ).judgeToolResultMaxChars,
    ).toBe(2000);
    expect(
      resolveConfig({ suites: [], targets: [], judge: { client } }, '.').judgeToolResultMaxChars,
    ).toBe(undefined);
    expect(() =>
      resolveConfig({ suites: [], targets: [], judge: { client, toolResultMaxChars: 0 } }, '.'),
    ).toThrow(/toolResultMaxChars must be a positive whole number/);
  });

  it('reaches the judge in a run, a regrade and validate', async () => {
    const shows = (prompt: string | undefined) => prompt?.includes(`result: "${long}"`);
    const inRun = recordingJudge();
    const run = await runEval({
      suites: [suite],
      targets: [target],
      trials: 1,
      judge: inRun,
      judgeToolResultMaxChars: 2000,
    });
    expect(shows(inRun.prompts[0])).toBe(true);

    const inRegrade = recordingJudge();
    await regradeRun(run, {
      suites: [suite],
      graders: builtinGraders(),
      judge: inRegrade,
      judgeToolResultMaxChars: 2000,
    });
    expect(shows(inRegrade.prompts[0])).toBe(true);

    const inValidate = recordingJudge();
    await validateSuite(suite, {
      graders: builtinGraders(),
      judge: inValidate,
      judgeToolResultMaxChars: 2000,
    });
    expect(shows(inValidate.prompts[0])).toBe(true);

    // A bad value is refused before anything runs, never counted against the agent.
    const bad = { judge: recordingJudge(), judgeToolResultMaxChars: 0 };
    await expect(
      runEval({ suites: [suite], targets: [target], trials: 1, ...bad }),
    ).rejects.toThrow(
      /judgeToolResultMaxChars: toolResultMaxChars must be a positive whole number/,
    );
    await expect(
      regradeRun(run, { suites: [suite], graders: builtinGraders(), ...bad }),
    ).rejects.toThrow(/positive whole number/);
    await expect(validateSuite(suite, { graders: builtinGraders(), ...bad })).rejects.toThrow(
      /positive whole number/,
    );

    // Without it, the default cut.
    const byDefault = recordingJudge();
    await runEval({ suites: [suite], targets: [target], trials: 1, judge: byDefault });
    expect(shows(byDefault.prompts[0])).toBe(false);
  });
});

describe("a judge grader's toolResultMaxChars in a task file", () => {
  it('is checked when the suite loads', () => {
    const judged = (toolResultMaxChars: unknown) =>
      defineSuite({
        name: 's',
        kind: 'capability',
        tasks: [
          {
            id: 't',
            input: { turns: ['q'] },
            graders: [
              {
                type: 'judge',
                rubric: { name: 'd', question: 'q?', pass: 'p', fail: 'f' },
                toolResultMaxChars,
              },
            ],
          },
        ],
      });
    expect(() => judged(2000)).not.toThrow();
    expect(() => judged('2000')).toThrow(
      /task t: grader judge: toolResultMaxChars must be a positive whole number/,
    );
  });
});
