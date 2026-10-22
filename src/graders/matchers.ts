/**
 * Value matchers for grader parameters, as a task file writes them:
 * - a string: equal to `String(actual)`, ignoring case; `re:<pattern>` is a case-insensitive regex instead;
 * - a number, a boolean or null: strictly equal;
 * - an array: deeply equal (canonical JSON);
 * - an object with constraints, all of which must hold:
 *   `oneOf`, `min`/`max` (numbers, numeric strings, or strings compared as text such as ISO dates), `exists`, `absent`,
 *   `contains` (a case-insensitive substring), `equals` (deep), `all`, `any`, `not`, and for arrays `includes` (some
 *   element matches) and `length` (a number or `{ min, max }`, also for strings).
 * A matcher returns null when it holds and the reason when it doesn't.
 */

export type Matcher = string | number | boolean | null | unknown[] | MatcherObject;

export interface MatcherObject {
  oneOf?: Matcher[];
  min?: number | string;
  max?: number | string;
  exists?: boolean;
  absent?: boolean;
  contains?: string;
  equals?: unknown;
  all?: Matcher[];
  any?: Matcher[];
  not?: Matcher;
  includes?: Matcher;
  length?: number | { min?: number; max?: number };
}

const constraintKeys = new Set([
  'oneOf',
  'min',
  'max',
  'exists',
  'absent',
  'contains',
  'equals',
  'all',
  'any',
  'not',
  'includes',
  'length',
]);

/** Compact JSON for reasons and reports, cut at `max` characters. */
export function brief(value: unknown, max = 200): string {
  const text =
    value === undefined
      ? 'undefined'
      : typeof value === 'string'
        ? JSON.stringify(value)
        : canonicalJson(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** JSON with sorted object keys, so two deep-equal values give the same text. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? 'undefined';
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(object)
        .sort()
        .map((key) => [key, sortKeys(object[key])]),
    );
  }
  return value;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** A regex from `re:<pattern>`, case-insensitive and unicode-aware. */
export function regexOf(pattern: string): RegExp {
  return new RegExp(pattern.slice(3), 'iu');
}

