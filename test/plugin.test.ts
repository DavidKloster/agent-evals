import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { cliOptions, usage } from '../src/cli-spec.ts';
import { configKeys, resolveConfig, type EvalConfig } from '../src/config.ts';
import { builtinGraders } from '../src/graders/builtin.ts';
import { runEval } from '../src/harness/run.ts';

/**
 * The Claude Code plugin (docs/claude-code.md): the marketplace and plugin manifests, the skills' format, and the
 * skills' drift. Every CLI command, option, configuration key, grader type and code term a SKILL.md names must exist in
 * src/ and docs/ today, and every link must reach a file of this repository, so a rename breaks this test rather than
 * the skill.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Line endings as git checks them out on Windows don't matter.
const read = (path: string) => readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n');
const json = (path: string) => JSON.parse(read(path)) as Record<string, unknown>;
const repoUrl = 'https://github.com/DavidKloster/agent-evals';
const pluginDir = 'plugins/agent-evals';
const skillsDir = `${pluginDir}/skills`;
const skills = readdirSync(join(root, skillsDir), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const skillFile = (name: string) => `${skillsDir}/${name}/SKILL.md`;

/** A SKILL.md's frontmatter and body. */
function skill(name: string): { front: Record<string, unknown>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(read(skillFile(name)));
  if (!match) throw new Error(`${skillFile(name)} has no frontmatter`);
  return { front: parse(match[1]!) as Record<string, unknown>, body: match[2]! };
}

interface Code {
  where: string;
  text: string;
}

/** The code of a Markdown text: the fenced blocks (with their info words) and the inline code spans of the prose. */
function codeOf(
  file: string,
  text: string,
): { blocks: (Code & { info: string[] })[]; spans: Code[] } {
  const blocks: (Code & { info: string[] })[] = [];
  const spans: Code[] = [];
  let open: { line: number; info: string[]; indent: number; body: string[] } | null = null;
  text.split('\n').forEach((line, index) => {
    const fence = /^(\s*)```(.*)$/.exec(line);
    if (open) {
      if (fence) {
        blocks.push({ where: `${file}:${open.line}`, info: open.info, text: open.body.join('\n') });
        open = null;
      } else open.body.push(line.slice(open.indent));
      return;
    }
    if (fence) {
      open = {
        line: index + 1,
        info: fence[2]!.trim().split(/\s+/),
        indent: fence[1]!.length,
        body: [],
      };
      return;
    }
    for (const span of line.matchAll(/`([^`]+)`/g))
      spans.push({ where: `${file}:${index + 1}`, text: span[1]! });
  });
  return { blocks, spans };
}

/** The commands of the CLI's usage, each with the options its usage line names. */
const commands = new Map(
  [...usage.matchAll(/^ {2}([a-z]+)\b(.*)$/gm)].map((m) => [
    m[1]!,
    new Set([...m[2]!.matchAll(/--([a-z-]+)/g)].map((o) => o[1]!)),
  ]),
);
const options = new Set(Object.keys(cliOptions));
const graderTypes = new Set(builtinGraders().keys());
const docs = readdirSync(join(root, 'docs'))
  .filter((name) => name.endsWith('.md'))
  .map((name) => read(`docs/${name}`))
  .join('\n');
