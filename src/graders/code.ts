import { messages, toolUses, type ToolUse } from '../core/transcript.ts';
import type { Assertion, GradeContext, Grader, GraderOutput, GraderSpec } from '../core/types.ts';
import {
  brief,
  canonicalJson,
  checkPaths,
  deepEqual,
  isPlaceholder,
  matchAt,
  matchValue,
  mismatchOf,
  regexOf,
  stringLeaves,
  valueAt,
  type Matcher,
} from './matchers.ts';

/**
 * The code-based graders: fast, cheap and reproducible, so they come first (the article's advice). They grade the
 * outcome and what the agent did, never one exact path: a tool call is found anywhere in the trial unless `first` asks
 * for the first one.
 */

type Range = number | { min?: number; max?: number };

function inRange(n: number, range: Range): boolean {
  if (typeof range === 'number') return n === range;
  return (range.min === undefined || n >= range.min) && (range.max === undefined || n <= range.max);
}

/** A tool name pattern: the name ignoring case, or `re:` for a regex. */
function nameMatches(name: string, pattern: string): boolean {
  return matchValue(name, pattern) === null;
}

function anyName(name: string, patterns: string[]): boolean {
  return patterns.some((pattern) => nameMatches(name, pattern));
}

/** The calls as the report shows them: name and shortened arguments. */
function summary(uses: ToolUse[], max = 10): string[] {
  const shown = uses.slice(0, max).map((use) => `${use.name}(${brief(use.args, 160)})`);
  return uses.length > max ? [...shown, `… ${uses.length - max} more`] : shown;
}

function patternsOf(spec: { tool?: string; tools?: string[] }, grader: string): string[] {
  const patterns = [...(spec.tool !== undefined ? [spec.tool] : []), ...(spec.tools ?? [])];
  if (patterns.length === 0) throw new Error(`${grader} needs tool or tools`);
  return patterns;
}

/**
 * `tool_called`: the agent called the tool with matching arguments.
 * - `tool`: the name, or `re:<pattern>`;
 * - `args`: `{ <path>: <matcher> }`, every one must match the same call (paths as in matchers.ts, `..key` anywhere);
 * - `count`: how many matching calls, a number or `{ min, max }` (in place of "at least one");
 * - `first`: the trial's first tool call is this tool (with these arguments): the tool chosen for the context.
 */
export interface ToolCalledSpec extends GraderSpec {
  tool: string;
  args?: Record<string, Matcher>;
  count?: Range;
  first?: boolean;
}

const toolCalled: Grader<ToolCalledSpec> = {
  type: 'tool_called',
  kind: 'code',
  grade(context, spec) {
    if (typeof spec.tool !== 'string') throw new Error('tool_called needs tool');
    const uses = toolUses(context.transcript);
    const named = uses.filter((use) => nameMatches(use.name, spec.tool));
    const args = spec.args ?? {};
    checkPaths(args);
    const reasons = named.map((use) => mismatchOf(use.args, args));
    const matching = named.filter((_, i) => reasons[i] === null);
    const why = reasons.filter((r): r is string => r !== null);
    const assertions: Assertion[] = [];
    if (spec.count === undefined) {
      assertions.push({
        name: `called ${spec.tool}`,
        passed: named.length > 0,
        expected: spec.tool,
        actual: summary(uses),
      });
      if (spec.args !== undefined && named.length > 0) {
        assertions.push({
          name: `${spec.tool} with matching args`,
          passed: matching.length > 0,
          expected: spec.args,
          actual: summary(named),
          message: matching.length > 0 ? undefined : why.join('; '),
        });
      }
    } else {
      assertions.push({
        name: `${spec.tool} called ${brief(spec.count)} times`,
        passed: inRange(matching.length, spec.count),
        expected: spec.count,
        actual: matching.length,
        message: why.length > 0 ? `calls with other args: ${why.join('; ')}` : undefined,
      });
    }
    if (spec.first) {
      const first = uses[0];
      const reason =
        first === undefined
          ? 'no tool call'
          : !nameMatches(first.name, spec.tool)
            ? `the first call is ${first.name}`
            : mismatchOf(first.args, args);
      assertions.push({
        name: `first call is ${spec.tool}`,
        passed: reason === null,
        expected: spec.tool,
        actual: first ? summary([first])[0] : null,
        message: reason ?? undefined,
      });
    }
    return { assertions };
  },
};

