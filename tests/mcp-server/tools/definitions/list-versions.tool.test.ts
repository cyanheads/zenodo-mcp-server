/**
 * @fileoverview Tests for zenodo_list_versions through the real service and a
 * strict fetch fake: version, concept, and external-DOI resolution, a page past
 * the end, every found: false miss (deleted with tombstone, not found, restricted,
 * DOI not on Zenodo), the latest_recid preference order, upstream failures with
 * their recovery hints, the production `output.extend(enrichment)` parse via
 * runToolContract, and format() rendering.
 * @module tests/mcp-server/tools/definitions/list-versions.tool.test
 */

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
import { listVersions } from '@/mcp-server/tools/definitions/list-versions.tool.js';
import type { RawRecord } from '@/services/zenodo/types.js';
import { disposeZenodoService, initZenodoService } from '@/services/zenodo/zenodo-service.js';
import {
  fixture,
  hangUntilAborted,
  hitsBody,
  jsonResponse,
  onPath,
  queryOf,
  RDM,
  rateHeaders,
  recordFixture,
  respondAfter,
  settle,
  textResponse,
} from '../../../helpers/zenodo-fixtures.js';

const NOW = new Date('2026-09-23T12:00:00Z');

const recovery = (reason: string) =>
  listVersions.errors?.find((e) => e.reason === reason)?.recovery as string;

/** Trimmed live page: `/records/22705923/versions?page=1&size=3&sort=version` (47 versions). */
const pageOne = () =>
  fixture<{ hits: { hits: RawRecord[]; total: number } }>('versions-22705923-p1s3.json');

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

const paths = () => fm.calls.map((c) => new URL(c.request.url).pathname);

function serveVersions(recid: string, body: unknown | (() => unknown), status = 200) {
  fm.route({
    match: onPath(`/records/${recid}/versions`, RDM),
    respond: () =>
      jsonResponse(typeof body === 'function' ? (body as () => unknown)() : body, { status }),
  });
}

function serveRecord(recid: string, body: unknown | (() => unknown), status = 200) {
  fm.route({
    match: onPath(`/records/${recid}`, RDM),
    respond: () =>
      jsonResponse(typeof body === 'function' ? (body as () => unknown)() : body, { status }),
  });
}

function serveLatest(recid: string, location: string | null) {
  fm.route({
    match: onPath(`/records/${recid}/versions/latest`),
    respond: () =>
      location === null
        ? jsonResponse({ status: 404 }, { status: 404 })
        : textResponse(null, 301, { location }),
  });
}

function serveDoiSearch(body: unknown) {
  fm.route({ match: onPath('/records'), respond: () => jsonResponse(body, { bucket: 'search' }) });
}

async function call(input: Record<string, unknown>) {
  const ctx = createMockContext({ errors: listVersions.errors });
  const result = await listVersions.handler(listVersions.input.parse(input), ctx);
  return { result, ctx, enrichment: getEnrichment(ctx) };
}

async function failure(input: Record<string, unknown>, advanceMs = 0): Promise<McpError> {
  const ctx = createMockContext({ errors: listVersions.errors });
  const pending = settle(listVersions.handler(listVersions.input.parse(input), ctx));
  if (advanceMs) await vi.advanceTimersByTimeAsync(advanceMs);
  const outcome = await pending;
  if (outcome.ok) throw new Error('expected the handler to throw');
  expect(outcome.error).toBeInstanceOf(McpError);
  return outcome.error as McpError;
}

function expectReason(err: McpError, reason: string, code: JsonRpcErrorCode) {
  expect(err.code).toBe(code);
  expect(err.data).toMatchObject({ reason, recovery: { hint: recovery(reason) } });
}

function textOf(result: Awaited<ReturnType<typeof call>>['result']): string {
  const block = listVersions.format?.(result)[0] as { text: string } | undefined;
  return block?.text ?? '';
}

