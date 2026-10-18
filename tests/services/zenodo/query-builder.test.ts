/**
 * @fileoverview Tests for search composition: the parameter allowlist, `q` clause
 * composition and quoting, query balancing, the query-grammar recognizer (agreement
 * with luqum 1.0.0, failure locations, number conversion, lexer edges, depth, linear
 * time), vocabulary-query escaping, the search-engine check, and partial-date validation
 * and expansion.
 * @module tests/services/zenodo/query-builder.test
 */

import { describe, expect, it } from 'vitest';
import {
  balanceQuery,
  buildSearch,
  engineSyntaxError,
  escapeVocabularyQuery,
  expandPartialDate,
  isConversionError,
  isValidPartialDate,
  queryAsSent,
  querySyntaxError,
  quoteValue,
  type SearchFilters,
} from '@/services/zenodo/query-builder.js';

const ALLOWLIST = new Set(['q', 'communities', 'all_versions', 'sort', 'page', 'size']);

const base: SearchFilters = { allVersions: false, page: 1, size: 10, sort: 'bestmatch' };

describe('buildSearch', () => {
  it('always sends sort, page, and size, and no q when nothing composes into it', () => {
    expect(buildSearch({ ...base, sort: 'newest' })).toEqual({
      params: [
        ['sort', 'newest'],
        ['page', '1'],
        ['size', '10'],
      ],
    });
  });

  it('sends a bare query unwrapped when no clause composes with it', () => {
    const built = buildSearch({ ...base, query: '  climate model  ' });
    expect(built.q).toBe('climate model');
    expect(built.params[0]).toEqual(['q', 'climate model']);
  });

  it('treats a whitespace-only query as absent', () => {
    expect(buildSearch({ ...base, query: '   ' }).q).toBeUndefined();
  });

  it('wraps the query in parentheses and ANDs each quoted field clause after it', () => {
    const built = buildSearch({
      ...base,
      query: 'climate OR weather',
      funderRor: '01cwqze88',
      award: { field: 'id', value: '00k4n6c32::101135562' },
      creatorOrcid: '0000-0002-1825-0097',
      license: 'cc-by-4.0',
      publishedFrom: '2020-01-01',
      publishedTo: '2020-12-31',
    });
    expect(built.q).toBe(
      [
        '(climate OR weather)',
        'metadata.funding.funder.id:"01cwqze88"',
        'metadata.funding.award.id:"00k4n6c32::101135562"',
        'metadata.creators.person_or_org.identifiers.identifier:"0000-0002-1825-0097"',
        'metadata.rights.id:"cc-by-4.0"',
        'metadata.publication_date:[2020-01-01 TO 2020-12-31]',
      ].join(' AND '),
    );
  });

  it('composes clauses alone when there is no query', () => {
    expect(buildSearch({ ...base, award: { field: 'number', value: '101135562' } }).q).toBe(
      'metadata.funding.award.number:"101135562"',
    );
  });

  it('leaves an open date side as *', () => {
    expect(buildSearch({ ...base, publishedFrom: '2020-01-01' }).q).toBe(
      'metadata.publication_date:[2020-01-01 TO *]',
    );
    expect(buildSearch({ ...base, publishedTo: '2020-12-31' }).q).toBe(
      'metadata.publication_date:[* TO 2020-12-31]',
    );
  });

  it('escapes quotes and backslashes inside quoted values', () => {
    expect(buildSearch({ ...base, license: 'a"b\\c' }).q).toBe('metadata.rights.id:"a\\"b\\\\c"');
  });

  it('composes resource type, file type, and access status into q (OR within a filter) so facets reflect them', () => {
    const built = buildSearch({
      ...base,
      query: 'air quality',
      resourceTypes: ['dataset', 'publication-article'],
      fileTypes: ['csv', 'zip'],
      accessStatus: 'metadata-only',
      communityId: '9649d306-cf94-49cc-a14d-934ca8fcb515',
      allVersions: true,
      page: 3,
      size: 25,
    });
    expect(built.q).toBe(
      [
        '(air quality)',
        '(metadata.resource_type.props.type:"dataset" OR metadata.resource_type.id:"publication-article")',
        '(files.types:"csv" OR files.types:"zip")',
        'access.status:"metadata-only"',
      ].join(' AND '),
    );
    expect(built.params).toEqual([
      ['q', built.q],
      ['communities', '9649d306-cf94-49cc-a14d-934ca8fcb515'],
      ['all_versions', 'true'],
      ['sort', 'bestmatch'],
      ['page', '3'],
      ['size', '25'],
    ]);
  });

  it('matches a top-level type on props.type (covering its subtypes) and a subtype on its id', () => {
    expect(buildSearch({ ...base, resourceTypes: ['image'] }).q).toBe(
      'metadata.resource_type.props.type:"image"',
    );
    expect(buildSearch({ ...base, resourceTypes: ['image-photo'] }).q).toBe(
      'metadata.resource_type.id:"image-photo"',
    );
    expect(buildSearch({ ...base, fileTypes: ['pdf'], accessStatus: 'open' }).q).toBe(
      'files.types:"pdf" AND access.status:"open"',
    );
  });

  it('omits all_versions when false', () => {
    expect(buildSearch(base).params.some(([k]) => k === 'all_versions')).toBe(false);
  });

  it('never emits a parameter outside the allowlist', () => {
    const built = buildSearch({
      ...base,
      query: 'x',
      resourceTypes: ['dataset'],
      fileTypes: ['csv'],
      accessStatus: 'open',
      communityId: 'uuid',
      funderRor: '01cwqze88',
      award: { field: 'id', value: 'a::1' },
      creatorOrcid: '0000-0002-1825-0097',
      license: 'mit',
      publishedFrom: '2020-01-01',
      publishedTo: '2021-01-01',
      allVersions: true,
    });
    for (const [key] of built.params) expect(ALLOWLIST.has(key)).toBe(true);
  });

  it('keeps a malformed query inside its group, so every filter clause still applies', () => {
    const q = (query: string) => buildSearch({ ...base, query, license: 'mit' }).q;
    const filter = 'metadata.rights.id:"mit"';
    expect(q('climate "x')).toBe(`(climate "x") AND ${filter}`);
    expect(q('climate\\')).toBe(`(climate\\\\) AND ${filter}`);
    expect(q('x) OR (*')).toBe(`(x\\) OR (*)) AND ${filter}`);
    expect(q('climate OR')).toBe(`(climate) AND ${filter}`);
    expect(q('AND')).toBe(filter);
  });

  it('sends a query with no filter clauses as written', () => {
    expect(buildSearch({ ...base, query: 'climate "x' }).q).toBe('climate "x');
  });
});

