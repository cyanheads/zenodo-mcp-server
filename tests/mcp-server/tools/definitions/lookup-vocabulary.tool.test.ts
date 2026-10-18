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
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
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
  contractFailure,
  fixture,
  jsonResponse,
  onPath,
  queryOf,
  rateHeaders,
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

/** Fails through runToolContract, which fills the declared recovery hint as production does. */
const failure = (input: Record<string, unknown>) => contractFailure(lookupVocabulary, input);

function textOf(result: Parameters<NonNullable<typeof lookupVocabulary.format>>[0]): string {
  const block = lookupVocabulary.format?.(result)[0] as { text: string } | undefined;
  return block?.text ?? '';
}

/** A synthetic funders page of `n` entries out of `total`. */
const fundersPage = (n: number, total: number) => ({
  hits: {
    hits: Array.from({ length: n }, (_, i) => ({
      id: `0fund${String(i).padStart(4, '0')}`,
      name: `Funder ${i}`,
    })),
    total,
  },
});

/** A synthetic communities page of `n` entries out of `total`. */
const communitiesPage = (n: number, total: number) => ({
  hits: {
    hits: Array.from({ length: n }, (_, i) => ({
      id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
      slug: `community-${i}`,
      metadata: { title: `Community ${i}` },
    })),
    total,
  },
});

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
      reachable: 1148,
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
      notice: 'Showing 2 of 1,148; call again with page 2.',
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
      reachable: 0,
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
    expect(err.message).toBe(
      'Page 401 at size 25 starts past the first 10,000 entries; the last reachable page at size 25 is 400.',
    );
    expect(fm.calls).toHaveLength(0);
  });

  it('allows the last in-window page', async () => {
    serve('/communities', { hits: { hits: [], total: 1148 } });
    const { result } = await call({ vocabulary: 'communities', page: 400, size: 25 });
    expect(result.page).toBe(400);
  });
});

describe('zenodo_lookup_vocabulary — the 10,000-entry window', () => {
  const FUNDERS_WINDOW =
    'Only the first 10,000 of 129,001 funders are reachable; narrow the list with query.';

  it('funders page 400 at size 25 is the last page: reachable, has_more false, the window notice on both surfaces', async () => {
    serve('/funders', fundersPage(25, 129_001));
    const result = await runToolContract(lookupVocabulary, {
      vocabulary: 'funders',
      page: 400,
      size: 25,
    });
    expect(result.isError).toBeFalsy();
    const notice = `Several funders share names across countries; pick by country and ROR id. ${FUNDERS_WINDOW}`;
    expect(result.structuredContent).toMatchObject({
      total: 129_001,
      reachable: 10_000,
      page: 400,
      size: 25,
      has_more: false,
      truncated: false,
      shown: 25,
      totalCount: 129_001,
      notice,
    });
    expect(result.structuredContent).not.toHaveProperty('next_page');
    const text = result.content.map((b) => (b as { text: string }).text).join('\n');
    expect(text).toContain('**Total:** 129001 (10000 reachable) | **Page:** 400 | **Size:** 25');
    expect(text).toContain(notice);
  });

  it('a page before the window edge counts reachable entries in its guidance', async () => {
    serve('/funders', fundersPage(25, 129_001));
    const { result, enrichment } = await call({ vocabulary: 'funders', page: 399, size: 25 });
    expect(result).toMatchObject({ reachable: 10_000, has_more: true, next_page: 400 });
    expect(enrichment).toEqual({
      truncated: true,
      shown: 25,
      cap: 25,
      totalCount: 129_001,
      notice: `Several funders share names across countries; pick by country and ROR id. ${FUNDERS_WINDOW} Showing 25 of 10,000; call again with page 400.`,
    });
  });

  it('names funder as a way to narrow awards', async () => {
    serve('/awards', { hits: { hits: [{ id: '00k4n6c32::1', number: '1' }], total: 2_000_000 } });
    const { enrichment } = await call({ vocabulary: 'awards' });
    expect(enrichment.notice).toBe(
      'Only the first 10,000 of 2,000,000 awards are reachable; narrow the list with query or funder. Showing 1 of 10,000; call again with page 2.',
    );
  });

  it('communities at size 7: page 1429 straddling entry 10,000 is sent upstream and page 1430 is rejected', async () => {
    // Zenodo serves this page short (4 entries at size 7); shown counts the entries served, not the size.
    serve('/communities', communitiesPage(4, 45_426));
    const { result, enrichment } = await call({ vocabulary: 'communities', page: 1_429, size: 7 });
    expect(queryOf(fm.calls[0]?.request as Request)).toEqual([
      ['page', '1429'],
      ['size', '7'],
    ]);
    expect(result).toMatchObject({ reachable: 10_000, has_more: false });
    expect(result).not.toHaveProperty('next_page');
    expect(enrichment).toMatchObject({
      truncated: false,
      shown: 4,
      notice:
        'Only the first 10,000 of 45,426 communities are reachable; narrow the list with query.',
    });

    const err = await failure({ vocabulary: 'communities', page: 1_430, size: 7 });
    expect(err.data).toMatchObject({ reason: 'result_window_exceeded' });
    expect(err.message).toBe(
      'Page 1430 at size 7 starts past the first 10,000 entries; the last reachable page at size 7 is 1429.',
    );
    expect(fm.calls).toHaveLength(1);
  });

  /** [size, the straddling last page]: sizes that do not divide 10,000. */
  it.each([
    [3, 3_334],
    [7, 1_429],
    [23, 435],
  ])(
    'size %i: the emitted next_page parses back and reaches the last page %i',
    async (size, last) => {
      serve('/communities', communitiesPage(size, 45_426));
      const before = await call({ vocabulary: 'communities', page: last - 1, size });
      expect(before.result).toMatchObject({ has_more: true, next_page: last });

      const next = lookupVocabulary.input.parse({
        vocabulary: 'communities',
        page: before.result.next_page,
        size,
      });
      const { result } = await call(next);
      expect(queryOf(fm.calls[1]?.request as Request)).toContainEqual(['page', String(last)]);
      expect(result).toMatchObject({ page: last, has_more: false });
      expect(result).not.toHaveProperty('next_page');
    },
  );

  it('leaves a total under 10,000 without a window notice', async () => {
    serve('/communities', communitiesPage(2, 1_148));
    const { result, enrichment } = await call({ vocabulary: 'communities', size: 2 });
    expect(result).toMatchObject({ total: 1_148, reachable: 1_148 });
    expect(enrichment.notice).toBe('Showing 2 of 1,148; call again with page 2.');
  });
});