/** Page-one hits with `is_latest` rewritten per index (`undefined` drops the versions block). */
function pageWithLatest(flags: (boolean | undefined)[], total = 47) {
  const hits = pageOne().hits.hits.map((h, i) => {
    const flag = flags[i];
    const { versions: _drop, ...rest } = h;
    return flag === undefined ? rest : { ...rest, versions: { ...h.versions, is_latest: flag } };
  });
  return hitsBody(hits as RawRecord[], total);
}

describe('zenodo_list_versions — series listed', () => {
  it.each([
    ['22705923', 'record_id'],
    ['10.5281/zenodo.22705923', 'zenodo_doi'],
    ['https://zenodo.org/records/22705923', 'url'],
  ])('lists the series of version id %s in one call (input kind %s)', async (id, inputKind) => {
    serveVersions('22705923', pageOne);
    const { result, enrichment } = await call({ id, size: 3 });
    expect(paths()).toEqual(['/api/records/22705923/versions']);
    expect(queryOf(fm.calls[0]?.request as Request)).toEqual([
      ['page', '1'],
      ['size', '3'],
      ['sort', 'version'],
    ]);
    expect(result).toMatchObject({
      found: true,
      input_kind: inputKind,
      concept_recid: '591564',
      concept_doi: '10.5281/zenodo.591564',
      total_versions: 47,
      latest_recid: '22705923',
      page: 1,
      size: 3,
      has_more: true,
      next_page: 2,
    });
    expect(result.versions.map((v) => v.recid)).toEqual(['22705923', '20510517', '17880109']);
    expect(result.versions[1]).toEqual({
      recid: '20510517',
      doi: '10.5281/zenodo.20510517',
      version: '1.9.0',
      title: 'scikit-learn',
      publication_date: '2026-06-02',
      index: 46,
      is_latest: false,
      file_count: 1,
      total_bytes: 8_635_739,
      views: 1_123,
      downloads: 127,
    });
    expect(result).not.toHaveProperty('miss_kind');
    expect(result).toEqual(expect.schemaMatching(listVersions.output));
    expect(enrichment).toEqual({
      truncated: true,
      shown: 3,
      cap: 3,
      totalCount: 47,
      notice: 'Showing 3 of 47 versions; call again with page 2.',
    });
  });

  it('resolves a concept id through the record GET when /versions 404s', async () => {
    serveVersions('591564', { status: 404 }, 404);
    serveRecord('591564', recordFixture);
    serveVersions('22705923', pageOne);
    const { result } = await call({ id: '10.5281/zenodo.591564', size: 3 });
    expect(paths()).toEqual([
      '/api/records/591564/versions',
      '/api/records/591564',
      '/api/records/22705923/versions',
    ]);
    expect(result).toMatchObject({
      found: true,
      input_kind: 'zenodo_doi',
      concept_recid: '591564',
      total_versions: 47,
      latest_recid: '22705923',
    });
  });

  it('resolves an external DOI through search, then lists a single-version series', async () => {
    const body = fixture<{ hits: { hits: RawRecord[] } }>('search-doi-10.3897-ap.e134190.json');
    serveDoiSearch(body);
    serveVersions('15308258', () => hitsBody(body.hits.hits, 1));
    const { result, enrichment } = await call({ id: '10.3897/ap.e134190' });
    expect(paths()).toEqual(['/api/records', '/api/records/15308258/versions']);
    expect(queryOf(fm.calls[0]?.request as Request)).toContainEqual(['all_versions', 'true']);
    expect(result).toMatchObject({
      found: true,
      input_kind: 'external_doi',
      concept_recid: '15308257',
      total_versions: 1,
      latest_recid: '15308258',
      has_more: false,
    });
    expect(result).not.toHaveProperty('concept_doi');
    expect(result).not.toHaveProperty('next_page');
    expect(result.versions[0]).toMatchObject({ recid: '15308258', doi: '10.3897/ap.e134190' });
    expect(enrichment).toEqual({ truncated: false, shown: 1, cap: 25, totalCount: 1 });
  });

  it('reports a page past the end, naming the latest version from /versions/latest', async () => {
    serveVersions('22705923', fixture('versions-22705923-p3s25-past-end.json'));
    serveLatest('22705923', 'https://zenodo.org/api/records/22705923');
    const { result, enrichment } = await call({ id: '22705923', page: 3 });
    expect(paths()).toEqual([
      '/api/records/22705923/versions',
      '/api/records/22705923/versions/latest',
    ]);
    expect(result).toEqual({
      found: true,
      input_kind: 'record_id',
      total_versions: 47,
      latest_recid: '22705923',
      page: 3,
      size: 25,
      has_more: false,
      versions: [],
    });
    expect(enrichment).toEqual({
      truncated: false,
      shown: 0,
      cap: 25,
      totalCount: 47,
      notice: 'Page 3 is past the last page (2).',
    });
  });

  it('keeps absent version fields absent (no version label, no usage counts, restricted files)', async () => {
    const sparse = fixture<RawRecord>('record-22931068-restricted.json');
    delete sparse.stats;
    serveVersions('22931068', () => hitsBody([sparse], 1));
    const { result } = await call({ id: '22931068' });
    expect(result.versions[0]).toEqual({
      recid: '22931068',
      doi: '10.5281/zenodo.22931068',
      title: 'Estructura de los números primos y su conexión exacta con los ceros de Riemann',
      publication_date: '2026-09-24',
      index: 28,
      is_latest: false,
    });
    expect(textOf(result)).toContain(
      '**Files:** not disclosed (not disclosed bytes) | **Views:** not available | **Downloads:** not available',
    );
  });
});