/** `tool_not_called`: none of the tools was called. `tool` or `tools` (names or `re:` patterns). */
export interface ToolNotCalledSpec extends GraderSpec {
  tool?: string;
  tools?: string[];
}

const toolNotCalled: Grader<ToolNotCalledSpec> = {
  type: 'tool_not_called',
  kind: 'code',
  grade(context, spec) {
    const uses = toolUses(context.transcript);
    return {
      assertions: patternsOf(spec, 'tool_not_called').map((pattern) => {
        const calls = uses.filter((use) => nameMatches(use.name, pattern));
        return {
          name: `did not call ${pattern}`,
          passed: calls.length === 0,
          expected: 0,
          actual: summary(calls),
        };
      }),
    };
  },
};

/** `tool_calls`: limits on the number of tool calls, `{ min?, max? }`, overall or of `tool` (a name or `re:`). */
export interface ToolCallsSpec extends GraderSpec {
  tool?: string;
  min?: number;
  max?: number;
}

const toolCalls: Grader<ToolCallsSpec> = {
  type: 'tool_calls',
  kind: 'code',
  grade(context, spec) {
    const tool = spec.tool;
    const uses = toolUses(context.transcript).filter(
      (use) => tool === undefined || nameMatches(use.name, tool),
    );
    const what = tool === undefined ? 'tool calls' : `calls of ${tool}`;
    const assertions: Assertion[] = [];
    if (spec.min !== undefined) {
      assertions.push({
        name: `at least ${spec.min} ${what}`,
        passed: uses.length >= spec.min,
        expected: spec.min,
        actual: uses.length,
      });
    }
    if (spec.max !== undefined) {
      assertions.push({
        name: `at most ${spec.max} ${what}`,
        passed: uses.length <= spec.max,
        expected: spec.max,
        actual: uses.length,
      });
    }
    if (assertions.length === 0) throw new Error('tool_calls needs min or max');
    return { assertions };
  },
};

/**
 * `no_placeholder_args`: no string argument is a placeholder (`<documentId>`, the nil GUID, `TODO`, …), the sign of a
 * model that calls a tool before it has the value. `tools` limits the check to these tools.
 */
export interface NoPlaceholderArgsSpec extends GraderSpec {
  tools?: string[];
}

const noPlaceholderArgs: Grader<NoPlaceholderArgsSpec> = {
  type: 'no_placeholder_args',
  kind: 'code',
  grade(context, spec) {
    const uses = toolUses(context.transcript).filter(
      (use) => !spec.tools || anyName(use.name, spec.tools),
    );
    const found = uses.flatMap((use) =>
      stringLeaves(use.args)
        .filter((leaf) => isPlaceholder(leaf.value))
        .map((leaf) => `${use.name} ${leaf.path || 'args'}=${JSON.stringify(leaf.value)}`),
    );
    return {
      assertions: [
        {
          name: 'no placeholder arguments',
          passed: found.length === 0,
          expected: [],
          actual: found,
        },
      ],
    };
  },
};

/**
 * `no_repeated_calls`: no two calls of a tool with deep-equal arguments (a loop, or a lost result). `tools` limits the
 * check to these tools, `ignore` leaves tools out (one that is meant to poll), and `perTurn` compares only the calls of
 * one user turn (a later question may need the same read again).
 */
export interface NoRepeatedCallsSpec extends GraderSpec {
  tools?: string[];
  ignore?: string[];
  perTurn?: boolean;
}

