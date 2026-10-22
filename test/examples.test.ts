import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadConfig, resolveConfig } from '../src/config.ts';
import { runEval } from '../src/harness/run.ts';
import { validateSuite } from '../src/harness/validate.ts';

const examples = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'invoice-desk');

describe('the invoice desk example', () => {
  it('has a reference solution for every task that its graders accept', async () => {
    const { config, baseDir } = await loadConfig(join(examples, 'eval.replay.yaml'));
    const resolved = resolveConfig(config, baseDir, {});
    for (const suite of resolved.suites) {
      const check = await validateSuite(suite, { graders: resolved.graders });
      expect(check.tasks.filter((t) => !t.ok)).toEqual([]);
    }
  });

  it('passes every trial of its dry run, the simulated user replayed from the reference', async () => {
    const { config, baseDir } = await loadConfig(join(examples, 'eval.replay.yaml'));
    const resolved = resolveConfig(config, baseDir, {});
    const run = await runEval({ ...resolved, trialsOverride: 1 });
    expect(run.trials.filter((t) => !t.passed).map((t) => t.taskId)).toEqual([]);
    expect(run.trials).toHaveLength(10);
    expect(run.meta).toMatchObject({ modelGraders: 'skipped' });
  });

  it('resolves the live config without calling a model, and refuses it without a key', async () => {
    const { config, baseDir } = await loadConfig(join(examples, 'eval.config.yaml'));
    expect(() => resolveConfig(config, baseDir, {})).toThrow(/OPENROUTER_API_KEY/);
    const resolved = resolveConfig(config, baseDir, { OPENROUTER_API_KEY: 'test-key' });
    expect(resolved.targets.map((t) => t.name)).toEqual(['claude-haiku-5.5', 'claude-sonnet-5.5']);
    expect(resolved.judgeModels).toEqual(['anthropic/claude-sonnet-5.5']);
  });
});