describe('zenodo_list_versions — latest_recid preference order', () => {
  it('prefers the hit flagged is_latest over the first hit on page 1', async () => {
    serveVersions('22705923', () => pageWithLatest([false, true, false]));
    const { result } = await call({ id: '22705923', size: 3 });
    expect(result.latest_recid).toBe('20510517');
    expect(fm.calls).toHaveLength(1);
  });

  it('falls back to page 1’s first hit when no hit carries is_latest', async () => {
    serveVersions('22705923', () => pageWithLatest([undefined, undefined, undefined]));
    const { result } = await call({ id: '22705923', size: 3 });
    expect(result.latest_recid).toBe('22705923');
    expect(fm.calls).toHaveLength(1);
  });

  it('uses a flagged hit on a later page without calling /versions/latest', async () => {
    serveVersions('20510517', () => pageWithLatest([true, false, false]));
    const { result } = await call({ id: '20510517', page: 2, size: 3 });
    expect(result.latest_recid).toBe('22705923');
    expect(fm.calls).toHaveLength(1);
  });

  it('asks /versions/latest on a later page with no latest hit', async () => {
    serveVersions('17880109', () => pageWithLatest([false, false, false]));
    serveLatest('17880109', '/api/records/22705923');
    const { result } = await call({ id: '17880109', page: 2, size: 3 });
    expect(result.latest_recid).toBe('22705923');
    expect(paths()).toEqual([
      '/api/records/17880109/versions',
      '/api/records/17880109/versions/latest',
    ]);
  });

  it('omits latest_recid only when /versions/latest names no record', async () => {
    serveVersions('17880109', fixture('versions-22705923-p3s25-past-end.json'));
    serveLatest('17880109', null);
    const { result } = await call({ id: '17880109', page: 3 });
    expect(result).toMatchObject({ found: true, total_versions: 47 });
    expect(result).not.toHaveProperty('latest_recid');
  });
});

