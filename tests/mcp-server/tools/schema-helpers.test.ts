/**
 * @fileoverview Tests for the blank-input preprocessors that let form clients send
 * every optional field: blank strings read as unset, lone strings become arrays.
 * @module tests/mcp-server/tools/schema-helpers.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import { blankToUndefined, toOptionalArray } from '@/mcp-server/tools/schema-helpers.js';

describe('blankToUndefined', () => {
  it.each([
    ['', undefined],
    ['   ', undefined],
    ['\t\n', undefined],
    ['  mit  ', 'mit'],
    ['x', 'x'],
  ])('%j → %j', (input, expected) => {
    expect(blankToUndefined(input)).toBe(expected);
  });

  it.each([0, false, null, undefined, 42])('passes non-string %j through', (value) => {
    expect(blankToUndefined(value)).toBe(value);
  });

  it('makes an optional enum accept a blank form field as unset', () => {
    const schema = z.preprocess(blankToUndefined, z.enum(['apa', 'bibtex']).optional());
    expect(schema.parse('')).toBeUndefined();
    expect(schema.parse(' apa ')).toBe('apa');
    expect(() => schema.parse('vancouver')).toThrow();
  });
});

describe('toOptionalArray', () => {
  it.each([
    ['dataset', ['dataset']],
    ['  dataset ', ['dataset']],
    [
      ['dataset', ' software '],
      ['dataset', 'software'],
    ],
    [['', 'csv', '  '], ['csv']],
    [[], undefined],
    [['', ' '], undefined],
    ['', undefined],
    [undefined, undefined],
  ])('%j → %j', (input, expected) => {
    expect(toOptionalArray(input)).toEqual(expected);
  });

  it('passes a non-string, non-array value through for the schema to reject', () => {
    expect(toOptionalArray(7)).toBe(7);
  });

  it('keeps non-string array elements for the schema to judge', () => {
    expect(toOptionalArray(['csv', 3])).toEqual(['csv', 3]);
  });
});