const noRepeatedCalls: Grader<NoRepeatedCallsSpec> = {
  type: 'no_repeated_calls',
  kind: 'code',
  grade(context, spec) {
    const counts = new Map<string, number>();
    // The time each user turn started, to tell which turn a call belongs to.
    const turns = context.transcript.flatMap((e) =>
      e.type === 'message' && e.role === 'user' ? [e.at] : [],
    );
    for (const use of toolUses(context.transcript)) {
      if (spec.tools && !anyName(use.name, spec.tools)) continue;
      if (spec.ignore && anyName(use.name, spec.ignore)) continue;
      const turn = spec.perTurn ? `${turns.filter((at) => at <= use.at).length}:` : '';
      const key = `${turn}${use.name}(${canonicalJson(use.args ?? null)})`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const repeated = [...counts]
      .filter(([, n]) => n > 1)
      .map(([key, n]) => `${key.length > 200 ? `${key.slice(0, 199)}…` : key} ×${n}`);
    return {
      assertions: [
        {
          name: 'no repeated calls',
          passed: repeated.length === 0,
          expected: [],
          actual: repeated,
        },
      ],
    };
  },
};

/**
 * `outcome`: the final state of the environment, as the adapter read it (not what the agent claims).
 * - `expect`: `{ <path>: <matcher> }`, a path of '' or '.' is the whole outcome;
 * - `equals`: the whole outcome is deep-equal to this value.
 */
export interface OutcomeSpec extends GraderSpec {
  expect?: Record<string, Matcher>;
  equals?: unknown;
}

const outcome: Grader<OutcomeSpec> = {
  type: 'outcome',
  kind: 'code',
  grade(context, spec) {
    const assertions: Assertion[] = Object.entries(spec.expect ?? {}).map(([path, expected]) => {
      const reason = matchAt(context.outcome, path, expected);
      return {
        name: path === '' || path === '.' ? 'outcome' : `outcome ${path}`,
        passed: reason === null,
        expected,
        actual: path.startsWith('..') ? undefined : valueAt(context.outcome, path),
        message: reason ?? undefined,
      };
    });
    if ('equals' in spec) {
      assertions.push({
        name: 'outcome equals',
        passed: deepEqual(context.outcome, spec.equals),
        expected: spec.equals,
        actual: context.outcome,
      });
    }
    if (assertions.length === 0) throw new Error('outcome needs expect or equals');
    return { assertions };
  },
};

/**
 * A matcher for one kind of fact, chosen by its prefix (`amount:1234.5`, `date:2026-03-01`): a project adds its own for
 * values that are written in many ways. `holds` gets the fact without the prefix and the text as written (the raw text;
 * in `facts` without the user's quoted messages), the same text from `facts` and from `forbid`.
 */
export interface FactMatcher {
  prefix: string;
  holds(fact: string, text: string): boolean;
}

/** Text as a reader sees it: Markdown emphasis and code marks gone, whitespace (non-breaking too) collapsed. */
export function normalizeText(text: string): string {
  return text.normalize('NFC').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
}

/** The text a fact is matched against: as written, and as `normalizeText` gives it. */
export interface FactText {
  raw: string;
  normalized: string;
}

/**
 * Whether a fact holds in the text. `re:` is a case-insensitive unicode regex that holds when it matches the raw text or
 * the normalized text; a registered prefix uses its matcher on the raw text; anything else is a case-insensitive
 * substring of the normalized text. A string is taken as the raw text.
 */
export function factHolds(
  fact: string,
  text: string | FactText,
  matchers: FactMatcher[] = [],
): boolean {
  const { raw, normalized } =
    typeof text === 'string' ? { raw: text, normalized: normalizeText(text) } : text;
  if (fact.startsWith('re:')) {
    const regex = regexOf(fact);
    return regex.test(raw) || regex.test(normalized);
  }
  const custom = matchers.find((m) => fact.startsWith(m.prefix));
  if (custom) return custom.holds(fact.slice(custom.prefix.length), raw);
  return normalized.toLowerCase().includes(normalizeText(fact).toLowerCase());
}

type On = 'answer' | 'final';

function textOn(context: GradeContext, on: On | undefined): string {
  return on === 'final' ? context.finalAnswer : context.answer;
}

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The answer without the user's own longer messages quoted in it, so an answer that only repeats the question doesn't
 * get the facts the question names. Short messages ("Hallo", a name) stay: removing them would hide real answers. The
 * quote is removed from the normalized text and from the raw text (where Markdown marks and any whitespace may sit
 * between its characters).
 */
/**
 * `text` as `normalizeText` gives it, with the position in `text` of each character kept, so a range found in the
 * normalized text can be cut from the text as written. Linear in the text's length.
 */
function normalizeWithMap(text: string): { normalized: string; positions: number[] } {
  let normalized = '';
  const positions: number[] = [];
  let space = -1;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === '*' || char === '_' || char === '`') continue;
    if (/\s/u.test(char)) {
      if (normalized !== '' && space < 0) space = i;
      continue;
    }
    if (space >= 0) {
      normalized += ' ';
      positions.push(space);
      space = -1;
    }
    normalized += char;
    positions.push(i);
  }
  return { normalized, positions };
}