describe('zenodo_list_versions — misses (found: false)', () => {
  it('deleted: a 200 with zero hits falls through to the record GET, which answers 410', async () => {
    serveVersions('22705918', { hits: { hits: [], total: 0 } });
    serveRecord('22705918', fixture('tombstone-22705918.json'), 410);
    const { result, enrichment } = await call({ id: '22705918' });
    expect(paths()).toEqual(['/api/records/22705918/versions', '/api/records/22705918']);
    expect(result).toEqual({
      found: false,
      input_kind: 'record_id',
      miss_kind: 'deleted',
      guidance:
        'Record 22705918 was removed from Zenodo on 2026-09-11 (reason: spam); only its tombstone citation remains. Find a replacement or another version by title with zenodo_search_records.',
      tombstone: {
        removal_date: '2026-09-11T10:30:41.939980+00:00',
        removal_reason: 'spam',
        note: 'User was blocked',
        citation_text:
          'Doe, J. (2026). A removed spam deposit. Zenodo. https://doi.org/10.5281/zenodo.22705918',
      },
      page: 1,
      size: 25,
      has_more: false,
      versions: [],
    });
    expect(enrichment).toEqual({ truncated: false, shown: 0, cap: 25, totalCount: 0 });
  });

  it('not_found: /versions and the record GET both 404', async () => {
    serveVersions('999999999999', { status: 404 }, 404);
    serveRecord('999999999999', fixture('error-404-pid.json'), 404);
    const { result } = await call({ id: '999999999999' });
    expect(result).toMatchObject({
      found: false,
      miss_kind: 'not_found',
      guidance:
        'No Zenodo record has id 999999999999; it may never have existed. Search by title with zenodo_search_records, or by query doi:"10.5281/zenodo.999999999999" with all_versions true.',
      versions: [],
    });
    expect(result).not.toHaveProperty('total_versions');
    expect(result).not.toHaveProperty('latest_recid');
  });

  it.each([404, 403])(
    'restricted: /versions answers %i and the record GET answers 403',
    async (versionsStatus) => {
      serveVersions('5', { status: versionsStatus }, versionsStatus);
      serveRecord('5', { status: 403, message: 'Permission denied.' }, 403);
      const { result } = await call({ id: 'https://zenodo.org/records/5' });
      expect(result).toMatchObject({
        found: false,
        input_kind: 'url',
        miss_kind: 'restricted',
        guidance:
          'Record 5 exists but its metadata is restricted to authorized users and cannot be read anonymously.',
      });
    },
  );

  it('not_on_zenodo: an external DOI misses as given and with trailing punctuation stripped', async () => {
    serveDoiSearch({ hits: { hits: [], total: 0 } });
    const { result, enrichment } = await call({ id: '10.1038/nature12373.' });
    expect(fm.calls).toHaveLength(2);
    expect(result).toEqual({
      found: false,
      input_kind: 'external_doi',
      miss_kind: 'not_on_zenodo',
      guidance:
        'DOI 10.1038/nature12373 is not registered to a Zenodo record. It resolves elsewhere at https://doi.org/10.1038/nature12373; to find a related deposit, search by title with zenodo_search_records.',
      page: 1,
      size: 25,
      has_more: false,
      versions: [],
    });
    expect(enrichment).toEqual({ truncated: false, shown: 0, cap: 25, totalCount: 0 });
  });
});