const cliDoc = read('docs/cli-and-config.md');
const gradersDoc = read('docs/graders.md');
/** Every word of the docs' code (spans and blocks): the keys and values a structured span may use. */
const docWords = new Set(
  [...docs.matchAll(/```[\s\S]*?```|`[^`\n]+`/g)].flatMap((m) => m[0].match(/[A-Za-z_]\w*/g) ?? []),
);
/** Every inline code term of the docs and every file name of the example and the templates. */
const docTerms = new Set([
  ...[...docs.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!.trim()),
  ...['examples', 'templates'].flatMap((dir) =>
    readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' }).map((path) =>
      path.split(sep).pop()!,
    ),
  ),
]);

/** A CLI call in a code span or a code block line: the command and the options it passes. */
function cliCall(text: string): { command: string; options: string[] } | null {
  const line = text.trim();
  const prefixed =
    /^(?:\w+=\S+ )*npx (?:--yes )?(?:@agent-evals\/core|agent-evals)(?:@\S+)? (\S+)(.*)$/.exec(
      line,
    );
  const bare = /^([a-z]+)\b(.*)$/.exec(line);
  const [, command, rest] = prefixed ?? (bare && commands.has(bare[1]!) ? bare : []);
  if (command === undefined) return null;
  return { command, options: [...rest!.matchAll(/--([a-z-]+)/g)].map((m) => m[1]!) };
}

describe('the marketplace and the plugin manifests', () => {
  const marketplace = json('.claude-plugin/marketplace.json');
  const plugin = json(`${pluginDir}/.claude-plugin/plugin.json`);
  const pkg = json('package.json');

  it('list the one plugin from its folder, without a second version', () => {
    expect(marketplace).toMatchObject({ name: 'agent-evals', owner: { name: 'David Kloster' } });
    expect(marketplace.plugins).toEqual([
      expect.objectContaining({ name: 'agent-evals', source: `./${pluginDir}` }),
    ]);
    // plugin.json carries the version; the entry's would be ignored at install time.
    expect((marketplace.plugins as Record<string, unknown>[])[0]).not.toHaveProperty('version');
  });

  it('keep the plugin in step with the package', () => {
    expect(plugin).toMatchObject({
      name: 'agent-evals',
      version: pkg.version,
      license: pkg.license,
      author: { name: pkg.author },
      repository: repoUrl,
    });
    // A plain string: an npm-style repository object fails the plugin's validation, and no email is published.
    expect(Object.keys(plugin.author as object)).toEqual(['name']);
    expect(String(plugin.homepage)).toMatch(new RegExp(`^${repoUrl}/`));
  });

  it("let release-please bump the plugin's version with the package's", () => {
    const config = json('release-please-config.json') as {
      packages: Record<string, { 'extra-files'?: unknown[] }>;
    };
    expect(config.packages['.']!['extra-files']).toContainEqual({
      type: 'json',
      path: `${pluginDir}/.claude-plugin/plugin.json`,
      jsonpath: '$.version',
    });
  });

  it('stay out of the npm package (the plugin installs from git)', () => {
    const files = pkg.files as string[];
    expect(files.filter((f) => /^(\.\/)?(plugins|\.claude-plugin)\b/.test(f))).toEqual([]);
  });
});

describe('the skills follow the Agent Skills format', () => {
  it('are there to check', () => {
    expect(skills).toEqual(['agent-evals', 'write-eval-task']);
  });
  for (const name of skills) {
    it(name, () => {
      const { front } = skill(name);
      expect(front.name).toBe(name);
      expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(name.length).toBeLessThanOrEqual(64);
      expect(typeof front.description).toBe('string');
      expect((front.description as string).length).toBeGreaterThan(0);
      expect((front.description as string).length).toBeLessThanOrEqual(1024);
      const allowed = [
        'name',
        'description',
        'license',
        'compatibility',
        'metadata',
        'allowed-tools',
      ];
      expect(Object.keys(front).filter((key) => !allowed.includes(key))).toEqual([]);
    });
  }
});

describe('the skills name only what exists', () => {
  it("the usage lists exactly the commands the CLI's switch runs", () => {
    const cases = [...read('src/cli.ts').matchAll(/^ {4}case '([a-z]+)':/gm)].map((m) => m[1]!);
    expect(cases.sort()).toEqual([...commands.keys()].sort());
  });

  for (const name of skills) {
    const file = skillFile(name);
    const { blocks, spans } = codeOf(file, skill(name).body);
    const lines: Code[] = [
      ...spans,
      ...blocks
        .filter((block) => block.info[0] !== 'yaml')
        .flatMap((block) => block.text.split('\n').map((text) => ({ where: block.where, text }))),
    ];

    describe(name, () => {
      it('CLI commands and their options', () => {
        const problems: string[] = [];
        let calls = 0;
        for (const { where, text } of lines) {
          const call = cliCall(text);
          if (!call) continue;
          calls++;
          if (call.command === 'help' || call.command === '<command>') continue;
          const known = commands.get(call.command);
          if (!known) {
            problems.push(`${where}: no command ${call.command}`);
            continue;
          }
          if (!cliDoc.includes(`### \`${call.command}\``))
            problems.push(`${where}: docs/cli-and-config.md has no section for ${call.command}`);
          for (const option of call.options)
            if (!known.has(option)) problems.push(`${where}: ${call.command} takes no --${option}`);
        }
        expect(problems).toEqual([]);
        expect(calls).toBeGreaterThan(0);
      });

      it('options anywhere in its code', () => {
        const problems = lines.flatMap(({ where, text }) =>
          [...text.matchAll(/(?<![\w-])--([a-z][a-z-]*)/g)]
            .map((m) => m[1]!)
            .filter((option) => !options.has(option) || !cliDoc.includes(`--${option}`))
            .map((option) => `${where}: no option --${option}`),
        );
        expect(problems).toEqual([]);
      });

      it('grader types', () => {
        // A table with a Grader column names only graders there.
        const tableGraders: Code[] = [];
        let column = -1;
        skill(name)
          .body.split('\n')
          .forEach((line, index) => {
            if (!line.startsWith('|')) return void (column = -1);
            const cells = line.split('|').slice(1, -1);
            if (column < 0) column = cells.findIndex((cell) => cell.trim() === 'Grader');
            else
              for (const span of (cells[column] ?? '').matchAll(/`([^`]+)`/g))
                if (!/^[-: ]+$/.test(cells[column]!))
                  tableGraders.push({ where: `${file}:${index + 1}`, text: span[1]! });
          });
        const named = [
          ...tableGraders,
          ...spans.filter(({ text }) => /^[a-z]+(_[a-z]+)+$/.test(text) || graderTypes.has(text)),
          ...blocks
            .filter((block) => block.info[0] === 'yaml')
            .flatMap((block) =>
              [...block.text.matchAll(/\btype: ([a-z_]+)/g)].map((m) => ({
                where: block.where,
                text: m[1]!,
              })),
            )
            .filter(({ text }) => !['tool_call', 'message', 'tool_result'].includes(text)),
        ];
        if (name === 'agent-evals') expect(tableGraders.length).toBeGreaterThanOrEqual(10);
        const problems = named
          .filter(({ text }) => !graderTypes.has(text) || !gradersDoc.includes(`### \`${text}\``))
          .map(({ where, text }) => `${where}: no grader ${text}`);
        expect(problems).toEqual([]);
      });

      it('configuration keys and adapters in its config blocks', () => {
        const configs = blocks.filter(
          (block) => block.info[0] === 'yaml' && block.info.includes('config'),
        );
        expect(configs.length).toBeGreaterThan(0);
        const problems: string[] = [];
        for (const block of configs) {
          const config = parse(block.text) as Record<string, unknown>;
          for (const key of Object.keys(config))
            if (!(configKeys as string[]).includes(key) || !cliDoc.includes(`| \`${key}\``))
              problems.push(`${block.where}: no configuration key ${key}`);
          for (const target of (config.targets ?? []) as { adapter?: string }[])
            if (!target.adapter || !cliDoc.includes(`**\`${target.adapter}\`**`))
              problems.push(`${block.where}: no adapter ${String(target.adapter)}`);
        }
        expect(problems).toEqual([]);
      });

      it('keys and values of its structured spans', () => {
        // `scoring: { mode: hybrid, threshold: 0.6 }`, `failedWrites: { length: 0 }`, `source:`: every key and word
        // value is a word of the docs' code.
        const words = (value: unknown): string[] =>
          value === null || typeof value !== 'object'
            ? typeof value === 'string' && /^[A-Za-z][\w-]*$/.test(value) && !value.includes('-')
              ? [value]
              : []
            : Object.entries(value).flatMap(([key, item]) => [
                ...(Array.isArray(value) ? [] : [key]),
                ...words(item),
              ]);
        const structured = spans.filter(({ text }) => /^(\{|[A-Za-z]\w*:( |$))/.test(text));
        const problems = structured.flatMap(({ where, text }) => {
          let value: unknown;
          try {
            value = parse(text);
          } catch {
            return [`${where}: \`${text}\` is not YAML`];
          }
          return words(value)
            .filter((word) => !docWords.has(word))
            .map((word) => `${where}: the docs never use ${word}`);
        });
        expect(problems).toEqual([]);
      });

      it('code terms the docs use', () => {
        // A bare term (a key, a dotted key, a value, a grader, a file name) is one the docs or the example use, a word
        // in capitals one the CLI prints; placeholders, paths with folders and commands are checked apart.
        const cli = read('src/cli.ts');
        const problems = spans
          .filter(({ text }) => /^[A-Za-z][\w.-]*$/.test(text))
          .filter(({ text }) => !commands.has(text) && !skills.includes(text))
          .filter(({ text }) =>
            /^[A-Z]+$/.test(text) ? !cli.includes(`'${text}`) : !docTerms.has(text),
          )
          .map(({ where, text }) => `${where}: neither the docs nor the CLI name \`${text}\``);
        expect(problems).toEqual([]);
      });

      it("the package's files it points at", () => {
        const pkg = json('package.json');
        const problems = spans
          .flatMap(({ where, text }) =>
            [...text.matchAll(/node_modules\/@agent-evals\/core\/([\w./-]+)/g)].map((m) => ({
              where,
              path: m[1]!,
            })),
          )
          .filter(
            ({ path }) =>
              !existsSync(join(root, path)) ||
              !(pkg.files as string[]).includes(path.split('/')[0]!),
          )
          .map(({ where, path }) => `${where}: the package ships no ${path}`);
        expect(problems).toEqual([]);
      });

      it('links: only to files of this repository', () => {
        const targets = [...skill(name).body.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]!);
        expect(targets.length).toBeGreaterThan(0);
        const problems = targets.flatMap((target) => {
          // A file, not a heading: an anchor that drifts would go unnoticed.
          const path = new RegExp(`^${repoUrl}/(?:blob|tree)/main/([^#?]+)$`).exec(target)?.[1];
          if (!path)
            return [
              `${file}: ${target} is not a file of ${repoUrl} (an installed skill has no docs/)`,
            ];
          return existsSync(join(root, path)) ? [] : [`${file}: ${path} does not exist`];
        });
        expect(problems).toEqual([]);
      });
    });
  }
});