/**
 * The answer without the user's own messages (20 characters or more) that it quotes, in both forms: an echo is found
 * in the normalized text with the message as a literal (no backtracking, whatever the message's length), and the same
 * ranges are blanked in the text as written, so a bolded quote is stripped from both.
 */
function withoutEcho(context: GradeContext, text: string): FactText {
  const written = text.normalize('NFC');
  const { normalized: all, positions } = normalizeWithMap(written);
  let normalized = all;
  const cuts: [number, number][] = [];
  for (const message of messages(context.transcript, 'user')) {
    const quoted = normalizeText(message);
    if (quoted.length < 20) continue;
    const echo = new RegExp(escapeRegex(quoted), 'giu');
    for (const match of all.matchAll(echo)) {
      const first = match.index;
      const last = first + match[0].length - 1;
      cuts.push([positions[first]!, positions[last]! + 1]);
    }
    normalized = normalized.replace(echo, ' ');
  }
  cuts.sort((a, b) => a[0] - b[0]);
  let raw = '';
  let from = 0;
  for (const [start, end] of cuts) {
    if (end <= from) continue;
    raw += `${written.slice(from, Math.max(from, start))} `;
    from = end;
  }
  raw += written.slice(from);
  return { raw, normalized };
}

function asIs(text: string): FactText {
  return { raw: text, normalized: normalizeText(text) };
}

/**
 * `facts`: each fact holds in the answer; a fact given as a list holds when one of its alternatives does. The score is
 * the share of facts found (partial credit).
 * - `facts`: strings (`re:` for a regex, a registered prefix, else a case-insensitive substring) or lists of them;
 * - `on`: `answer` (every assistant message, the default) or `final` (the last one);
 * - `allowEcho`: count a fact found only in a quoted user message (default false).
 */
export interface FactsSpec extends GraderSpec {
  facts: (string | string[])[];
  on?: On;
  allowEcho?: boolean;
}

export function factsGrader(matchers: FactMatcher[] = []): Grader<FactsSpec> {
  return {
    type: 'facts',
    kind: 'code',
    grade(context, spec) {
      if (!Array.isArray(spec.facts) || spec.facts.length === 0)
        throw new Error('facts needs a list of facts');
      const raw = textOn(context, spec.on);
      const text = spec.allowEcho ? asIs(raw) : withoutEcho(context, raw);
      const assertions = spec.facts.map((fact) => {
        const options = Array.isArray(fact) ? fact : [fact];
        const holds = options.some((option) => factHolds(option, text, matchers));
        return { name: `states ${options.join(' | ')}`, passed: holds, expected: fact };
      });
      const output: GraderOutput = {
        assertions,
        score: assertions.filter((a) => a.passed).length / assertions.length,
      };
      return output;
    },
  };
}

/** `forbid`: none of the patterns holds in the answer (same matching as `facts`; `on` as there). */
export interface ForbidSpec extends GraderSpec {
  patterns: string[];
  on?: On;
}

export function forbidGrader(matchers: FactMatcher[] = []): Grader<ForbidSpec> {
  return {
    type: 'forbid',
    kind: 'code',
    grade(context, spec) {
      if (!Array.isArray(spec.patterns) || spec.patterns.length === 0)
        throw new Error('forbid needs patterns');
      const text = asIs(textOn(context, spec.on));
      return {
        assertions: spec.patterns.map((pattern) => ({
          name: `does not state ${pattern}`,
          passed: !factHolds(pattern, text, matchers),
          expected: 'absent',
        })),
      };
    },
  };
}

