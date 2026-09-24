/**
 * @fileoverview Tests for search composition: the parameter allowlist, `q` clause
 * composition and quoting, query balancing, vocabulary-query escaping, the
 * unpaired-slash detector, and partial-date validation and expansion.
 * @module tests/services/zenodo/query-builder.test
 */

import { describe, expect, it } from 'vitest';
import {
  balanceQuery,
  buildSearch,
  escapeVocabularyQuery,
  expandPartialDate,
  hasUnpairedSlash,
  isValidPartialDate,
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

describe('hasUnpairedSlash', () => {
  it.each([
    ['climate 10.5281/zenodo.591564', true],
    ['10.5281/zenodo.591564', true],
    ['a/b/c/d', true],
    ['10.5281\\/zenodo.591564', false],
    ['"10.5281/zenodo.591564"', false],
    ['doi:"10.5281/zenodo.591564"', false],
    ['/regex/', false],
    ['climate model', false],
    ['a\\\\/b', true],
    ['"unclosed / quote', false],
  ])('%j → %s', (query, expected) => {
    expect(hasUnpairedSlash(query)).toBe(expected);
  });
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
