import { describe, expect, it } from 'vitest';

import {
  isPlaceholder,
  leafValues,
  matchAt,
  matchesAll,
  matchValue,
  stringLeaves,
  valueAt,
} from '../src/graders/matchers.ts';

describe('matchValue', () => {
  it('compares strings ignoring case, after String()', () => {
    expect(matchValue('Müller GmbH', 'müller gmbh')).toBeNull();
    expect(matchValue(42, '42')).toBeNull();
    expect(matchValue('Meier', 'Müller')).toMatch(/expected "Müller"/);
    expect(matchValue(undefined, 'x')).not.toBeNull();
    expect(matchValue({ a: 1 }, '[object Object]')).not.toBeNull();
  });

  it('treats re: as a case-insensitive regex', () => {
    expect(matchValue('RE-2026-001', 're:^re-\\d{4}-')).toBeNull();
    expect(matchValue('INV-1', 're:^re-')).toMatch(/does not match/);
  });

  it('compares numbers, booleans and null strictly', () => {
    expect(matchValue(5, 5)).toBeNull();
    expect(matchValue('5', 5)).not.toBeNull();
    expect(matchValue(true, true)).toBeNull();
    expect(matchValue('true', true)).not.toBeNull();
    expect(matchValue(null, null)).toBeNull();
    expect(matchValue(undefined, null)).not.toBeNull();
  });

  it('compares arrays deeply', () => {
    expect(matchValue([1, { b: 2, a: 1 }], [1, { a: 1, b: 2 }])).toBeNull();
    expect(matchValue([1, 2], [2, 1])).not.toBeNull();
  });

  it('supports the constraint objects', () => {
    expect(matchValue('b', { oneOf: ['a', 'B'] })).toBeNull();
    expect(matchValue('c', { oneOf: ['a', 're:^b'] })).toMatch(/one of/);
    expect(matchValue(10, { min: 5, max: 10 })).toBeNull();
    expect(matchValue('119.50', { min: 100 })).toBeNull();
    expect(matchValue(11, { max: 10 })).toMatch(/<= 10/);
    expect(matchValue('2026-03-01', { min: '2026-01-01', max: '2026-12-31' })).toBeNull();
    expect(matchValue('abc', { min: 1 })).toMatch(/comparable/);
    expect(matchValue('x', { exists: true })).toBeNull();
    expect(matchValue(null, { exists: true })).toMatch(/expected a value/);
    expect(matchValue(undefined, { absent: true })).toBeNull();
    expect(matchValue('', { absent: true })).not.toBeNull();
    expect(matchValue('Rechnung von Müller', { contains: 'MÜLLER' })).toBeNull();
    expect(matchValue('Rechnung', { contains: 'Gutschrift' })).not.toBeNull();
    expect(matchValue({ a: [1] }, { equals: { a: [1] } })).toBeNull();
    expect(matchValue('abc', { all: ['re:^a', { contains: 'c' }] })).toBeNull();
    expect(matchValue('abc', { all: ['re:^a', { contains: 'd' }] })).not.toBeNull();
    expect(matchValue('abc', { any: ['x', 're:b'] })).toBeNull();
    expect(matchValue('abc', { any: ['x', 'y'] })).toMatch(/none of/);
    expect(matchValue('draft', { not: 'approved' })).toBeNull();
    expect(matchValue('approved', { not: 'APPROVED' })).toMatch(/must not match/);
  });

  it('supports includes and length on arrays', () => {
    expect(matchValue(['a', 'b'], { includes: 'B' })).toBeNull();
    expect(matchValue(['a'], { includes: 'c' })).toMatch(/no element/);
    expect(matchValue('a', { includes: 'a' })).toMatch(/an array/);
    expect(matchValue([1, 2, 3], { length: 3 })).toBeNull();
    expect(matchValue([1], { length: { min: 2 } })).toMatch(/length/);
    expect(matchValue('abcd', { length: { max: 4 } })).toBeNull();
  });

  it('throws on an unknown matcher, so a typo in a task never passes silently', () => {
    expect(() => matchValue('x', { contians: 'x' } as never)).toThrow(/unknown matcher/);
    expect(() => matchValue('x', {})).toThrow(/unknown matcher/);
  });
});

describe('paths', () => {
  const args = {
    filter: { tags: ['a', 'b'], vendor: { name: 'Müller' } },
    lines: [{ amount: 10 }],
  };

  it('reads dotted paths and indexes', () => {
    expect(valueAt(args, 'filter.vendor.name')).toBe('Müller');
    expect(valueAt(args, 'lines[0].amount')).toBe(10);
    expect(valueAt(args, 'lines.0.amount')).toBe(10);
    expect(valueAt(args, 'filter.tags[1]')).toBe('b');
    expect(valueAt(args, 'filter.missing.deep')).toBeUndefined();
    expect(valueAt(args, '')).toBe(args);
    expect(valueAt(args, '.')).toBe(args);
  });

  it('finds every value of a key anywhere', () => {
    expect(leafValues({ id: 1, nested: [{ id: 2 }, { other: { id: 3 } }] }, 'id')).toEqual([
      1, 2, 3,
    ]);
    expect(leafValues('x', 'id')).toEqual([]);
  });

  it('lists the string leaves with their paths', () => {
    expect(stringLeaves(args)).toEqual([
      { path: 'filter.tags[0]', value: 'a' },
      { path: 'filter.tags[1]', value: 'b' },
      { path: 'filter.vendor.name', value: 'Müller' },
    ]);
  });

  it('matches a key anywhere with ..', () => {
    expect(matchAt(args, '..name', 'müller')).toBeNull();
    expect(matchAt(args, '..name', 'Meier')).toMatch(/^\.\.name: /);
    expect(matchAt(args, '..missing', { absent: true })).toBeNull();
  });

  it('matchesAll checks every path', () => {
    expect(
      matchesAll(args, { 'filter.vendor.name': 'müller', 'lines[0].amount': { min: 5 } }),
    ).toBe(true);
    expect(
      matchesAll(args, { 'filter.vendor.name': 'müller', 'lines[0].amount': { min: 50 } }),
    ).toBe(false);
    expect(matchesAll('x', { '': 'X' })).toBe(true);
    expect(matchesAll(args, {})).toBe(true);
  });
});

describe('isPlaceholder', () => {
  it.each([
    '',
    '   ',
    '00000000-0000-0000-0000-000000000000',
    '<documentId>',
    '<id>',
    '{{documentId}}',
    '${id}',
    'string',
    'UUID',
    'id',
    'null',
    'undefined',
    'TODO',
    'xxx',
    'XXXX',
    '...',
    '…',
    'Lorem ipsum dolor sit amet',
  ])('flags %j', (value) => {
    expect(isPlaceholder(value)).toBe(true);
  });

  it.each([
    '0f8fad5b-d9cb-469f-a165-70867728950e',
    'Rechnung März',
    'id-42',
    '<b>bold</b> text',
    'x',
  ])('accepts %j', (value) => {
    expect(isPlaceholder(value)).toBe(false);
  });

  it('only looks at strings', () => {
    expect(isPlaceholder(0)).toBe(false);
    expect(isPlaceholder(null)).toBe(false);
  });
});
