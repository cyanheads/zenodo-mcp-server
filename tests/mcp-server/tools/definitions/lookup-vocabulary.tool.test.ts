/**
 * @fileoverview Tests for zenodo_lookup_vocabulary through the real service and a
 * strict fetch fake: each vocabulary (communities, funders, awards, licenses,
 * resource types), zero hits, paging and truncation notices, funder scoping for
 * awards, the typed error contract with its recovery hints, the production
 * `output.extend(enrichment)` parse via runToolContract, blank form fields, and
 * format() rendering.
 * @module tests/mcp-server/tools/definitions/lookup-vocabulary.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createMockContext,
  type FetchMockHarness,
  getEnrichment,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lookupVocabulary } from '@/mcp-server/tools/definitions/lookup-vocabulary.tool.js';
import { disposeZenodoService, initZenodoService } from '@/services/zenodo/zenodo-service.js';
import {
  fixture,
  jsonResponse,
  onPath,
  queryOf,
  rateHeaders,
  settle,
  textResponse,
} from '../../../helpers/zenodo-fixtures.js';

const NOW = new Date('2026-09-23T12:00:00Z');

const recovery = (reason: string) =>
  lookupVocabulary.errors?.find((e) => e.reason === reason)?.recovery as string;

let fm: FetchMockHarness;

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  fm = createFetchMock();
  fm.install();
  initZenodoService({ mcpServerVersion: '0.1.0' } as AppConfig);
});

afterEach(() => {
  disposeZenodoService();
  fm.restore();
  vi.useRealTimers();
});

function serve(path: string, body: unknown) {
  fm.route({ match: onPath(path, 'application/json'), respond: () => jsonResponse(body) });
}

async function call(input: Record<string, unknown>) {
  const ctx = createMockContext({ errors: lookupVocabulary.errors });
  const result = await lookupVocabulary.handler(lookupVocabulary.input.parse(input), ctx);
  return { result, enrichment: getEnrichment(ctx) };
}

async function failure(input: Record<string, unknown>): Promise<McpError> {
  const ctx = createMockContext({ errors: lookupVocabulary.errors });
  const outcome = await settle(lookupVocabulary.handler(lookupVocabulary.input.parse(input), ctx));
  if (outcome.ok) throw new Error('expected the handler to throw');
  expect(outcome.error).toBeInstanceOf(McpError);
  return outcome.error as McpError;
}

function textOf(result: Parameters<NonNullable<typeof lookupVocabulary.format>>[0]): string {
  const block = lookupVocabulary.format?.(result)[0] as { text: string } | undefined;
  return block?.text ?? '';
}

describe('zenodo_lookup_vocabulary — vocabularies', () => {
  it('communities: slug feeds community; null upstream fields stay absent', async () => {
    serve('/communities', fixture('communities-q-astronomy.json'));
    const { result, enrichment } = await call({
      vocabulary: 'communities',
      query: 'astronomy',
      size: 2,
    });
    expect(result).toEqual({
      vocabulary: 'communities',
      query: 'astronomy',
      total: 1148,
      page: 1,
      size: 2,
      has_more: true,
      next_page: 2,
      entries: [
        {
          filter_param: 'community',
          filter_value: 'sochias',
          label: 'Sociedad Chilena de Astronomía (SOCHIAS)',
          slug: 'sochias',
          uuid: '9649d306-cf94-49cc-a14d-934ca8fcb515',
          community_type: 'Organization',
          website: 'https://zenodo.org/communities/sochias',
          organizations: ['SOCHIAS'],
        },
        {
          filter_param: 'community',
          filter_value: 'siac',
          label: 'Sociedad Interamericana de Astronomía en la Cultura',
          slug: 'siac',
          uuid: '981b34f3-760d-4264-8ab8-b2f94464937f',
        },
      ],
    });
    expect(enrichment).toEqual({
      truncated: true,
      shown: 2,
      cap: 2,
      totalCount: 1148,
      notice: 'Showing 2 of 1148; call again with page 2.',
    });
    expect(queryOf(fm.calls[0]?.request as Request)).toEqual([
      ['q', 'astronomy'],
      ['page', '1'],
      ['size', '2'],
    ]);
  });

  it('funders: ROR id feeds funder, with the several-funders notice composed into the truncation', async () => {
    serve('/funders', fixture('funders-q-wellcome.json'));
    const { result, enrichment } = await call({
      vocabulary: 'funders',
      query: 'wellcome',
      size: 3,
    });
    expect(result.entries.map((e) => [e.filter_value, e.label, e.funder_doi, e.acronym])).toEqual([
      ['022awwm23', 'Wellcome Collection', undefined, undefined],
      ['029chgv08', 'Wellcome Trust', '10.13039/100010269', 'WT'],
      ['05hde1z07', 'Wellcome Library', undefined, undefined],
    ]);
    expect(result.entries[1]).toMatchObject({
      filter_param: 'funder',
      ror_id: '029chgv08',
      country: 'GB',
      country_name: 'United Kingdom',
    });
    expect(enrichment).toEqual({
      truncated: true,
      shown: 3,
      cap: 3,
      totalCount: 30,
      notice:
        'Several funders share names across countries; pick by country and ROR id. Showing 3 of 30; call again with page 2.',
    });
  });

  it('funders: a single hit gets no ambiguity notice, and a DOI query is escaped', async () => {
    serve('/funders', fixture('funders-by-doi-10.13039-100000002.json'));
    const { result, enrichment } = await call({
      vocabulary: 'funders',
      query: '10.13039/100000002',
    });
    expect(result.entries).toEqual([
      {
        filter_param: 'funder',
        filter_value: '01cwqze88',
        label: 'National Institutes of Health',
        ror_id: '01cwqze88',
        funder_doi: '10.13039/100000002',
        acronym: 'NIH',
        country: 'US',
        country_name: 'United States',
      },
    ]);
    expect(result).not.toHaveProperty('next_page');
    expect(enrichment).toEqual({ truncated: false, shown: 1, cap: 10, totalCount: 1 });
    expect(queryOf(fm.calls[0]?.request as Request)[0]).toEqual(['q', '10.13039\\/100000002']);
  });

  it('awards: award id feeds award, labelled by acronym', async () => {
    serve('/awards', fixture('awards-q-symba.json'));
    const { result } = await call({ vocabulary: 'awards', query: 'SYMBA' });
    expect(result.entries[0]).toEqual({
      filter_param: 'award',
      filter_value: '00k4n6c32::101135562',
      label: 'SYMBA',
      number: '101135562',
      acronym: 'SYMBA',
      title:
        'Securing local supplY chains via the development of new Methods to assess the circularity and symbiosis of the Bio-bAsed industrial ecosystem enhancing the EU competitiveness and resource independence',
      program: 'HORIZON.2.6',
      funder_id: '00k4n6c32',
      funder_name: 'European Commission',
      award_doi: '10.3030/101135562',
      award_url: 'https://cordis.europa.eu/projects/101135562',
      start_date: '2024-01-01',
      end_date: '2026-12-31',
    });
    expect(result.entries[1]).not.toHaveProperty('award_doi');
  });

  it.each(['00k4n6c32', 'https://ror.org/00k4n6c32'])(
    'awards: scopes grants to funder %s after validating it',
    async (funder) => {
      serve('/funders/00k4n6c32', { id: '00k4n6c32', name: 'European Commission' });
      serve('/awards', fixture('awards-q-symba.json'));
      await call({ vocabulary: 'awards', query: 'SYMBA', funder });
      expect(fm.calls.map((c) => new URL(c.request.url).pathname)).toEqual([
        '/api/funders/00k4n6c32',
        '/api/awards',
      ]);
      expect(queryOf(fm.calls[1]?.request as Request)).toContainEqual(['funders', '00k4n6c32']);
    },
  );

  it('awards: resolves a Crossref Funder DOI to its ROR id before scoping', async () => {
    serve('/funders', fixture('funders-by-doi-10.13039-100000002.json'));
    serve('/awards', { hits: { hits: [], total: 0 } });
    await call({ vocabulary: 'awards', query: 'R01', funder: '10.13039/100000002' });
    expect(queryOf(fm.calls[1]?.request as Request)).toContainEqual(['funders', '01cwqze88']);
  });

  it('licenses: license id feeds license; OSI approval omitted when upstream is blank', async () => {
    serve('/vocabularies/licenses', fixture('licenses-q-mit.json'));
    const { result } = await call({ vocabulary: 'licenses', query: 'mit', size: 3 });
    expect(result.entries.map((e) => [e.filter_value, e.label, e.osi_approved])).toEqual([
      ['mit', 'MIT License', true],
      ['aml', 'Apple MIT License', undefined],
      ['mit-0', 'MIT No Attribution', true],
    ]);
    expect(result.entries[0]).toMatchObject({
      filter_param: 'license',
      url: 'https://opensource.org/licenses/MIT',
      tags: ['recommended', 'all', 'software'],
    });
  });

  it('resource_types: served from the static table with no upstream call', async () => {
    const { result, enrichment } = await call({ vocabulary: 'resource_types', query: 'journal' });
    expect(result.entries).toEqual([
      {
        filter_param: 'resource_type',
        filter_value: 'publication-article',
        label: 'Journal article',
        parent_type: 'publication',
        search_value: 'publication::publication-article',
      },
      {
        filter_param: 'resource_type',
        filter_value: 'publication-journal',
        label: 'Journal',
        parent_type: 'publication',
        search_value: 'publication::publication-journal',
      },
    ]);
    expect(enrichment).toEqual({ truncated: false, shown: 2, cap: 10, totalCount: 2 });
    expect(fm.calls).toHaveLength(0);
  });

  it('resource_types: pages the static table and flags the next page', async () => {
    const first = await call({ vocabulary: 'resource_types', size: 20 });
    expect(first.result).toMatchObject({ total: 43, has_more: true, next_page: 2 });
    expect(first.result.entries).toHaveLength(20);
    const last = await call({ vocabulary: 'resource_types', size: 20, page: 3 });
    expect(last.result).toMatchObject({ has_more: false });
    expect(last.result.entries.map((e) => e.filter_value)).toEqual([
      'software-computationalnotebook',
      'video',
      'workflow',
    ]);
  });

  it('notes a page past the end', async () => {
    const { result, enrichment } = await call({ vocabulary: 'resource_types', page: 9, size: 10 });
    expect(result.entries).toEqual([]);
    expect(enrichment).toEqual({
      truncated: false,
      shown: 0,
      cap: 10,
      totalCount: 43,
      notice: 'Page 9 is past the last page (5); call again with page 5 or lower.',
    });
  });
});

describe('zenodo_lookup_vocabulary — zero hits', () => {
  it('routes a zero-hit license query to a shorter keyword or browsing, not to acronyms', async () => {
    serve('/vocabularies/licenses', fixture('licenses-q-nomatch.json'));
    const { result, enrichment } = await call({ vocabulary: 'licenses', query: 'zzqqxxnomatch' });
    expect(result).toEqual({
      vocabulary: 'licenses',
      query: 'zzqqxxnomatch',
      total: 0,
      page: 1,
      size: 10,
      has_more: false,
      entries: [],
    });
    expect(enrichment).toEqual({
      truncated: false,
      shown: 0,
      cap: 10,
      totalCount: 0,
      notice:
        'No licenses matched "zzqqxxnomatch"; try a shorter keyword such as cc-by, gpl, or mit, or call again without query to browse all licenses.',
    });
  });

  it('routes a zero-hit resource_types query to browsing the static list', async () => {
    const { enrichment } = await call({ vocabulary: 'resource_types', query: 'code' });
    expect(enrichment.notice).toBe(
      'No resource_types matched "code"; every word must appear in a type id or label, so try a shorter keyword, or call again without query to list all 43 types.',
    );
    expect(fm.calls).toHaveLength(0);
  });

  it.each([
    ['funders', '/funders', "try a shorter name or the funder's acronym."],
    [
      'awards',
      '/awards',
      "try the grant number, the project's acronym, or a shorter keyword from the award title.",
    ],
    [
      'communities',
      '/communities',
      "try a shorter name, a keyword from the community's title, or the project's acronym.",
    ],
  ])('names acronyms only where they apply: %s', async (vocabulary, path, advice) => {
    serve(path, { hits: { hits: [], total: 0 } });
    const { enrichment } = await call({ vocabulary, query: 'zzqx' });
    expect(enrichment.notice).toBe(`No ${vocabulary} matched "zzqx"; ${advice}`);
  });

  it('suggests dropping funder when a funder-scoped award query misses', async () => {
    serve('/funders/00k4n6c32', { id: '00k4n6c32', name: 'European Commission' });
    serve('/awards', { hits: { hits: [], total: 0 } });
    const { enrichment } = await call({ vocabulary: 'awards', query: 'zzqx', funder: '00k4n6c32' });
    expect(enrichment.notice).toMatch(/, or drop funder to search every funder’s grants\.$/);
  });

  it('flattens a line break in the echoed query', async () => {
    serve('/communities', { hits: { hits: [], total: 0 } });
    const { enrichment } = await call({ vocabulary: 'communities', query: 'a\nb' });
    expect(enrichment.notice).toMatch(/^No communities matched "a b";/);
  });

  it('reports an empty static match', async () => {
    const { enrichment } = await call({ vocabulary: 'resource_types', query: 'spreadsheet' });
    expect(enrichment).toMatchObject({
      totalCount: 0,
      notice: expect.stringMatching(/^No resource_types matched "spreadsheet"/),
    });
  });
});

describe('zenodo_lookup_vocabulary — blank form fields', () => {
  it('reads blank query and funder as unset (browse, no funder_only_for_awards)', async () => {
    serve('/funders', fixture('funders-q-wellcome.json'));
    const { result } = await call({ vocabulary: 'funders', query: '', funder: '  ', size: 3 });
    expect(result).not.toHaveProperty('query');
    expect(queryOf(fm.calls[0]?.request as Request).map(([k]) => k)).toEqual(['page', 'size']);
  });
});

describe('zenodo_lookup_vocabulary — error contract', () => {
  it('funder_only_for_awards, before any upstream call', async () => {
    const err = await failure({ vocabulary: 'licenses', funder: '00k4n6c32' });
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data).toMatchObject({
      reason: 'funder_only_for_awards',
      recovery: { hint: recovery('funder_only_for_awards') },
    });
    expect(fm.calls).toHaveLength(0);
  });

  it.each(['national institutes of health', 'NIH'])(
    'unknown_funder for the name %j without calling upstream (names are never auto-picked)',
    async (funder) => {
      const err = await failure({ vocabulary: 'awards', funder });
      expect(err.data).toMatchObject({
        reason: 'unknown_funder',
        recovery: { hint: recovery('unknown_funder') },
      });
      expect(fm.calls).toHaveLength(0);
    },
  );

  it('unknown_funder for a ROR-shaped id Zenodo does not know', async () => {
    fm.route({
      match: onPath('/funders/0zzzzzz00'),
      respond: () => jsonResponse(fixture('error-404-funder.json'), { status: 404 }),
    });
    const err = await failure({ vocabulary: 'awards', funder: '0zzzzzz00' });
    expect(err.data).toMatchObject({ reason: 'unknown_funder' });
    expect(fm.calls).toHaveLength(1);
  });

  it('unknown_funder for a Funder DOI no funder carries', async () => {
    serve('/funders', { hits: { hits: [], total: 0 } });
    const err = await failure({ vocabulary: 'awards', funder: '10.13039/999999999' });
    expect(err.data).toMatchObject({ reason: 'unknown_funder' });
  });

  it('result_window_exceeded past 10,000 entries, before any upstream call', async () => {
    const err = await failure({ vocabulary: 'communities', page: 401, size: 25 });
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data).toMatchObject({
      reason: 'result_window_exceeded',
      recovery: { hint: recovery('result_window_exceeded') },
    });
    expect(fm.calls).toHaveLength(0);
  });

  it('allows the last in-window page', async () => {
    serve('/communities', { hits: { hits: [], total: 1148 } });
    const { result } = await call({ vocabulary: 'communities', page: 400, size: 25 });
    expect(result.page).toBe(400);
  });

  it('rate_limited on a 429, with the lookup_vocabulary recovery hint', async () => {
    fm.route({
      match: onPath('/communities'),
      respond: () => textResponse('{}', 429, rateHeaders('general', 0, 60)),
    });
    const err = await failure({ vocabulary: 'communities', query: 'astronomy' });
    expect(err.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(err.data).toMatchObject({
      reason: 'rate_limited',
      retryAfter: 60,
      recovery: { hint: recovery('rate_limited') },
    });
  });
});

describe('zenodo_lookup_vocabulary — runToolContract (production output + enrichment parse)', () => {
  it('passes the enrichment parse on a zero-result page', async () => {
    serve('/vocabularies/licenses', fixture('licenses-q-nomatch.json'));
    const result = await runToolContract(lookupVocabulary, {
      vocabulary: 'licenses',
      query: 'zzqqxxnomatch',
      funder: '',
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      total: 0,
      entries: [],
      truncated: false,
      shown: 0,
      cap: 10,
      totalCount: 0,
    });
  });

  it('passes the enrichment parse on an under-cap page', async () => {
    serve('/funders', fixture('funders-by-doi-10.13039-100000002.json'));
    const result = await runToolContract(lookupVocabulary, {
      vocabulary: 'funders',
      query: '10.13039/100000002',
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      total: 1,
      has_more: false,
      truncated: false,
      shown: 1,
      totalCount: 1,
    });
  });

  it('passes the enrichment parse on a truncated page', async () => {
    serve('/communities', fixture('communities-q-astronomy.json'));
    const result = await runToolContract(lookupVocabulary, { vocabulary: 'communities', size: 2 });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      truncated: true,
      next_page: 2,
      totalCount: 1148,
    });
  });

  it('passes the enrichment parse on a static page with no upstream call', async () => {
    const result = await runToolContract(lookupVocabulary, {
      vocabulary: 'resource_types',
      query: '',
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ total: 43, truncated: true, shown: 10 });
  });

  it('renders funder_only_for_awards as an error envelope carrying the recovery hint', async () => {
    const result = await runToolContract(lookupVocabulary, {
      vocabulary: 'funders',
      funder: '00k4n6c32',
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'funder_only_for_awards',
          recovery: { hint: recovery('funder_only_for_awards') },
        },
      },
    });
    expect((result.content[0] as { text: string }).text).toContain(
      recovery('funder_only_for_awards'),
    );
  });

  it('rejects size above 25 and an unknown vocabulary at the schema', async () => {
    const tooBig = await runToolContract(lookupVocabulary, { vocabulary: 'licenses', size: 26 });
    expect(tooBig.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
    const unknown = await runToolContract(lookupVocabulary, { vocabulary: 'datasets' } as never);
    expect(unknown.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
    expect((unknown.content[0] as { text: string }).text).toContain('resource_types');
    expect(fm.calls).toHaveLength(0);
  });

  it.each([
    ['Funders', 'funders'],
    ['funder', 'funders'],
    ['license', 'licenses'],
    ['LICENSES', 'licenses'],
    ['Community', 'communities'],
    ['award', 'awards'],
    ['grants', 'awards'],
    ['resource-types', 'resource_types'],
    ['resource types', 'resource_types'],
    ['Resource Type', 'resource_types'],
  ])('folds vocabulary %j to %s', (value, vocabulary) => {
    expect(lookupVocabulary.input.parse({ vocabulary: value }).vocabulary).toBe(vocabulary);
  });

  it('keeps the advertised vocabulary enum canonical', () => {
    const schema = z.toJSONSchema(lookupVocabulary.input) as {
      properties: Record<string, { enum?: string[] }>;
    };
    expect(schema.properties.vocabulary?.enum).toEqual([
      'communities',
      'funders',
      'awards',
      'licenses',
      'resource_types',
    ]);
  });
});

describe('zenodo_lookup_vocabulary — format()', () => {
  it('renders the filter line and every present detail', async () => {
    serve('/awards', fixture('awards-q-symba.json'));
    const text = textOf((await call({ vocabulary: 'awards', query: 'SYMBA', size: 1 })).result);
    for (const needle of [
      '## Zenodo awards matching "SYMBA"',
      '**Total:** 2 | **Page:** 1 | **Size:** 1 | **Has more:** true | **Next page:** 2',
      '### SYMBA',
      '- **Filter:** award = `00k4n6c32::101135562`',
      '- **Number:** 101135562',
      '- **Title:** Securing local supplY chains',
      '- **Program:** HORIZON.2.6',
      '- **Funder name:** European Commission',
      '- **Award DOI:** 10.3030/101135562',
      '- **Start date:** 2024-01-01',
    ]) {
      expect(text).toContain(needle);
    }
  });

  it('quotes a multi-line award title and flattens line breaks elsewhere', () => {
    const text = textOf({
      vocabulary: 'awards',
      query: 'x\ny',
      total: 1,
      page: 1,
      size: 10,
      has_more: false,
      entries: [
        {
          filter_param: 'award',
          filter_value: 'a::1',
          label: 'Label\n# injected',
          title: 'Title line one\nTitle line two',
          funder_name: 'Funder\u2028Name',
        },
      ],
    });
    expect(text).toContain('## Zenodo awards matching "x y"');
    expect(text).toContain('### Label # injected');
    expect(text).toContain(
      '- **Title:**\nAward title (untrusted):\n> Title line one\n> Title line two',
    );
    expect(text).toContain('- **Funder name:** Funder Name');
    expect(text.split('\n').some((l) => l.startsWith('# '))).toBe(false);
  });

  it('renders license and community details', async () => {
    serve('/vocabularies/licenses', fixture('licenses-q-mit.json'));
    const licenses = textOf((await call({ vocabulary: 'licenses', query: 'mit', size: 3 })).result);
    expect(licenses).toContain('- **OSI approved:** true');
    expect(licenses).toContain('- **Tags:** recommended, all, software');
    serve('/communities', fixture('communities-q-astronomy.json'));
    const communities = textOf((await call({ vocabulary: 'communities', size: 2 })).result);
    expect(communities).toContain('- **Filter:** community = `sochias`');
    expect(communities).toContain('- **Organizations:** SOCHIAS');
  });
});