/**
 * `limits`: the trial stays within its budget. `maxTurns` (and its alias `maxUserTurns`) counts user messages,
 * `maxModelCalls` the model calls, `maxToolCalls` the tool calls.
 */
export interface LimitsSpec extends GraderSpec {
  maxTurns?: number;
  maxUserTurns?: number;
  maxModelCalls?: number;
  maxToolCalls?: number;
}

const limits: Grader<LimitsSpec> = {
  type: 'limits',
  kind: 'code',
  grade(context, spec) {
    const t = context.transcript;
    const counts = {
      turns: t.filter((e) => e.type === 'message' && e.role === 'user').length,
      modelCalls: t.filter((e) => e.type === 'model_call').length,
      toolCalls: t.filter((e) => e.type === 'tool_call').length,
    };
    const checks: [string, number | undefined, number][] = [
      ['turns', spec.maxTurns, counts.turns],
      ['turns', spec.maxUserTurns, counts.turns],
      ['model calls', spec.maxModelCalls, counts.modelCalls],
      ['tool calls', spec.maxToolCalls, counts.toolCalls],
    ];
    const assertions = checks
      .filter((check): check is [string, number, number] => check[1] !== undefined)
      .map(([what, max, actual]) => ({
        name: `at most ${max} ${what}`,
        passed: actual <= max,
        expected: max,
        actual,
      }));
    if (assertions.length === 0)
      throw new Error('limits needs maxTurns, maxModelCalls or maxToolCalls');
    return { assertions };
  },
};

/** Code blocks, code spans and link targets: their words are not the answer's language or register. */
function prose(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\]\([^)]*\)/g, '] ')
    .replace(/https?:\/\/\S+/g, ' ');
}

// Frequent function words only one of the two languages has ("in", "was", "so", "an", "also", "will" are in both).
// German has "du" and the question words next to English "you" and "which what when where who how": short replies
// such as "Welchen meinst du?" often have no other.
const stopWords = {
  de: new Set(
    'der die das den dem des ein eine einen einem einer eines und oder aber nicht ist sind war wurde werden wird ich du sie wir ihr es er mit von zu zum zur auf für bei aus nach über unter wie welche welcher welches welchen welchem wann wo wer dass auch noch nur schon sehr hier dort kann können muss müssen haben hat hatte bitte keine kein ihre ihren ihnen sich wenn dann'.split(
      ' ',
    ),
  ),
  en: new Set(
    'the a and or but not is are were been be being this that these those it its he she we they you your with from to of for on at by as if then than there here can could must should would have has had please no any which what when where who how do does did'.split(
      ' ',
    ),
  ),
};

/**
 * `language`: the answer is in `de` or `en`, by a cheap count of each language's stop words; the expected language must
 * have more. A tie (an answer without any stop word too) is no evidence either way, so the verdict is unknown, which
 * `onUnknown` turns into a failure (the default) or sets aside. The counts are the assertion's actual value. `on` as in
 * `facts`.
 */
export interface LanguageSpec extends GraderSpec {
  language: 'de' | 'en';
  on?: On;
}

const language: Grader<LanguageSpec> = {
  type: 'language',
  kind: 'code',
  grade(context, spec) {
    if (spec.language !== 'de' && spec.language !== 'en')
      throw new Error('language must be de or en');
    const words =
      prose(textOn(context, spec.on))
        .toLowerCase()
        .match(/\p{L}+/gu) ?? [];
    const counts = { de: 0, en: 0 };
    for (const word of words) {
      if (stopWords.de.has(word)) counts.de++;
      if (stopWords.en.has(word)) counts.en++;
    }
    const other = spec.language === 'de' ? 'en' : 'de';
    const tie = counts.de === counts.en;
    return {
      assertions: [
        {
          name: `answers in ${spec.language}`,
          passed: counts[spec.language] > counts[other],
          expected: spec.language,
          actual: counts,
          ...(tie ? { unknown: true as const } : {}),
        },
      ],
      unknown: tie,
    };
  },
};