describe('balanceQuery', () => {
  it.each([
    ['climate "x', 'climate "x"'],
    ['climate\\', 'climate\\\\'],
    ['"a\\', '"a\\\\"'],
    ['x) OR (*', 'x\\) OR (*)'],
    ['(a OR (b', '(a OR (b))'],
    ['a /re', 'a /re/'],
    ['climate OR', 'climate'],
    ['AND OR climate model AND NOT', 'climate model'],
    ['climate -', 'climate'],
    ['AND', ''],
  ])('%j → %j', (raw, expected) => {
    expect(balanceQuery(raw)).toBe(expected);
  });

  it.each([
    // A range bound is literal to the search engine up to its space, ] or }, so a " or /
    // inside one opens nothing to close (HTTP 200 with a filter, verified 2026-10-17).
    ['[a"b TO c]', '[a"b TO c]'],
    ['[a TO b/c]', '[a TO b/c]'],
    ['{a/b TO c}', '{a/b TO c}'],
    ['x:[a"b TO c"d] OR y', 'x:[a"b TO c"d] OR y'],
    // The phrase left open is then the one after the range.
    ['[a"b TO c] "d', '[a"b TO c] "d"'],
    // A quoted bound stays a phrase, a stray ) is still escaped, and a range that never
    // closes is balanced as text.
    ['["a)" TO b]', '["a)" TO b]'],
    ['[a TO b)]', '[a TO b\\)]'],
    ['[a"b TO', '[a"b TO"'],
    ['[a TO b\\]]', '[a TO b\\]]'],
  ])('%j → %j, reading a range as the search engine does', (raw, expected) => {
    expect(balanceQuery(raw)).toBe(expected);
  });

  const SIZES = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000];
  it.each([
    ['unclosed ranges', (n: number) => '['.repeat(n)],
    ['ranges holding quotes and slashes', (n: number) => '[a"b TO c/d] '.repeat(n / 13)],
    ['ranges whose quotes close past them', (n: number) => '[a"b TO c] "d '.repeat(n / 14)],
    ['a range left open over quotes', (n: number) => `[${'"a '.repeat(n / 3)}`],
    ['interleaved line breaks', (n: number) => `${'§1 x'.repeat(n / 4)}\ny`],
  ])(
    'stays linear in CPU time on %s',
    (_label, shape) => {
      const perCall: number[] = [];
      for (const n of SIZES) {
        const query = shape(n);
        const ms = cpuMsPerCall(() => balanceQuery(query));
        expect(ms).toBeLessThan(n / 1000);
        perCall.push(ms);
      }
      expect((perCall.at(-1) as number) / (perCall[0] as number)).toBeLessThan(256);
    },
    60_000,
  );

  it.each([
    'climate',
    'NOT climate',
    '-draft climate',
    'metadata.title:"a (b"',
    '(a OR b) AND c',
    'a\\) b',
    '/a(/ b',
    '"a\\"b"',
    'a   "b  c"',
  ])('leaves the well-formed %j unchanged', (query) => {
    expect(balanceQuery(query)).toBe(query);
  });

  it.each([
    ['operator words', 'AND '.repeat(50_000)],
    ['open groups', '('.repeat(200_000)],
    ['stray closers', ')'.repeat(200_000)],
  ])('stays linear on %s', (_label, query) => {
    const started = performance.now();
    balanceQuery(query);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe('queryAsSent', () => {
  it('balances the query when filter clauses compose with it', () => {
    expect(queryAsSent('climate (', true)).toBe('climate ()');
    expect(queryAsSent('AND', true)).toBe('');
    expect(queryAsSent(undefined, true)).toBe('');
  });

  it('trims and otherwise keeps the query as written when nothing composes with it', () => {
    expect(queryAsSent('  climate (  ', false)).toBe('climate (');
    expect(queryAsSent(undefined, false)).toBe('');
  });
});

/**
 * Every query shape classified with luqum 1.0.0 (the parser Zenodo runs on `q`):
 * [query, parses as written (sent with no filters), parses once balanced (sent with
 * filters, where an empty balanced query leaves `q` filters-only)].
 */
const LUQUM_CORPUS: [string, boolean, boolean][] = [
  ['climate AND AND model', false, false],
  ['climate AND OR model', false, false],
  ['climate OR OR model', false, false],
  ['climate AND NOT AND model', false, false],
  ['AND climate', false, true],
  ['OR climate', false, true],
  ['climate AND', false, true],
  ['climate NOT', false, true],
  ['climate -', false, true],
  ['climate +', false, true],
  ['NOT climate', true, true],
  ['NOT NOT climate', true, true],
  ['climate "model', false, true],
  ['climate (', false, false],
  ['climate ()', false, false],
  ['(climate AND) model', false, false],
  ['climate AND (model OR)', false, false],
  ['climate) OR (model', false, true],
  ['metadata.title:', false, false],
  ['metadata.title: AND climate', false, false],
  [':climate', false, false],
  ['climate::model', false, false],
  ['climate:', false, false],
  ['[2020 TO', false, false],
  ['[2020]', false, false],
  ['metadata.publication_date:[2020 TO', false, false],
  ['climate~~', false, false],
  ['~climate', false, false],
  ['climate^', true, true],
  ["'climate change'", false, false],
  ["climate 'model'", false, false],
  ["don't panic", true, true],
  ['climate \\', false, true],
  ['climate/', true, true],
  ['foo.bar:climate', true, true],
  ['a:b:c', true, true],
  ['climate && model', true, true],
  ['climate || model', true, true],
  ['!climate', true, true],
  ['climate >', false, false],
  ['>2020', true, true],
  ['climate <', false, false],
  ['climate { model', false, false],
  ['climate ] model', false, false],
  ['climate } model', false, false],
  ['TO', true, true],
  ['climate TO model', true, true],
  ['climate model^2', true, true],
  ['"climate model"~', true, true],
  ['"climate model"~3', true, true],
  ['title:(climate model)', true, true],
  ['metadata.title:"climate model"', true, true],
  ['klimaændring 气候', true, true],
  ['climate + + model', true, true],
  ['climate - - model', true, true],
  ['*', true, true],
  ['*:*', true, true],
  ['climate~', true, true],
  ['internal_notes.note:x', true, true],
  ['""', true, true],
  ['climate AND model', true, true],
  ['climate model', true, true],
  ['"climate model"', true, true],
  ['metadata.subjects.subject:"climate change" AND -metadata.title:review', true, true],
  ['metadata.publication_date:[2020-01-01 TO 2020-12-31]', true, true],
  ['doi:"10.5281/zenodo.591564"', true, true],
  ['10.5281\\/zenodo.591564', true, true],
  ['creators.name:Smith*', true, true],
  ['climate^2.5 model', true, true],
  ['+climate -model', true, true],
  ['(climate OR weather) AND (model OR simulation)', true, true],
  ['climate model)', false, true],
  ['((climate', false, true],
  ['climate AND "model', false, true],
  ['climate: model', true, true],
  ['title:climate*', true, true],
  ['climate?model', true, true],
  ['/clim.*/', true, true],
  ['climate = model', true, true],
  ['climate & model', true, true],
  ['climate | model', true, true],
  ['climate @ model #tag 50%', true, true],
  ['"unterminated', false, true],
  ['climate AND AND', false, true],
  ['climate [2020 TO 2021] model', true, true],
  ['{2020 TO 2021]', true, true],
  ['[* TO 2020]', true, true],
  ['climate^^2', true, true],
  ['climate~2~2', false, false],
  ['-', false, true],
  ['climate , model', true, true],
  ['climate ; model', true, true],
  ['C++ programming', true, true],
  ['C# language', true, true],
  ['R: a language', true, true],
  ['COVID-19 vaccine', true, true],
  ['e-mail', true, true],
  ['2020-01-01T12:30:00', true, true],
  ['https://example.org/x', true, true],
];

/** Fastest CPU time (ms) of one `fn()` call; each of five samples repeats until it has used ~20 ms. */
function cpuMsPerCall(fn: () => void): number {
  let best = Number.POSITIVE_INFINITY;
  for (let sample = 0; sample < 5; sample++) {
    const start = process.threadCpuUsage();
    let calls = 0;
    let usedMs = 0;
    while (usedMs < 20) {
      fn();
      calls++;
      const { user, system } = process.threadCpuUsage(start);
      usedMs = (user + system) / 1000;
    }
    best = Math.min(best, usedMs / calls);
  }
  return best;
}

describe('querySyntaxError', () => {
  it('rejects 41 of the 99 corpus shapes as written and 26 once balanced, none that parsed as written', () => {
    expect(LUQUM_CORPUS).toHaveLength(99);
    const asWritten = LUQUM_CORPUS.map(([query]) => query).filter(
      (query) => querySyntaxError(query) !== undefined,
    );
    const balanced = LUQUM_CORPUS.map(([query]) => query).filter((query) => {
      const sent = queryAsSent(query, true);
      return sent !== '' && querySyntaxError(sent) !== undefined;
    });
    expect(asWritten).toHaveLength(41);
    expect(balanced).toHaveLength(26);
    expect(asWritten).toEqual(expect.arrayContaining(balanced));
  });

  it.each(LUQUM_CORPUS)(
    '%j agrees with luqum (as written: %s, balanced: %s)',
    (query, alone, filtered) => {
      expect(querySyntaxError(query) === undefined).toBe(alone);
      const sent = queryAsSent(query, true);
      expect(sent === '' || querySyntaxError(sent) === undefined).toBe(filtered);
    },
  );

  it.each([
    ['climate AND AND model', { problem: 'unexpected', index: 12, token: 'AND' }],
    ['climate AND OR model', { problem: 'unexpected', index: 12, token: 'OR' }],
    ['climate ()', { problem: 'unexpected', index: 9, token: ')' }],
    ['climate ] model', { problem: 'unexpected', index: 8, token: ']' }],
    ['climate::model', { problem: 'unexpected', index: 8, token: ':' }],
    ['climate~~', { problem: 'unexpected', index: 8, token: '~' }],
    ['[2020]', { problem: 'unexpected', index: 5, token: ']' }],
    ['[a TO b TO c]', { problem: 'unexpected', index: 8, token: 'TO' }],
    ['metadata.title:', { problem: 'end', index: 15, token: '' }],
    ['[2020 TO', { problem: 'end', index: 8, token: '' }],
    ['climate >', { problem: 'end', index: 9, token: '' }],
    ['((climate)', { problem: 'end', index: 10, token: '' }],
    ["'climate change'", { problem: 'quote', index: 0, token: "'" }],
    ['climate \\', { problem: 'escape', index: 8, token: '\\' }],
    ['a\\\nb', { problem: 'escape', index: 1, token: '\\' }],
    ['"a\\\nb"', { problem: 'escape', index: 2, token: '\\' }],
    ['climate "model', { problem: 'phrase', index: 8, token: '"model' }],
    ['climate /mod', { problem: 'regex', index: 8, token: '/mod' }],
  ])('locates the first problem in %j', (query, expected) => {
    expect(querySyntaxError(query)).toEqual(expected);
  });

  it.each([
    // Separators are Python's whitespace: NBSP, NEL, and U+001C split tokens; U+FEFF does not.
    ['climate AND AND model', false],
    ['climate\u0085AND AND model', false],
    ['climate\u001cAND\u001cAND\u001cmodel', false],
    ['climate﻿AND﻿AND﻿model', true],
    // A backslash escapes any character except a line feed.
    ['a\\\tb', true],
    ['x\\', false],
    ['"\\""', true],
    ['/\\//', true],
    // A `:` after T and two decimal digits (any script) continues the term as a time.
    ['[T12:30 TO x]', true],
    ['[T12:30:00 TO x]', true],
    ['>T12:30', true],
    ['[T١٢:٣٤ TO x]', true],
    ['[T\u{1d7cf}\u{1d7d0}:\u{1d7d1}\u{1d7d2} TO x]', true],
    ['[T²²:³³ TO x]', false],
    ['[t12:30 TO x]', false],
    ['[T12:30:0 TO x]', false],
    // Grammar edges.
    ['TO:x', false],
    ['x^2~', false],
    ['x~^2', true],
    ['"q"~2^3', true],
    ['[-a TO -"b"]', true],
    ['{* TO *}', true],
    ['a:[1 TO 2]', true],
    ['a:>1', true],
    ['title:(a b)^2', true],
    ['((((x))))^2', true],
    ['-+-NOT x', true],
    ['x:~', false],
    ['>=', false],
    ['x\'y x"y x/y x<y x+y-z', true],
    ['', false],
  ])('%j parses: %s', (query, parses) => {
    expect(querySyntaxError(query) === undefined).toBe(parses);
  });

  /**
   * Classified with luqum 1.0.0: a `conv` value raises outside `ParseError` (Zenodo
   * answers HTTP 500), the rest parse or fail as `ParseError` (the plain-text
   * fallback). luqum reduces the value on reading the next token, unless that token
   * fails to lex or is a `:`, `]`, or `~`.
   */
  it.each([
    ['climate^1.2.3', { problem: 'boost', index: 7, token: '^1.2.3' }],
    ['climate^.', { problem: 'boost', index: 7, token: '^.' }],
    ['climate^1..2', { problem: 'boost', index: 7, token: '^1..2' }],
    ['climate~1.2.3', { problem: 'fuzzy', index: 7, token: '~1.2.3' }],
    ['climate~.', { problem: 'fuzzy', index: 7, token: '~.' }],
    ['"x y"~0.5', { problem: 'proximity', index: 5, token: '~0.5' }],
    ['"x y"~1.0', { problem: 'proximity', index: 5, token: '~1.0' }],
    ['"x y"~2.', { problem: 'proximity', index: 5, token: '~2.' }],
    ['"x y"~.', { problem: 'proximity', index: 5, token: '~.' }],
    // Reduced on any token the grammar can read next, a stray ) or an open group included.
    ['climate^1.2.3 )', { problem: 'boost', index: 7, token: '^1.2.3' }],
    ['(climate^1.2.3', { problem: 'boost', index: 8, token: '^1.2.3' }],
    ['climate^1.2.3^', { problem: 'boost', index: 7, token: '^1.2.3' }],
    ['climate^2^1.2.3', { problem: 'boost', index: 9, token: '^1.2.3' }],
    ['climate^1.2.3 AND AND', { problem: 'boost', index: 7, token: '^1.2.3' }],
    ['"x y"~0.5 )', { problem: 'proximity', index: 5, token: '~0.5' }],
    ['x:y~1.2.3', { problem: 'fuzzy', index: 3, token: '~1.2.3' }],
    ['>x^1.2.3', { problem: 'boost', index: 2, token: '^1.2.3' }],
    ['[a TO b]^1.2.3', { problem: 'boost', index: 8, token: '^1.2.3' }],
    ['(a)^1.2.3', { problem: 'boost', index: 3, token: '^1.2.3' }],
    // Stopped first: the next token fails to lex, or the parser rejects it unreduced.
    ["climate^1.2.3 'x", { problem: 'quote', index: 14, token: "'" }],
    ['climate^1.2.3 ]', { problem: 'unexpected', index: 14, token: ']' }],
    ['climate^1.2.3 :', { problem: 'unexpected', index: 14, token: ':' }],
    ['climate~1.2.3 ~', { problem: 'unexpected', index: 14, token: '~' }],
    ['climate^1.2.3 "a', { problem: 'phrase', index: 14, token: '"a' }],
    ['climate^1.2.3 /x', { problem: 'regex', index: 14, token: '/x' }],
    ['"x y"~0.5 ]', { problem: 'unexpected', index: 10, token: ']' }],
    ['AND AND climate^1.2.3', { problem: 'unexpected', index: 0, token: 'AND' }],
    ['a)^1.2.3', { problem: 'unexpected', index: 1, token: ')' }],
  ])('reports the number luqum cannot convert, where it converts it, in %j', (query, expected) => {
    expect(querySyntaxError(query)).toEqual(expected);
  });

  it.each([
    'climate^2',
    'climate^0.5',
    'climate^.5',
    'climate^1.',
    'climate^0',
    'climate^00.5',
    'climate^',
    'climate~0.5',
    'climate~3',
    'climate~1.',
    'climate~',
    '"x y"~2',
    '"x y"~00',
    '"x y"~',
  ])('accepts the convertible value in %j', (query) => {
    expect(querySyntaxError(query)).toBeUndefined();
  });

  it.each([
    ['climate^1.2.3', true],
    ['climate~1.2.3', true],
    ['"x y"~0.5', true],
    ['climate AND AND model', false],
    ["climate^1.2.3 'x", false],
  ])('marks %j as a conversion error: %s', (query, expected) => {
    const error = querySyntaxError(query);
    expect(error).toBeDefined();
    expect(error !== undefined && isConversionError(error)).toBe(expected);
  });

  it('rejects a balanced query that would close the group it is composed in', () => {
    // Balancing reads the mid-term " as opening a phrase, so the ) is left as written;
    // inside (…) it would end the group and the closing " would swallow the filters.
    const sent = queryAsSent('a" )', true);
    expect(sent).toBe('a" )"');
    expect(querySyntaxError(sent)).toEqual({ problem: 'unexpected', index: 3, token: ')' });
  });

  it('accepts any nesting and prefix depth without recursion', () => {
    const depth = 100_000;
    expect(querySyntaxError(`${'('.repeat(depth)}x${')'.repeat(depth)}`)).toBeUndefined();
    expect(querySyntaxError(`${'('.repeat(depth)}x`)).toEqual({
      problem: 'end',
      index: depth + 1,
      token: '',
    });
    expect(querySyntaxError(`${'-'.repeat(depth)}x`)).toBeUndefined();
    expect(querySyntaxError(`${'a:'.repeat(depth)}x`)).toBeUndefined();
    expect(querySyntaxError(`${'x AND '.repeat(depth)}x`)).toBeUndefined();
  });

  const SIZES = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000];
  it.each([
    ['nested groups', (n: number) => `${'('.repeat(n / 2)}x${')'.repeat(n / 2)}`],
    ['unclosed groups', (n: number) => '('.repeat(n)],
    ['a prefix run', (n: number) => `${'NOT '.repeat(n / 4)}x`],
    ['operators between terms', (n: number) => `${'x AND '.repeat(n / 6)}x`],
    ['a field chain of time terms', (n: number) => 'T12:30:'.repeat(Math.floor(n / 7))],
    ['an unterminated phrase', (n: number) => `"${'x '.repeat(n / 2)}`],
    ['an unterminated regex', (n: number) => `/${'x'.repeat(n)}`],
    ['a run of backslashes', (n: number) => '\\'.repeat(n)],
    ['interleaved line breaks', (n: number) => `${'§1 x'.repeat(n / 4)}\ny`],
    ['one long boost value', (n: number) => `x^${'1.'.repeat(n / 2)}`],
    ['boosted and fuzzy terms', (n: number) => `${'x^2 y~0.5 '.repeat(n / 10)}x`],
  ])(
    'stays linear in CPU time on %s',
    (_label, shape) => {
      const perCall: number[] = [];
      for (const n of SIZES) {
        const query = shape(n);
        const ms = cpuMsPerCall(() => querySyntaxError(query));
        // ≤1 µs per character: a linear scan sits far below it at every size, and a
        // quadratic one crosses it before the doubling reaches the largest size.
        expect(ms).toBeLessThan(n / 1000);
        perCall.push(ms);
      }
      expect((perCall.at(-1) as number) / (perCall[0] as number)).toBeLessThan(256);
    },
    60_000,
  );
});

describe('quoteValue', () => {
  it('quotes and escapes', () => {
    expect(quoteValue('10.5281/zenodo.1')).toBe('"10.5281/zenodo.1"');
    expect(quoteValue('say "hi"')).toBe('"say \\"hi\\""');
    expect(quoteValue('C:\\path')).toBe('"C:\\\\path"');
  });
});

describe('escapeVocabularyQuery', () => {
  it.each([
    ['10.13039/100000002', '10.13039\\/100000002'],
    ['a:b:c', 'a\\:b\\:c'],
    ['[x] {y} (z)', '\\[x\\] \\{y\\} \\(z\\)'],
    ['a^2~b!?', 'a\\^2\\~b\\!\\?'],
    ['back\\slash', 'back\\\\slash'],
  ])('%j → %j', (raw, expected) => {
    expect(escapeVocabularyQuery(raw)).toBe(expected);
  });

  it('keeps quotes, wildcards, and +/- operators meaningful', () => {
    expect(escapeVocabularyQuery('"open data" +wellcome -trust clim*')).toBe(
      '"open data" +wellcome -trust clim*',
    );
  });
});

describe('engineSyntaxError', () => {
  it.each([
    // A / opens a regex mid-term too; one never closed runs to the end.
    ['climate 10.5281/zenodo.591564', { problem: 'regex', index: 15, token: '/zenodo.591564' }],
    ['10.5281/zenodo.591564', { problem: 'regex', index: 7, token: '/zenodo.591564' }],
    ['a/b/c/d', { problem: 'regex', index: 5, token: '/d' }],
    ['a\\\\/b', { problem: 'regex', index: 3, token: '/b' }],
    ['climate /model', { problem: 'regex', index: 8, token: '/model' }],
    ['x "/a"/ b', { problem: 'regex', index: 6, token: '/ b' }],
    // A regex body opening a quoted string it never closes (HTTP 400, verified 2026-10-17).
    ['/a"/ b', { problem: 'regex_quote', index: 0, token: '/a"/' }],
    ['/"a/ b"', { problem: 'regex_quote', index: 0, token: '/"a/' }],
    ['x /a"/ "b/c"', { problem: 'regex_quote', index: 2, token: '/a"/' }],
    // A " inside a word opens a phrase for the engine, where luqum reads it as part of
    // the word; one never closed fails (HTTP 500, verified 2026-10-17), inside a group too.
    ['climate a"b', { problem: 'word_quote', index: 9, token: '"b' }],
    ['a"b', { problem: 'word_quote', index: 1, token: '"b' }],
    ['a"', { problem: 'word_quote', index: 1, token: '"' }],
    ['(a"b)', { problem: 'word_quote', index: 2, token: '"b)' }],
    // Paired inside words, the engine's phrases can leave luqum's closing " open.
    ['a"b "c d"', { problem: 'word_quote', index: 8, token: '"' }],
    // …or take in a bracket the query needs (HTTP 500 for the first, verified 2026-10-17).
    ['(a"b) c"', { problem: 'word_span', index: 2, token: '"b) c"' }],
    ['a"b [c" TO d]', { problem: 'word_span', index: 1, token: '"b [c"' }],
    ['a"b "(" c"', { problem: 'word_span', index: 1, token: '"b "' }],
    ['(a/b) c/', { problem: 'word_span', index: 2, token: '/b) c/' }],
    // A range bound ends at its first space, ] or }, escaped or not, and one ending in an
    // unpaired \ cannot be unescaped (HTTP 500 for the first three, verified 2026-10-17).
    ['[a TO b\\]]', { problem: 'range_escape', index: 6, token: 'b\\' }],
    ['[a\\ b TO c]', { problem: 'range_escape', index: 1, token: 'a\\' }],
    ['[a TO b\\ ]', { problem: 'range_escape', index: 6, token: 'b\\' }],
    ['x {a TO b\\]}', { problem: 'range_escape', index: 8, token: 'b\\' }],
    ['[a TO b\\\\\\}]', { problem: 'range_escape', index: 6, token: 'b\\\\\\' }],
    // An unescaped ! outside a phrase, regex, or range is NOT, inside a word too, and
    // fails with nothing after it but a ) or the end (HTTP 500 for the first two,
    // verified 2026-10-17).
    ['climate!', { problem: 'dangling_not', index: 7, token: '!' }],
    ['(climate!) model', { problem: 'dangling_not', index: 8, token: '!' }],
    ['climate !  ', { problem: 'dangling_not', index: 8, token: '!' }],
    ['a!!', { problem: 'dangling_not', index: 2, token: '!' }],
    ['!', { problem: 'dangling_not', index: 0, token: '!' }],
  ])('%j → %j', (query, expected) => {
    expect(engineSyntaxError(query)).toEqual(expected);
  });

  it.each([
    '10.5281\\/zenodo.591564',
    '"10.5281/zenodo.591564"',
    'doi:"10.5281/zenodo.591564"',
    '/regex/',
    'climate model',
    '"unclosed / quote',
    // A " inside /…/ belongs to the regex, closed (HTTP 200, verified 2026-10-17),
    // escaped, or literal in a character class.
    '/[a"]/ b',
    '/a"b"/ c',
    '/a\\"/ b',
    '/[^"]/',
    '/[]"]/ x',
    '/[\\]"]/',
    '/clim.*/ "a/b"',
    // Every " the engine opens inside a word closes, and the brackets still pair
    // (HTTP 200 for the first two, verified 2026-10-17).
    'climate a"b"',
    'a"b c"d',
    'x"y"z',
    'a\\"b',
    '(a"b) (c")',
    // luqum's own phrase left open: matched as plain text without filters, closed by
    // balancing with them (HTTP 200, verified 2026-10-17).
    'climate "model',
    // A range bound runs to the next space, ] or }, so a " or / inside it is literal
    // (HTTP 200, verified 2026-10-17).
    '[a"b TO c/d]',
    '["a]" TO b/c]',
    '{a/b TO c}',
    // A bound ending in a paired \, an escape inside a bound, and a quoted bound unescape.
    '[a TO b\\\\]',
    '[a\\:b TO c]',
    '[a TO "b]"]',
    '["a\\]" TO b]',
    // A ! with a term after it, escaped, or inside a phrase, regex, or range.
    '!climate',
    'climate! model',
    'climate!model',
    'climate ! model',
    'climate\\!',
    '"climate!"',
    '/climate!/',
    '[a TO b!]',
  ])('%j holds nothing Zenodo cannot run', (query) => {
    expect(engineSyntaxError(query)).toBeUndefined();
  });

  const SIZES = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000];
  it.each([
    ['closed regexes holding quoted strings', (n: number) => '/"a"/ '.repeat(n / 6)],
    ['an unterminated regex', (n: number) => `/${'x'.repeat(n)}`],
    ['regexes with a quote and no closing quote', (n: number) => `${'/a/ '.repeat(n / 4)}/"x/`],
    ['an unclosed character class', (n: number) => `/[${'a'.repeat(n)}/`],
    ['phrases between slashes', (n: number) => `${'"/" '.repeat(n / 4)}x`],
    ['interleaved line breaks', (n: number) => `${'§1 x'.repeat(n / 4)}\ny`],
    ['words holding paired quotes', (n: number) => 'a"b c"d '.repeat(n / 8)],
    ['a word quote left open after paired ones', (n: number) => `${'a"b c"d '.repeat(n / 8)}x"y`],
    [
      'a word phrase over nested groups',
      (n: number) => `${'('.repeat(n / 2)}a"b${')'.repeat(n / 2)} c"`,
    ],
    ['ranges with quoted bounds', (n: number) => '["a]" TO b/c] '.repeat(n / 14)],
    ['a range left open over quotes', (n: number) => `[${'"a '.repeat(n / 3)}`],
    [
      'range bounds ending in paired backslashes',
      (n: number) => '[a\\\\ TO b\\\\] '.repeat(n / 13),
    ],
    ['one range bound of backslashes', (n: number) => `[a TO ${'\\\\'.repeat(n / 2)}]`],
    ['NOTs each before a term', (n: number) => '!a '.repeat(n / 3)],
    ['a NOT before a long gap', (n: number) => `x !${' '.repeat(n)}y`],
  ])(
    'stays linear in CPU time on %s',
    (_label, shape) => {
      const perCall: number[] = [];
      for (const n of SIZES) {
        const query = shape(n);
        const ms = cpuMsPerCall(() => engineSyntaxError(query));
        expect(ms).toBeLessThan(n / 1000);
        perCall.push(ms);
      }
      expect((perCall.at(-1) as number) / (perCall[0] as number)).toBeLessThan(256);
    },
    60_000,
  );
});

describe('isValidPartialDate', () => {
  it.each(['2020', '2020-01', '2020-12', '2024-02-29', '2000-02-29', '2023-01-31', '2023-04-30'])(
    'accepts %s',
    (value) => {
      expect(isValidPartialDate(value)).toBe(true);
    },
  );

  it.each([
    '2023-02-29',
    '1900-02-29',
    '2023-02-30',
    '2023-04-31',
    '2020-13',
    '2020-00',
    '2020-1',
    '2020-01-00',
    '2020-01-32',
    '20',
    '2020/01/01',
    '2020-01-01T00:00',
    '',
  ])('rejects %j', (value) => {
    expect(isValidPartialDate(value)).toBe(false);
  });
});

describe('expandPartialDate', () => {
  it.each([
    ['2020', 'from', '2020-01-01'],
    ['2020', 'to', '2020-12-31'],
    ['2020-04', 'from', '2020-04-01'],
    ['2020-04', 'to', '2020-04-30'],
    ['2024-02', 'to', '2024-02-29'],
    ['2023-02', 'to', '2023-02-28'],
    ['1900-02', 'to', '1900-02-28'],
    ['2000-02', 'to', '2000-02-29'],
    ['2020-12', 'to', '2020-12-31'],
    ['2020-06-15', 'from', '2020-06-15'],
    ['2020-06-15', 'to', '2020-06-15'],
  ] as const)('%s (%s) → %s', (value, side, expected) => {
    expect(expandPartialDate(value, side)).toBe(expected);
  });

  it('returns an unparseable value unchanged', () => {
    expect(expandPartialDate('not-a-date', 'from')).toBe('not-a-date');
  });

  // Date.UTC(year, …) maps years 0–99 to 1900–1999; year 0000 is a leap year in the
  // proleptic Gregorian calendar, 0099 and 0100 are not.
  it('takes years 0000–0099 literally', () => {
    expect(isValidPartialDate('0000-02-29')).toBe(true);
    expect(expandPartialDate('0000-02', 'to')).toBe('0000-02-29');
    expect(isValidPartialDate('0099-02-29')).toBe(false);
    expect(expandPartialDate('0004-02', 'to')).toBe('0004-02-29');
    expect(expandPartialDate('0100-02', 'to')).toBe('0100-02-28');
  });
});