describe('zenodo_lookup_vocabulary — the 25-per-call size cap', () => {
  it('resource_types at size 26: two pages of 25 cover all 43 types with no gap or overlap', async () => {
    const first = await call({ vocabulary: 'resource_types', size: 26 });
    expect(first.result).toMatchObject({
      total: 43,
      reachable: 43,
      page: 1,
      size: 25,
      has_more: true,
      next_page: 2,
    });
    expect(first.result.entries).toHaveLength(25);
    expect(first.enrichment).toEqual({
      truncated: true,
      shown: 25,
      cap: 25,
      totalCount: 43,
      notice: 'Showing 25 of 43 (size 26 is capped at 25 per call); call again with page 2.',
    });

    const next = lookupVocabulary.input.parse({
      vocabulary: 'resource_types',
      size: 26,
      page: first.result.next_page,
    });
    const second = await call(next);
    expect(second.result).toMatchObject({ page: 2, size: 25, has_more: false });
    expect(second.result.entries).toHaveLength(18);
    expect(second.enrichment).not.toHaveProperty('notice');

    const ids = [...first.result.entries, ...second.result.entries].map((e) => e.filter_value);
    const all = (await call({ vocabulary: 'resource_types', size: 25 })).result.entries;
    expect(new Set(ids).size).toBe(43);
    expect(ids.slice(0, 25)).toEqual(all.map((e) => e.filter_value));
    expect(fm.calls).toHaveLength(0);
  });

  it('sends a remote vocabulary page at 25 and reports the applied size', async () => {
    serve('/communities', communitiesPage(25, 1_148));
    const { result, enrichment } = await call({ vocabulary: 'communities', size: 26 });
    expect(queryOf(fm.calls[0]?.request as Request)).toEqual([
      ['page', '1'],
      ['size', '25'],
    ]);
    expect(result).toMatchObject({ size: 25, has_more: true, next_page: 2 });
    expect(enrichment).toMatchObject({
      cap: 25,
      notice: 'Showing 25 of 1,148 (size 26 is capped at 25 per call); call again with page 2.',
    });
  });

  it('names no cap when every entry fit', async () => {
    serve('/vocabularies/licenses', fixture('licenses-q-mit.json'));
    const result = await runToolContract(lookupVocabulary, {
      vocabulary: 'licenses',
      query: 'mit',
      size: 10_000,
    });
    expect(queryOf(fm.calls[0]?.request as Request)).toContainEqual(['size', '25']);
    expect(result.structuredContent).toMatchObject({ size: 25, cap: 25, has_more: false });
    expect(result.structuredContent).not.toHaveProperty('notice');
  });

  it('rejects a page past the window at the capped size, naming the cap', async () => {
    const err = await failure({ vocabulary: 'communities', page: 401, size: 100 });
    expect(err.data).toMatchObject({ reason: 'result_window_exceeded' });
    expect(err.message).toBe(
      'Page 401 at size 25 starts past the first 10,000 entries (size 100 is capped at 25 per call); the last reachable page at size 25 is 400.',
    );
    expect(fm.calls).toHaveLength(0);
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

  it('rejects size past the 10,000 ceiling or below 1, and an unknown vocabulary, at the schema', async () => {
    for (const size of [10_001, 0]) {
      const bad = await runToolContract(lookupVocabulary, { vocabulary: 'licenses', size });
      expect(bad.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams },
      });
    }
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
      '**Total:** 2 (2 reachable) | **Page:** 1 | **Size:** 1 | **Has more:** true | **Next page:** 2',
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
      reachable: 1,
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