describe("the skills' config blocks run", () => {
  const configBlock = (name: string) =>
    codeOf(skillFile(name), skill(name).body).blocks.find(
      (b) => b.info[0] === 'yaml' && b.info.includes('config'),
    )!.text;
  const example = join(root, 'examples', 'invoice-desk');

  it("agent-evals: the dry run is the example's", () => {
    expect(parse(configBlock('agent-evals'))).toEqual(
      parse(readFileSync(join(example, 'eval.replay.yaml'), 'utf8')),
    );
  });

  it('write-eval-task: the replay of a reported failure fails the grader written for it', async () => {
    // The example's task from a report (asked about the status, the agent paid), with the skill's placeholders filled.
    const taskId = 'from-report-status-not-pay';
    const text = configBlock('write-eval-task')
      .replaceAll('<task-id>', taskId)
      .replaceAll('<tool>', 'pay_invoice')
      .replaceAll('args: {}', 'args: { number: RE-1007 }')
      .replaceAll('<its error>', 'only an open invoice can be paid')
      .replaceAll('<the bad answer>', 'I tried to pay RE-1007, but the payment failed.');
    expect(text).not.toMatch(/<[a-z -]+>/);
    const resolved = resolveConfig(parse(text) as EvalConfig, example, {});
    const run = await runEval({ ...resolved, tasks: [taskId], trialsOverride: 1 });
    expect(run.trials).toHaveLength(1);
    const [trial] = run.trials;
    expect(trial!.passed).toBe(false);
    expect(trial!.grades.find((grade) => grade.type === 'tool_not_called')?.passed).toBe(false);
  });
});