function isNil(value: unknown): boolean {
  return value === undefined || value === null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** `actual` against a bound: numbers (numeric strings too), else strings as text (ISO dates sort that way). */
function compare(actual: unknown, bound: number | string): number | null {
  const a = asNumber(actual);
  const b = asNumber(bound);
  if (a !== null && b !== null) return a - b;
  if (typeof actual === 'string' && typeof bound === 'string')
    return actual < bound ? -1 : actual > bound ? 1 : 0;
  return null;
}

function inRange(n: number, range: number | { min?: number; max?: number }): boolean {
  if (typeof range === 'number') return n === range;
  return (range.min === undefined || n >= range.min) && (range.max === undefined || n <= range.max);
}

export function matchValue(actual: unknown, expected: Matcher): string | null {
  if (typeof expected === 'string') {
    if (isNil(actual) || typeof actual === 'object')
      return `expected ${brief(expected)}, got ${brief(actual)}`;
    const text = typeof actual === 'string' ? actual : canonicalJson(actual);
    if (expected.startsWith('re:')) {
      return regexOf(expected).test(text)
        ? null
        : `${brief(text)} does not match /${expected.slice(3)}/i`;
    }
    return text.toLowerCase() === expected.toLowerCase()
      ? null
      : `expected ${brief(expected)}, got ${brief(actual)}`;
  }
  if (expected === null || typeof expected === 'number' || typeof expected === 'boolean') {
    return actual === expected ? null : `expected ${brief(expected)}, got ${brief(actual)}`;
  }
  if (Array.isArray(expected)) {
    return deepEqual(actual, expected) ? null : `expected ${brief(expected)}, got ${brief(actual)}`;
  }
  if (typeof expected !== 'object') throw new Error(`unsupported matcher ${brief(expected)}`);
  const unknownKeys = Object.keys(expected).filter((key) => !constraintKeys.has(key));
  if (unknownKeys.length > 0 || Object.keys(expected).length === 0) {
    throw new Error(`unknown matcher ${brief(expected)} (use { equals: … } for an object)`);
  }
  return matchObject(actual, expected);
}

function matchObject(actual: unknown, m: MatcherObject): string | null {
  if (m.exists === true && isNil(actual)) return 'expected a value, got none';
  if ((m.absent === true || m.exists === false) && !isNil(actual))
    return `expected no value, got ${brief(actual)}`;
  if (m.equals !== undefined && !deepEqual(actual, m.equals)) {
    return `expected ${brief(m.equals)}, got ${brief(actual)}`;
  }
  if (m.oneOf !== undefined && !m.oneOf.some((option) => matchValue(actual, option) === null)) {
    return `expected one of ${brief(m.oneOf)}, got ${brief(actual)}`;
  }
  for (const [bound, sign] of [
    [m.min, 1],
    [m.max, -1],
  ] as const) {
    if (bound === undefined) continue;
    const c = compare(actual, bound);
    if (c === null) return `expected a value comparable with ${brief(bound)}, got ${brief(actual)}`;
    if (c * sign < 0)
      return `expected ${sign > 0 ? '>=' : '<='} ${brief(bound)}, got ${brief(actual)}`;
  }
  if (m.contains !== undefined) {
    const text = isNil(actual) ? '' : typeof actual === 'string' ? actual : canonicalJson(actual);
    if (!text.toLowerCase().includes(m.contains.toLowerCase())) {
      return `expected ${brief(actual)} to contain ${brief(m.contains)}`;
    }
  }
  if (m.includes !== undefined) {
    if (!Array.isArray(actual)) return `expected an array, got ${brief(actual)}`;
    const includes = m.includes;
    if (!actual.some((element) => matchValue(element, includes) === null)) {
      return `no element of ${brief(actual)} matches ${brief(includes)}`;
    }
  }
  if (m.length !== undefined) {
    if (!Array.isArray(actual) && typeof actual !== 'string')
      return `expected an array or a string, got ${brief(actual)}`;
    if (!inRange(actual.length, m.length))
      return `expected length ${brief(m.length)}, got ${actual.length}`;
  }
  if (m.all !== undefined) {
    for (const part of m.all) {
      const reason = matchValue(actual, part);
      if (reason !== null) return reason;
    }
  }
  if (m.any !== undefined && !m.any.some((part) => matchValue(actual, part) === null)) {
    return `${brief(actual)} matches none of ${brief(m.any)}`;
  }
  if (m.not !== undefined && matchValue(actual, m.not) === null) {
    return `${brief(actual)} must not match ${brief(m.not)}`;
  }
  return null;
}

/**
 * A parsed path. `segments` are keys and array indexes (`lines[0].amount`, `a.b.2`); `anywhere` is the key a path that
 * starts with `..` looks for at any depth, with `segments` then read beneath each of its values.
 */
export interface ParsedPath {
  anywhere?: string;
  segments: (string | number)[];
}

/**
 * Parses a path strictly: `a.b`, `a[0]`, `a[0].b`, `[0].a`, `..key` (the key anywhere), `..a.b` (the key `a` anywhere,
 * then `b` beneath it), and '' or '.' for the value itself. A key is any text without `.`, `[` and `]`; an index is
 * `[<digits>]`. Anything else (`a[0]b`, `a..b`, `a.`, `.a`, an unclosed bracket) throws an Error naming the path.
 */
export function parsePath(path: string): ParsedPath {
  if (path === '' || path === '.') return { segments: [] };
  const fail = (why: string): never => {
    throw new Error(`invalid path ${JSON.stringify(path)}: ${why}`);
  };
  let i = 0;
  const key = (): string => {
    const start = i;
    while (i < path.length && !'.[]'.includes(path[i]!)) i++;
    if (i === start) fail(`a key is missing at position ${start}`);
    return path.slice(start, i);
  };
  const index = (): number => {
    const match = /^\[(\d+)\]/.exec(path.slice(i));
    if (!match) fail(`expected [<digits>] at position ${i}`);
    i += match![0].length;
    return Number(match![1]);
  };
  const parsed: ParsedPath = { segments: [] };
  if (path.startsWith('..')) {
    i = 2;
    parsed.anywhere = key();
  } else {
    parsed.segments.push(path[0] === '[' ? index() : key());
  }
  while (i < path.length) {
    const char = path[i];
    if (char === '.') {
      i++;
      parsed.segments.push(key());
    } else if (char === '[') parsed.segments.push(index());
    else fail(`unexpected ${JSON.stringify(char)} at position ${i}`);
  }
  return parsed;
}

function valueAtSegments(value: unknown, segments: (string | number)[]): unknown {
  let current = value;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') return undefined;
    if (Array.isArray(current)) {
      const index =
        typeof segment === 'number' ? segment : /^\d+$/.test(segment) ? Number(segment) : NaN;
      current = Number.isNaN(index) ? undefined : current[index];
    } else {
      current = (current as Record<string, unknown>)[String(segment)];
    }
  }
  return current;
}