describe('zenodo_list_versions — error contract', () => {
  it.each([
    'https://zenodo.org/badge/latestdoi/12345678',
    'https://sandbox.zenodo.org/records/1',
    'scikit-learn',
  ])('invalid_identifier for %j, before any upstream call', async (id) => {
    const err = await failure({ id });
    expectReason(err, 'invalid_identifier', JsonRpcErrorCode.ValidationError);
    expect(fm.calls).toHaveLength(0);
  });

  it.each([
    { page: 401, size: 25 },
    { page: 10_001, size: 1 },
  ])('result_window_exceeded for %j, before any upstream call', async (paging) => {
    const err = await failure({ id: '591564', ...paging });
    expectReason(err, 'result_window_exceeded', JsonRpcErrorCode.ValidationError);
    expect(err.message).toBe(
      `page ${paging.page} × size ${paging.size} is past the first 10,000 versions Zenodo pages through.`,
    );
    expect(fm.calls).toHaveLength(0);
  });

  it('sends page × size exactly at the 10,000 window upstream', async () => {
    serveVersions('22705923', hitsBody([], 47));
    serveLatest('22705923', 'https://zenodo.org/api/records/22705923');
    const { result, enrichment } = await call({ id: '22705923', page: 400, size: 25 });
    expect(queryOf(fm.calls[0]?.request as Request)).toContainEqual(['page', '400']);
    expect(result).toMatchObject({ found: true, total_versions: 47, versions: [] });
    expect(enrichment.notice).toBe('Page 400 is past the last page (2).');
  });

  it('record_unavailable after a /versions 500 and its one retry', async () => {
    serveVersions('1004', { status: 500 }, 500);
    const err = await failure({ id: '1004' }, 5_000);
    expectReason(err, 'record_unavailable', JsonRpcErrorCode.ServiceUnavailable);
    expect(paths()).toEqual(['/api/records/1004/versions', '/api/records/1004/versions']);
  });

  it('record_unavailable when the record GET that classifies an empty series answers 500 twice', async () => {
    serveVersions('1008', { hits: { hits: [], total: 0 } });
    serveRecord('1008', { status: 500 }, 500);
    const err = await failure({ id: '1008' }, 5_000);
    expectReason(err, 'record_unavailable', JsonRpcErrorCode.ServiceUnavailable);
    expect(fm.calls).toHaveLength(3);
  });

  it('upstream_timeout when the /versions page never completes, without a retry', async () => {
    fm.route({ match: onPath('/records/7793716/versions'), respond: hangUntilAborted });
    const err = await failure({ id: '7793716' }, 50_000);
    expectReason(err, 'upstream_timeout', JsonRpcErrorCode.Timeout);
    expect(err.data).toMatchObject({ retryable: false });
    expect(fm.calls).toHaveLength(1);
  });

  it('upstream_timeout on a slow gateway 504, without a retry', async () => {
    fm.route({
      match: onPath('/records/7793716/versions'),
      respond: respondAfter(30_500, () => textResponse('<html>504 Gateway Time-out</html>', 504)),
    });
    const err = await failure({ id: '7793716' }, 31_000);
    expectReason(err, 'upstream_timeout', JsonRpcErrorCode.Timeout);
    expect(fm.calls).toHaveLength(1);
  });

  it('rate_limited on a 429, naming zenodo_list_versions in the recovery hint', async () => {
    fm.route({
      match: onPath('/records/22705923/versions'),
      respond: () => textResponse('{}', 429, rateHeaders('general', 0, 60)),
    });
    const err = await failure({ id: '22705923' });
    expectReason(err, 'rate_limited', JsonRpcErrorCode.RateLimited);
    expect(err.data).toMatchObject({ retryAfter: 60 });
    expect(recovery('rate_limited')).toContain('zenodo_list_versions');
  });
});