const informal =
  /(?<![\p{L}\p{N}])(du|dich|dir|dein\p{L}*|euch|euer|eure\p{L}*)(?![\p{L}\p{N}])/giu;

/**
 * `formality`: German answers address the user formally ("Sie"): no du-forms (du, dich, dir, dein…, euch, euer, eure…),
 * outside code and link targets. Only `language: de` with `register: formal` exists.
 */
export interface FormalitySpec extends GraderSpec {
  language?: 'de';
  register?: 'formal';
  on?: On;
}

const formality: Grader<FormalitySpec> = {
  type: 'formality',
  kind: 'code',
  grade(context, spec) {
    if ((spec.language ?? 'de') !== 'de' || (spec.register ?? 'formal') !== 'formal') {
      throw new Error('formality supports language de with register formal only');
    }
    const found = [...prose(textOn(context, spec.on)).matchAll(informal)].map((m) => m[0]);
    return {
      assertions: [
        {
          name: 'addresses the user with Sie',
          passed: found.length === 0,
          expected: [],
          actual: found,
        },
      ],
    };
  },
};

/**
 * `no_error`: the trial has no agent error or timeout, and no tool result with an error unless `allowToolErrors` (an
 * agent that recovers from a failing tool can still pass then).
 */
export interface NoErrorSpec extends GraderSpec {
  allowToolErrors?: boolean;
}

const noError: Grader<NoErrorSpec> = {
  type: 'no_error',
  kind: 'code',
  grade(context, spec) {
    const errors = context.transcript.flatMap((e) =>
      e.type === 'error' && (e.kind === 'agent' || e.kind === 'timeout')
        ? [`${e.kind}: ${e.message}`]
        : [],
    );
    const assertions: Assertion[] = [
      { name: 'no agent error', passed: errors.length === 0, expected: [], actual: errors },
    ];
    if (!spec.allowToolErrors) {
      const toolErrors = context.transcript.flatMap((e) =>
        e.type === 'tool_result' && e.error !== undefined ? [`${e.name}: ${e.error}`] : [],
      );
      assertions.push({
        name: 'no tool error',
        passed: toolErrors.length === 0,
        expected: [],
        actual: toolErrors,
      });
    }
    return { assertions };
  },
};

/**
 * `asks_back`: whether the agent asks the user back instead of acting (`expected: true`) or acts (`expected: false`).
 * It asks back when its final answer has a sentence ending in "?" (outside code and link targets; often followed by
 * the options to choose from) and it called none of the `writeTools` (names or `re:`). A heuristic: a judge dimension
 * fits when the wording matters.
 */
export interface AsksBackSpec extends GraderSpec {
  expected: boolean;
  writeTools?: string[];
}

export function isQuestion(text: string): boolean {
  // Code, inline code and link targets can hold a "?" that asks nothing (a URL's query).
  const prose = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\]\([^)]*\)/g, ']')
    .replace(/https?:\/\/\S+/g, ' ');
  // A "?" that ends a sentence.
  return /\?+(?=[\s"'»«“”‘’)*_]*(\s|$))/u.test(prose);
}

const asksBack: Grader<AsksBackSpec> = {
  type: 'asks_back',
  kind: 'code',
  grade(context, spec) {
    if (typeof spec.expected !== 'boolean')
      throw new Error('asks_back needs expected: true or false');
    const question = isQuestion(context.finalAnswer);
    const writes = toolUses(context.transcript).filter(
      (use) => spec.writeTools && anyName(use.name, spec.writeTools),
    );
    const asked = question && writes.length === 0;
    return {
      assertions: [
        {
          name: spec.expected ? 'asks the user back' : 'does not ask back',
          passed: asked === spec.expected,
          expected: spec.expected,
          actual: { question, writes: summary(writes) },
        },
      ],
    };
  },
};

export function codeGraders(factMatchers: FactMatcher[] = []): Grader[] {
  return [
    toolCalled,
    toolNotCalled,
    toolCalls,
    noPlaceholderArgs,
    noRepeatedCalls,
    outcome,
    factsGrader(factMatchers),
    forbidGrader(factMatchers),
    limits,
    language,
    formality,
    noError,
    asksBack,
  ] as Grader[];
}