/** Every value a path names: one at most, or for a `..` path each one found (the missing ones left out). */
export function valuesAt(value: unknown, path: string): unknown[] {
  const { anywhere, segments } = parsePath(path);
  if (anywhere === undefined) {
    const found = valueAtSegments(value, segments);
    return found === undefined ? [] : [found];
  }
  return leafValues(value, anywhere)
    .map((node) => valueAtSegments(node, segments))
    .filter((found) => found !== undefined);
}

/** The value at a path (the first one found for a `..` path), or undefined. */
export function valueAt(value: unknown, path: string): unknown {
  const { anywhere, segments } = parsePath(path);
  return anywhere === undefined ? valueAtSegments(value, segments) : valuesAt(value, path)[0];
}

/** Every value of a key anywhere in the value (objects and arrays searched depth-first). */
export function leafValues(value: unknown, key: string): unknown[] {
  const found: unknown[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(visit);
    else if (node !== null && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (k === key) found.push(v);
        visit(v);
      }
    }
  };
  visit(value);
  return found;
}

/** Every string in the value with its path, for checks over all arguments of a call. */
export function stringLeaves(value: unknown, path = ''): { path: string; value: string }[] {
  if (typeof value === 'string') return [{ path, value }];
  if (Array.isArray(value)) return value.flatMap((v, i) => stringLeaves(v, `${path}[${i}]`));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) =>
      stringLeaves(v, path === '' ? k : `${path}.${k}`),
    );
  }
  return [];
}

/**
 * Matches a value found at a path. A path starting with `..` (such as `..documentId` or `..vendor.name`) looks for the
 * key anywhere and holds when any of its values matches; with no value found, the matcher sees undefined (so `absent`
 * works). A path that doesn't parse throws (see `parsePath`).
 */
export function matchAt(value: unknown, path: string, expected: Matcher): string | null {
  if (parsePath(path).anywhere !== undefined) {
    const values = valuesAt(value, path);
    if (values.length === 0) return prefixed(path, matchValue(undefined, expected));
    const reasons = values.map((v) => matchValue(v, expected));
    return reasons.includes(null) ? null : prefixed(path, reasons[0] ?? null);
  }
  return prefixed(path, matchValue(valueAt(value, path), expected));
}

/** Parses every path of `matchers`, so a bad path fails even where no value is matched. */
export function checkPaths(matchers: Record<string, unknown>): void {
  for (const path of Object.keys(matchers)) parsePath(path);
}

/** The first reason a path of `matchers` doesn't match, or null when every one does; a bad path throws. */
export function mismatchOf(value: unknown, matchers: Record<string, unknown>): string | null {
  checkPaths(matchers);
  for (const [path, expected] of Object.entries(matchers)) {
    const reason = matchAt(value, path, expected as Matcher);
    if (reason !== null) return reason;
  }
  return null;
}

/** Whether every path of `matchers` matches (a mock tool's `when`, an outcome check). */
export function matchesAll(value: unknown, matchers: Record<string, unknown>): boolean {
  return mismatchOf(value, matchers) === null;
}

function prefixed(path: string, reason: string | null): string | null {
  return reason === null ? null : `${path === '' || path === '.' ? 'value' : path}: ${reason}`;
}

const placeholderLiterals = new Set([
  'string',
  'str',
  'uuid',
  'guid',
  'id',
  'null',
  'undefined',
  'none',
  'todo',
  'tbd',
  'placeholder',
  '...',
  '…',
]);

/**
 * Whether a value looks like a placeholder a model wrote instead of a real argument: an empty string, the nil GUID,
 * `<documentId>`, `{{id}}`, `${id}`, a type name such as `string` or `uuid`, `TODO`, `xxx` or lorem ipsum.
 */
export function isPlaceholder(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (text === '') return true;
  const lower = text.toLowerCase();
  if (placeholderLiterals.has(lower)) return true;
  if (/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(text)) return true;
  if (/^<[^<>]*>$/.test(text) || /^\{\{.*\}\}$/.test(text) || /^\$\{.*\}$/.test(text)) return true;
  if (/^x{3,}$/i.test(text) || /^\.{3,}$/.test(text)) return true;
  return lower.includes('lorem ipsum');
}