describe('zenodo_list_versions — runToolContract (production output + enrichment parse)', () => {
  it('passes the enrichment parse on a miss page', async () => {
    serveVersions('999999999999', { status: 404 }, 404);
    serveRecord('999999999999', fixture('error-404-pid.json'), 404);
    const result = await runToolContract(listVersions, { id: '999999999999' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      found: false,
      miss_kind: 'not_found',
      truncated: false,
      shown: 0,
      cap: 25,
      totalCount: 0,
    });
  });

  it('passes the enrichment parse on a deleted page', async () => {
    serveVersions('22705918', { hits: { hits: [], total: 0 } });
    serveRecord('22705918', fixture('tombstone-22705918.json'), 410);
    const result = await runToolContract(listVersions, { id: '22705918' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ miss_kind: 'deleted', truncated: false });
  });

  it('passes the enrichment parse on a page past the end', async () => {
    serveVersions('22705923', fixture('versions-22705923-p3s25-past-end.json'));
    serveLatest('22705923', 'https://zenodo.org/api/records/22705923');
    const result = await runToolContract(listVersions, { id: '22705923', page: 3 });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      versions: [],
      totalCount: 47,
      notice: 'Page 3 is past the last page (2).',
    });
  });

  it('passes the enrichment parse on an under-cap page', async () => {
    serveVersions('22705923', () => hitsBody(pageOne().hits.hits, 3));
    const result = await runToolContract(listVersions, { id: '22705923' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      found: true,
      total_versions: 3,
      has_more: false,
      truncated: false,
      shown: 3,
      cap: 25,
      totalCount: 3,
    });
    expect(result.structuredContent).not.toHaveProperty('notice');
  });

  it('passes the enrichment parse on a truncated page', async () => {
    serveVersions('22705923', pageOne);
    const result = await runToolContract(listVersions, { id: '22705923', size: 3 });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      has_more: true,
      next_page: 2,
      truncated: true,
      shown: 3,
      notice: 'Showing 3 of 47 versions; call again with page 2.',
    });
  });

  it('renders upstream_timeout as an error envelope carrying the recovery hint', async () => {
    fm.route({ match: onPath('/records/7793716/versions'), respond: hangUntilAborted });
    const pending = runToolContract(listVersions, { id: '7793716' });
    await vi.advanceTimersByTimeAsync(50_000);
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.Timeout, data: { reason: 'upstream_timeout' } },
    });
    expect((result.content[0] as { text: string }).text).toContain(recovery('upstream_timeout'));
  });

  it('rejects a size above 25 at the schema', async () => {
    const result = await runToolContract(listVersions, { id: '22705923', size: 26 });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
    expect(fm.calls).toHaveLength(0);
  });
});

describe('zenodo_list_versions — format()', () => {
  it('renders the series facts and each version', async () => {
    serveVersions('22705923', pageOne);
    const text = textOf((await call({ id: '22705923', size: 3 })).result);
    for (const needle of [
      '**Found:** true | **Input kind:** record_id',
      '**Concept record:** 591564 | **Concept DOI:** 10.5281/zenodo.591564 | **Versions:** 47 | **Latest record:** 22705923',
      '**Page:** 1 | **Size:** 3 | **Has more:** true | **Next page:** 2',
      '### 1.9.1 — record 22705923 (latest)',
      '**Title:** scikit-learn',
      '**DOI:** 10.5281/zenodo.22705923 | **Published:** 2026-09-11 | **Index:** 47 | **Latest:** true',
      '**Files:** 1 (8684206 bytes) | **Views:** 64 | **Downloads:** 6',
      '### 1.9.0 — record 20510517',
    ]) {
      expect(text).toContain(needle);
    }
  });

  it('renders the tombstone of a deleted record as quoted, untrusted text', async () => {
    serveVersions('22705918', { hits: { hits: [], total: 0 } });
    serveRecord('22705918', fixture('tombstone-22705918.json'), 410);
    const text = textOf((await call({ id: '22705918' })).result);
    expect(text).toContain('**Found:** false | **Input kind:** record_id');
    expect(text).toContain('**Miss kind:** deleted');
    expect(text).toContain('**Tombstone:** removed 2026-09-11T10:30:41.939980+00:00; reason: spam');
    expect(text).toContain('Removal note (untrusted):\n> User was blocked');
    expect(text).toContain('Tombstone citation (untrusted):\n> Doe, J. (2026).');
  });

  it('keeps depositor-supplied version labels and titles inside their slot', async () => {
    const hit = recordFixture();
    hit.metadata = { ...hit.metadata, version: 'v2\n## injected', title: 'T\r\n# SYSTEM' };
    serveVersions('22705923', () => hitsBody([hit], 1));
    const text = textOf((await call({ id: '22705923' })).result);
    const lines = text.split('\n');
    expect(lines.some((l) => l.startsWith('## ') || l.startsWith('# '))).toBe(false);
    expect(text).toContain('### v2 ## injected — record 22705923 (latest)');
    expect(text).toContain('**Title:** T # SYSTEM');
  });
});
