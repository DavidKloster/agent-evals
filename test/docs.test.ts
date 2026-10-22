import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { parseTasks } from '../src/core/loader.ts';
import { suiteSchema } from '../src/core/schema.ts';

/**
 * The documentation's code samples are tests. In README.md and docs/ (the maintainers' notes left out):
 * - a `ts doctest` block is a complete ES module: it is written to a temporary file, with the package's name pointing
 *   at src/index.ts, imported, and must not throw;
 * - a `yaml task` block is a complete task file (or a list of tasks) and must load;
 * - a `yaml suite` block is a complete suite file and must match the suite format.
 * Every relative link of README.md and docs/ (the maintainers' notes included) must point to a file that exists.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(root, 'src', 'index.ts');
const packageName = '@agent-evals/core';

function markdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((item) => {
      const path = join(dir, item.name);
      if (item.isDirectory()) return markdownFiles(path);
      return item.isFile() && item.name.endsWith('.md') ? [path] : [];
    })
    .sort();
}

const readme = join(root, 'README.md');
const docsDir = join(root, 'docs');
const maintainersDir = join(docsDir, 'maintainers');
const isMaintainers = (file: string) => file.startsWith(maintainersDir + sep);
const allFiles = [...(existsSync(readme) ? [readme] : []), ...markdownFiles(docsDir)];
const sampleFiles = allFiles.filter((file) => !isMaintainers(file));

interface Block {
  file: string;
  /** The 1-based line of the opening fence. */
  line: number;
  info: string[];
  code: string;
}

interface Fence {
  char: string;
  length: number;
  indent: number;
  line: number;
  info: string[];
  body: string[];
}

/** The fenced code blocks of a Markdown file, with their info words and their lines' common indentation removed. */
function fencedBlocks(file: string): Block[] {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const blocks: Block[] = [];
  let open: Fence | null = null;
  lines.forEach((text, index) => {
    const fence = /^( {0,3}|\s*)(`{3,}|~{3,})(.*)$/.exec(text);
    if (open === null) {
      if (fence && !(fence[2]!.startsWith('`') && fence[3]!.includes('`'))) {
        open = {
          char: fence[2]![0]!,
          length: fence[2]!.length,
          indent: fence[1]!.length,
          line: index + 1,
          info: fence[3]!.trim().split(/\s+/).filter(Boolean),
          body: [],
        };
      }
      return;
    }
    const current: Fence = open;
    if (
      fence &&
      fence[2]![0] === current.char &&
      fence[2]!.length >= current.length &&
      fence[3]!.trim() === ''
    ) {
      blocks.push({
        file,
        line: current.line,
        info: current.info,
        code: current.body.join('\n'),
      });
      open = null;
      return;
    }
    current.body.push(text.slice(Math.min(current.indent, text.length - text.trimStart().length)));
  });
  return blocks;
}

/** The text of a file with its code blocks and code spans blanked, so their brackets aren't read as links. */
function proseOf(file: string): string[] {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  let fence: string | null = null;
  return lines.map((text) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(text)?.[1];
    if (fence === null && marker) {
      fence = marker;
      return '';
    }
    if (fence !== null) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      return '';
    }
    return text.replace(/`+[^`]*`+/g, '');
  });
}

/** The relative link targets of a file with their lines: inline links, images and reference definitions. */
function relativeLinks(file: string): { line: number; target: string }[] {
  const links: { line: number; target: string }[] = [];
  proseOf(file).forEach((text, index) => {
    const targets = [
      ...[...text.matchAll(/!?\[[^\]]*\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+["'(][^)]*)?\)/g)].map(
        (m) => m[1]!,
      ),
      ...[...text.matchAll(/^\s{0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/g)].map((m) => m[1]!),
    ];
    for (const raw of targets) {
      const target = raw.replace(/^<|>$/g, '');
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue;
      links.push({ line: index + 1, target });
    }
  });
  return links;
}

const nameOf = (block: { file: string; line: number }) =>
  `${relative(root, block.file).split(sep).join('/')}:${block.line}`;

const blocks = sampleFiles.flatMap(fencedBlocks);
const has = (block: Block, lang: string[], word: string) =>
  lang.includes(block.info[0] ?? '') && block.info.slice(1).includes(word);
const doctests = blocks.filter((block) => has(block, ['ts', 'typescript'], 'doctest'));
const taskBlocks = blocks.filter((block) => has(block, ['yaml', 'yml'], 'task'));
const suiteBlocks = blocks.filter((block) => has(block, ['yaml', 'yml'], 'suite'));

let tempDir: string | undefined;
const temp = () => (tempDir ??= mkdtempSync(join(tmpdir(), 'agent-evals-doctest-')));

afterAll(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

describe('the documentation', () => {
  it('is there to check', () => {
    expect(allFiles).toContain(readme);
  });
});

describe('ts doctest blocks run', () => {
  for (const block of doctests) {
    it(nameOf(block), { timeout: 60_000 }, async () => {
      // A Windows path in a string literal would lose its backslashes as escapes; Vite takes forward slashes.
      const code = block.code.replace(/(['"])@agent-evals\/core\1/g, () =>
        JSON.stringify(entry.split(sep).join('/')),
      );
      const file = join(
        temp(),
        `${nameOf(block).replace(/[^a-zA-Z0-9]+/g, '-')}-${doctests.indexOf(block)}.ts`,
      );
      writeFileSync(file, code);
      await expect(import(/* @vite-ignore */ pathToFileURL(file).href)).resolves.toBeDefined();
    });
  }
  it(`import the package as ${packageName}, never by a relative path`, () => {
    const relativeImports = doctests
      .filter((block) => /(from|import)\s*\(?\s*['"]\.{1,2}\//.test(block.code))
      .map(nameOf);
    expect(relativeImports).toEqual([]);
  });
});

// A describe without tests fails, and a file may hold no block of a kind yet.
const describeBlocks = (name: string, items: Block[], body: () => void) => {
  if (items.length > 0) describe(name, body);
};

describeBlocks('yaml task blocks load', taskBlocks, () => {
  for (const block of taskBlocks) {
    it(nameOf(block), () => {
      expect(parseTasks(parse(block.code), nameOf(block)).length).toBeGreaterThan(0);
    });
  }
});

describeBlocks('yaml suite blocks match the suite format', suiteBlocks, () => {
  for (const block of suiteBlocks) {
    it(nameOf(block), () => {
      const result = suiteSchema.safeParse(parse(block.code));
      expect(result.error?.issues ?? []).toEqual([]);
    });
  }
});

describe('relative links point to existing files', () => {
  for (const file of allFiles) {
    it(relative(root, file).split(sep).join('/'), () => {
      const broken = relativeLinks(file)
        .filter(({ target }) => {
          const path = decodeURIComponent(target.replace(/[#?].*$/, ''));
          return path !== '' && !existsSync(resolve(dirname(file), path));
        })
        .map(({ line, target }) => `${nameOf({ file, line })} → ${target}`);
      expect(broken).toEqual([]);
    });
  }
});
