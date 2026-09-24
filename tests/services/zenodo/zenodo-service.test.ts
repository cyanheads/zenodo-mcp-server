/**
 * @fileoverview Tests for ZenodoService against a strict fetch fake and fixtures
 * trimmed from live zenodo.org responses: record normalization and the miss
 * outcomes (403/404/410), concept → latest caching, DOI resolution, versions,
 * citations on the resolved recid, content and container reads, vocabulary lookups,
 * and search composition with only allowlisted parameters.
 * @module tests/services/zenodo/zenodo-service.test
 */

import {
  createFetchMock,
  createMockContext,
  type FetchMockHarness,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawRecord } from '@/services/zenodo/types.js';
import { ZenodoService } from '@/services/zenodo/zenodo-service.js';
import {
  fixture,
  fixtureText,
  jsonResponse,
  onPath,
  queryOf,
  RDM,
  recordFixture,
  textResponse,
} from '../../helpers/zenodo-fixtures.js';

const NOW = new Date('2026-09-23T12:00:00Z');
const SEARCH_ALLOWLIST = new Set(['q', 'communities', 'all_versions', 'sort', 'page', 'size']);

let fm: FetchMockHarness;
let service: ZenodoService;
const ctx = () => createMockContext();

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  fm = createFetchMock();
  fm.install();
  service = new ZenodoService({ userAgent: 'zenodo-mcp-server/test' });
});

afterEach(() => {
  service.dispose();
  fm.restore();
  vi.useRealTimers();
});

const paths = () => fm.calls.map((c) => new URL(c.request.url).pathname);

describe('getRecord', () => {
  it('normalizes record 22705923 in full', async () => {
    fm.route({
      match: onPath('/records/22705923', RDM),
      respond: () => jsonResponse(recordFixture()),
    });
    const lookup = await service.getRecord('22705923', ctx());
    expect(lookup).toEqual({
      status: 'found',
      record: {
        recid: '22705923',
        concept_recid: '591564',
        doi: '10.5281/zenodo.22705923',
        doi_provider: 'datacite',
        concept_doi: '10.5281/zenodo.591564',
        oai_id: 'oai:zenodo.org:22705923',
        title: 'scikit-learn',
        publication_date: '2026-09-11',
        version: '1.9.1',
        publisher: 'Zenodo',
        resource_type: { id: 'software', title: 'Software' },
        description: expect.stringMatching(/^We're happy to announce the 1\.9\.1 release\./),
        additional_descriptions: [
          {
            type: 'Notes',
            text: 'If you use scikit-learn in a scientific publication, we would appreciate citations to the following paper:',
          },
        ],
        creators: [{ name: 'The scikit-learn developers', type: 'personal', affiliations: [] }],
        contributors: [],
        keywords: [],
        rights: [
          {
            id: 'bsd-3-clause',
            title: 'BSD 3-Clause "New" or "Revised" License',
            url: 'https://opensource.org/licenses/BSD-3-Clause',
          },
        ],
        access: { status: 'open', record: 'public', files: 'public', embargo_active: false },
        funding: [],
        related_identifiers: [
          {
            identifier: 'https://github.com/scikit-learn/scikit-learn/tree/1.9.1',
            scheme: 'url',
            relation: 'issupplementto',
            resource_type: 'software',
          },
        ],
        code_repository: 'https://github.com/scikit-learn/scikit-learn',
        communities: [],
        versions: { index: 47, is_latest: true },
        stats: {
          this_version: { views: 64, downloads: 6 },
          all_versions: { views: 22820, downloads: 2768 },
        },
        files: {
          enabled: true,
          count: 1,
          total_bytes: 8684206,
          entries: [
            {
              key: 'scikit-learn/scikit-learn-1.9.1.zip',
              size: 8684206,
              mimetype: 'application/zip',
              md5: '63498a22114ec6465a79e4d00774cc00',
              download_url:
                'https://zenodo.org/api/records/22705923/files/scikit-learn/scikit-learn-1.9.1.zip/content',
            },
          ],
        },
        revision: 4,
      },
    });
  });

  it('serves a repeat lookup from cache', async () => {
    fm.route({ match: onPath('/records/22705923'), respond: () => jsonResponse(recordFixture()) });
    await service.getRecord('22705923', ctx());
    await service.getRecord('22705923', ctx());
    expect(fm.calls).toHaveLength(1);
  });

  it('refetches after the 5-minute record TTL', async () => {
    fm.route({ match: onPath('/records/22705923'), respond: () => jsonResponse(recordFixture()) });
    await service.getRecord('22705923', ctx());
    vi.advanceTimersByTime(5 * 60_000);
    await service.getRecord('22705923', ctx());
    expect(fm.calls).toHaveLength(2);
  });

  it('caches a concept id against the latest version it resolved to', async () => {
    // The fake returns the body the followed 302 would: the latest version.
    fm.route({ match: onPath('/records/591564'), respond: () => jsonResponse(recordFixture()) });
    const first = await service.getRecord('591564', ctx());
    const second = await service.getRecord('591564', ctx());
    const direct = await service.getRecord('22705923', ctx());
    expect(first.status === 'found' && first.record.recid).toBe('22705923');
    expect(second).toEqual(first);
    expect(direct).toEqual(first);
    expect(paths()).toEqual(['/api/records/591564']);
  });

  it('keeps absent upstream fields absent (no DOI, no concept DOI) on record 1241', async () => {
    fm.route({
      match: onPath('/records/1241'),
      respond: () => jsonResponse(fixture('record-1241-no-doi.json')),
    });
    const lookup = await service.getRecord('1241', ctx());
    if (lookup.status !== 'found') throw new Error('expected found');
    const r = lookup.record;
    expect(r).not.toHaveProperty('doi');
    expect(r).not.toHaveProperty('concept_doi');
    expect(r).not.toHaveProperty('code_repository');
    expect(r.oai_id).toBe('oai:openaire.cern.ch:1241');
    expect(r.communities).toEqual([{ slug: 'eu', title: 'EU Open Research Repository' }]);
    expect(r.creators[0]).toEqual({
      name: 'Dabrowski, Marek',
      type: 'personal',
      affiliations: [{ name: 'CASE - CENTRUM ANALIZ SPOLECZNO- EKONOMICZNYCH- FUNDACJA NAUKOWA' }],
    });
    expect(r.funding).toEqual([
      {
        funder_id: '00k4n6c32',
        funder_name: 'European Commission',
        award_id: '00k4n6c32::244578',
        award_number: '244578',
        award_acronym: 'MEDPRO',
        award_title: 'Prospective Analysis for the Mediterranean Region',
        award_program: 'FP7-SSH',
        award_url: 'https://cordis.europa.eu/projects/244578',
      },
    ]);
  });

  it('normalizes an embargoed record: embargo date and reason, no file totals', async () => {
    fm.route({
      match: onPath('/records/22837418'),
      respond: () => jsonResponse(fixture('record-22837418-embargoed.json')),
    });
    const lookup = await service.getRecord('22837418', ctx());
    if (lookup.status !== 'found') throw new Error('expected found');
    expect(lookup.record.access).toMatchObject({
      status: 'embargoed',
      files: 'restricted',
      embargo_active: true,
      embargo_until: '2035-08-31',
      embargo_reason: expect.stringMatching(/^Design documents sealed/),
    });
    expect(lookup.record.files).toEqual({ enabled: true, entries: [] });
  });

  it('keeps a metadata-only record’s zero counts as zero, not absent', async () => {
    fm.route({
      match: onPath('/records/7126368'),
      respond: () => jsonResponse(fixture('record-7126368-metadata-only.json')),
    });
    const lookup = await service.getRecord('7126368', ctx());
    if (lookup.status !== 'found') throw new Error('expected found');
    expect(lookup.record.access.status).toBe('metadata-only');
    expect(lookup.record.files).toEqual({ enabled: false, count: 0, total_bytes: 0, entries: [] });
  });

  it('orders the manifest by files.order when upstream sets it', async () => {
    const raw = recordFixture();
    raw.files = {
      enabled: true,
      count: 2,
      order: ['b.txt', 'a.txt'],
      entries: {
        'a.txt': { key: 'a.txt', size: 1, checksum: 'md5:aa' },
        'b.txt': { key: 'b.txt', size: 2, checksum: 'sha256:bb' },
      },
    };
    fm.route({ match: onPath('/records/22705923'), respond: () => jsonResponse(raw) });
    const lookup = await service.getRecord('22705923', ctx());
    if (lookup.status !== 'found') throw new Error('expected found');
    expect(lookup.record.files.entries.map((e) => [e.key, e.md5])).toEqual([
      ['b.txt', undefined],
      ['a.txt', 'aa'],
    ]);
  });

  it('returns not_found on a 404 and restricted on a 403', async () => {
    fm.route(
      {
        match: onPath('/records/999999999999'),
        respond: () => jsonResponse(fixture('error-404-pid.json'), { status: 404 }),
      },
      {
        match: onPath('/records/5'),
        respond: () =>
          jsonResponse({ status: 403, message: 'Permission denied.' }, { status: 403 }),
      },
    );
    expect(await service.getRecord('999999999999', ctx())).toEqual({ status: 'not_found' });
    expect(await service.getRecord('5', ctx())).toEqual({ status: 'restricted' });
  });

  it('returns the tombstone of a deleted record (410)', async () => {
    fm.route(
      {
        match: onPath('/records/22705918'),
        respond: () => jsonResponse(fixture('tombstone-22705918.json'), { status: 410 }),
      },
      {
        match: onPath('/records/22705920'),
        respond: () => jsonResponse(fixture('tombstone-22705920.json'), { status: 410 }),
      },
    );
    expect(await service.getRecord('22705918', ctx())).toEqual({
      status: 'deleted',
      tombstone: {
        removal_date: '2026-09-11T10:30:41.939980+00:00',
        removal_reason: 'spam',
        note: 'User was blocked',
        citation_text:
          'Doe, J. (2026). A removed spam deposit. Zenodo. https://doi.org/10.5281/zenodo.22705918',
      },
    });
    const retracted = await service.getRecord('22705920', ctx());
    expect(retracted.status === 'deleted' && retracted.tombstone).not.toHaveProperty('note');
    expect(retracted.status === 'deleted' && retracted.tombstone.removal_reason).toBe('retracted');
  });

  it('returns an empty tombstone when a 410 body is unreadable', async () => {
    fm.route({ match: onPath('/records/7'), respond: () => textResponse('gone', 410) });
    expect(await service.getRecord('7', ctx())).toEqual({ status: 'deleted', tombstone: {} });
  });

  it('does not cache a miss', async () => {
    fm.route({ match: onPath('/records/8'), respond: () => jsonResponse({}, { status: 404 }) });
    await service.getRecord('8', ctx());
    await service.getRecord('8', ctx());
    expect(fm.calls).toHaveLength(2);
  });
});

describe('resolveDoi', () => {
  const searchFixture = () =>
    fixture<{ hits: { hits: RawRecord[]; total: number } }>('search-doi-10.3897-ap.e134190.json');

  it('searches with all_versions=true and a quoted doi: clause in the search bucket', async () => {
    fm.route({
      match: onPath('/records'),
      respond: () => jsonResponse(searchFixture(), { bucket: 'search' }),
    });
    const resolution = await service.resolveDoi('10.3897/ap.e134190', undefined, ctx());
    expect(queryOf(fm.calls[0]?.request as Request)).toEqual([
      ['q', 'doi:"10.3897/ap.e134190"'],
      ['all_versions', 'true'],
      ['size', '2'],
    ]);
    expect(fm.calls[0]?.request.headers.get('accept')).toBe(RDM);
    expect(resolution.status).toBe('found');
    if (resolution.status !== 'found') return;
    expect(resolution.record).toMatchObject({
      recid: '15308258',
      doi: '10.3897/ap.e134190',
      doi_provider: 'external',
      concept_recid: '15308257',
    });
    expect(resolution.record).not.toHaveProperty('concept_doi');
  });

  it('prefers the hit whose DOI equals the input, case-insensitively', async () => {
    const body = searchFixture();
    const match = body.hits.hits[0] as RawRecord;
    const decoy: RawRecord = { ...match, id: '1', pids: { doi: { identifier: '10.3897/other' } } };
    body.hits.hits = [decoy, match];
    fm.route({
      match: onPath('/records'),
      respond: () => jsonResponse(body, { bucket: 'search' }),
    });
    const resolution = await service.resolveDoi('10.3897/AP.E134190', undefined, ctx());
    expect(resolution.status === 'found' && resolution.record.recid).toBe('15308258');
  });

  it('retries the stripped form only after the as-given form misses', async () => {
    fm.route(
      {
        match: (r) => onPath('/records')(r) && queryOf(r)[0]?.[1] === 'doi:"10.3897/ap.e134190."',
        respond: () => jsonResponse({ hits: { hits: [], total: 0 } }, { bucket: 'search' }),
      },
      {
        match: onPath('/records'),
        respond: () => jsonResponse(searchFixture(), { bucket: 'search' }),
      },
    );
    const resolution = await service.resolveDoi('10.3897/ap.e134190.', '10.3897/ap.e134190', ctx());
    expect(resolution.status).toBe('found');
    expect(fm.calls.map((c) => queryOf(c.request)[0]?.[1])).toEqual([
      'doi:"10.3897/ap.e134190."',
      'doi:"10.3897/ap.e134190"',
    ]);
  });

  it('reports not_on_zenodo when every form misses', async () => {
    fm.route({
      match: onPath('/records'),
      respond: () => jsonResponse({ hits: { hits: [], total: 0 } }, { bucket: 'search' }),
    });
    expect(await service.resolveDoi('10.1000/none.', '10.1000/none', ctx())).toEqual({
      status: 'not_on_zenodo',
    });
    expect(fm.calls).toHaveLength(2);
  });

  it('caches the resolved record for a follow-up record GET', async () => {
    fm.route({
      match: onPath('/records'),
      respond: () => jsonResponse(searchFixture(), { bucket: 'search' }),
    });
    await service.resolveDoi('10.3897/ap.e134190', undefined, ctx());
    const lookup = await service.getRecord('15308258', ctx());
    expect(lookup.status).toBe('found');
    expect(fm.calls).toHaveLength(1);
  });

  it('answers a repeat lookup of the same DOI, in any case, from the cache', async () => {
    fm.route({
      match: onPath('/records'),
      respond: () => jsonResponse(searchFixture(), { bucket: 'search' }),
    });
    await service.resolveDoi('10.3897/ap.e134190', undefined, ctx());
    const again = await service.resolveDoi('10.3897/AP.E134190', undefined, ctx());
    expect(again.status === 'found' && again.record.recid).toBe('15308258');
    expect(fm.calls).toHaveLength(1);
  });

  it('looks the DOI up again once the cached record has expired', async () => {
    fm.route({
      match: onPath('/records'),
      respond: () => jsonResponse(searchFixture(), { bucket: 'search' }),
    });
    await service.resolveDoi('10.3897/ap.e134190', undefined, ctx());
    vi.setSystemTime(NOW.getTime() + 6 * 60_000);
    await service.resolveDoi('10.3897/ap.e134190', undefined, ctx());
    expect(fm.calls).toHaveLength(2);
  });
});

describe('latestRecid', () => {
  it('reads the latest recid from the Location header without following it', async () => {
    fm.route({
      match: onPath('/records/22931068/versions/latest'),
      respond: () =>
        textResponse(null, 301, { location: 'https://zenodo.org/api/records/22950000' }),
    });
    expect(await service.latestRecid('22931068', ctx())).toBe('22950000');
    expect(fm.calls[0]?.request.redirect).toBe('manual');
    expect(await service.latestRecid('22931068', ctx())).toBe('22950000');
    expect(fm.calls).toHaveLength(1);
  });

  it('reads a relative Location from a 302 too', async () => {
    fm.route({
      match: onPath('/records/1/versions/latest'),
      respond: () => textResponse(null, 302, { location: '/api/records/2' }),
    });
    expect(await service.latestRecid('1', ctx())).toBe('2');
  });

  it('returns undefined on a 404 and does not cache it', async () => {
    fm.route({
      match: onPath('/records/1/versions/latest'),
      respond: () => jsonResponse({}, { status: 404 }),
    });
    expect(await service.latestRecid('1', ctx())).toBeUndefined();
    expect(await service.latestRecid('1', ctx())).toBeUndefined();
    expect(fm.calls).toHaveLength(2);
  });

  it('does not let a version id’s latest-of-series mapping masquerade as its record', async () => {
    fm.route(
      {
        match: onPath('/records/22931068/versions/latest'),
        respond: () => textResponse(null, 301, { location: '/api/records/22705923' }),
      },
      { match: onPath('/records/22705923'), respond: () => jsonResponse(recordFixture()) },
      {
        match: onPath('/records/22931068'),
        respond: () => jsonResponse(fixture('record-22931068-restricted.json')),
      },
    );
    await service.getRecord('22705923', ctx());
    await service.latestRecid('22931068', ctx());
    const lookup = await service.getRecord('22931068', ctx());
    expect(lookup.status === 'found' && lookup.record.recid).toBe('22931068');
  });
});

describe('listVersions', () => {
  it('requests a page sorted by version and normalizes this-version counts', async () => {
    const hit = recordFixture();
    fm.route({
      match: onPath('/records/22705923/versions'),
      respond: () => jsonResponse({ hits: { hits: [hit], total: 47 } }),
    });
    const page = await service.listVersions('22705923', 2, 5, ctx());
    expect(queryOf(fm.calls[0]?.request as Request)).toEqual([
      ['page', '2'],
      ['size', '5'],
      ['sort', 'version'],
    ]);
    expect(page).toEqual({
      status: 'ok',
      total: 47,
      concept_recid: '591564',
      concept_doi: '10.5281/zenodo.591564',
      hits: [
        {
          recid: '22705923',
          doi: '10.5281/zenodo.22705923',
          version: '1.9.1',
          title: 'scikit-learn',
          publication_date: '2026-09-11',
          index: 47,
          is_latest: true,
          file_count: 1,
          total_bytes: 8684206,
          views: 64,
          downloads: 6,
        },
      ],
    });
  });

  it('returns ok with zero hits for a deleted record’s empty series', async () => {
    fm.route({
      match: onPath('/records/22705918/versions'),
      respond: () => jsonResponse({ hits: { hits: [], total: 0 } }),
    });
    expect(await service.listVersions('22705918', 1, 25, ctx())).toEqual({
      status: 'ok',
      total: 0,
      hits: [],
    });
  });

  it('returns not_found on a 404 (a concept id)', async () => {
    fm.route({
      match: onPath('/records/591564/versions'),
      respond: () => jsonResponse({}, { status: 404 }),
    });
    expect(await service.listVersions('591564', 1, 25, ctx())).toEqual({ status: 'not_found' });
  });

  it.each([403, 410])(
    'returns not_found on a %i, for the record GET to classify',
    async (status) => {
      fm.route({
        match: onPath('/records/1/versions'),
        respond: () => jsonResponse({ status }, { status }),
      });
      expect(await service.listVersions('1', 1, 25, ctx())).toEqual({ status: 'not_found' });
      expect(fm.calls).toHaveLength(1);
    },
  );
});

describe('getCitation', () => {
  it('requests a text style with ?style= and trims the result', async () => {
    fm.route({
      match: onPath('/records/22705923', 'text/x-bibliography'),
      respond: () => textResponse(`\n${fixtureText('citation-22705923-apa.txt')}\n`),
    });
    const citation = await service.getCitation('22705923', 'apa', ctx());
    expect(citation).toBe(
      'The scikit-learn developers. (2026). scikit-learn (Version 1.9.1) [Computer software]. Zenodo. https://doi.org/10.5281/zenodo.22705923',
    );
    expect(queryOf(fm.calls[0]?.request as Request)).toEqual([['style', 'apa']]);
  });

  it('requests BibTeX and CSL-JSON by Accept alone', async () => {
    fm.route(
      {
        match: onPath('/records/22705923', 'application/x-bibtex'),
        respond: () => textResponse(fixtureText('citation-22705923.bib')),
      },
      {
        match: onPath('/records/22705923', 'application/vnd.citationstyles.csl+json'),
        respond: () => textResponse('{"type":"software"}'),
      },
    );
    expect(await service.getCitation('22705923', 'bibtex', ctx())).toMatch(
      /^@software\{the_scikit_learn_developers_2026_22705923,/,
    );
    expect(await service.getCitation('22705923', 'csl-json', ctx())).toBe('{"type":"software"}');
    expect(fm.calls.map((c) => new URL(c.request.url).search)).toEqual(['', '']);
  });
});

describe('getContainer', () => {
  const container = {
    entries: [
      { key: 'pkg/README.md', size: 1373, compressed_size: 700, mimetype: 'text/markdown', crc: 1 },
      { key: 'pkg/data.csv', size: 20, compressed_size: 18, mimetype: 'text/csv', crc: 2 },
      { size: 1 },
    ],
    directories: [{ key: 'pkg/' }],
    total: 2,
    truncated: false,
  };

  it('lists a ZIP with the JSON Accept and a segment-encoded key', async () => {
    fm.route({
      match: onPath('/records/1/files/my%20dir/bundle%20(v2).zip/container', 'application/json'),
      respond: () => jsonResponse(container),
    });
    expect(await service.getContainer('1', 'my dir/bundle (v2).zip', ctx())).toEqual({
      status: 'ok',
      listing: {
        members: [
          { path: 'pkg/README.md', size: 1373, compressed_size: 700, mimetype: 'text/markdown' },
          { path: 'pkg/data.csv', size: 20, compressed_size: 18, mimetype: 'text/csv' },
        ],
        total: 2,
        upstream_truncated: false,
        directory_count: 1,
      },
    });
    await service.getContainer('1', 'my dir/bundle (v2).zip', ctx());
    expect(fm.calls).toHaveLength(1);
  });

  it('returns not_found on a 404', async () => {
    fm.route({
      match: onPath('/records/1/files/x.zip/container'),
      respond: () => jsonResponse({}, { status: 404 }),
    });
    expect(await service.getContainer('1', 'x.zip', ctx())).toEqual({ status: 'not_found' });
  });
});

describe('readContent and readMember', () => {
  const csv = 'id,value\r\n1,alpha\r\n2,beta\r\n';

  it('reads a 206 range, taking the file size from Content-Range', async () => {
    fm.route({
      match: onPath('/records/1/files/data/table.csv/content'),
      respond: () =>
        textResponse(csv.slice(0, 10), 206, { 'content-range': `bytes 0-9/${csv.length}` }),
    });
    const read = await service.readContent('1', 'data/table.csv', 0, 10, ctx());
    expect(fm.calls[0]?.request.headers.get('range')).toBe('bytes=0-9');
    expect(fm.calls[0]?.request.headers.get('accept')).toBe('application/json');
    expect(new TextDecoder().decode(read.bytes)).toBe('id,value\r\n');
    expect(read).toMatchObject({ status: 'ok', fileSize: csv.length, moreRemains: true });
  });

  it('reports no more bytes when the range reaches the end of the file', async () => {
    fm.route({
      match: onPath('/records/1/files/t.csv/content'),
      respond: () =>
        textResponse(csv.slice(20), 206, {
          'content-range': `bytes 20-${csv.length - 1}/${csv.length}`,
        }),
    });
    const read = await service.readContent('1', 't.csv', 20, 100, ctx());
    expect(read).toMatchObject({ status: 'ok', fileSize: csv.length, moreRemains: false });
  });

  it('tolerates a 200 that ignored Range: skips to the offset and cuts at the cap', async () => {
    fm.route({ match: onPath('/records/1/files/t.csv/content'), respond: () => textResponse(csv) });
    const read = await service.readContent('1', 't.csv', 10, 8, ctx());
    expect(new TextDecoder().decode(read.bytes)).toBe('1,alpha\r');
    expect(read).toMatchObject({ status: 'ok', moreRemains: true });
    expect(read).not.toHaveProperty('fileSize');
  });

  it.each([
    [403, 'forbidden'],
    [404, 'not_found'],
    [416, 'range_not_satisfiable'],
  ] as const)('maps HTTP %i to %s', async (status, expected) => {
    fm.route({
      match: onPath('/records/1/files/t.csv/content'),
      respond: () => jsonResponse({ status }, { status }),
    });
    expect(await service.readContent('1', 't.csv', 0, 100, ctx())).toEqual({
      status: expected,
      bytes: new Uint8Array(0),
      moreRemains: false,
    });
  });

  it('streams a ZIP member and cancels at the cap (the endpoint ignores Range)', async () => {
    fm.route({
      match: onPath('/records/1/files/b.zip/container/pkg/README.md'),
      respond: () => textResponse('# Title\nbody text\n'),
    });
    const read = await service.readMember('1', 'b.zip', 'pkg/README.md', 8, ctx());
    expect(fm.calls[0]?.request.headers.get('range')).toBeNull();
    expect(new TextDecoder().decode(read.bytes)).toBe('# Title\n');
    expect(read).toMatchObject({ status: 'ok', moreRemains: true });
  });

  it('maps a missing ZIP member to not_found', async () => {
    fm.route({
      match: onPath('/records/1/files/b.zip/container/nope/missing.txt'),
      respond: () => jsonResponse({ status: 404 }, { status: 404 }),
    });
    expect((await service.readMember('1', 'b.zip', 'nope/missing.txt', 8, ctx())).status).toBe(
      'not_found',
    );
  });
});

describe('communities and funders', () => {
  it('retries a community slug 404 once lowercased', async () => {
    const community = {
      id: 'c0ffee00-0000-4000-8000-000000000001',
      slug: 'symbaproject',
      metadata: { title: 'SYMBA' },
    };
    fm.route(
      {
        match: onPath('/communities/SYMBAPROJECT'),
        respond: () => jsonResponse({}, { status: 404 }),
      },
      { match: onPath('/communities/symbaproject'), respond: () => jsonResponse(community) },
    );
    expect(await service.getCommunity('SYMBAPROJECT', ctx())).toEqual({
      slug: 'symbaproject',
      uuid: 'c0ffee00-0000-4000-8000-000000000001',
      title: 'SYMBA',
      organizations: [],
    });
    expect(paths()).toEqual(['/api/communities/SYMBAPROJECT', '/api/communities/symbaproject']);
  });

  it('does not retry an already-lowercase slug, and caches the miss', async () => {
    fm.route({
      match: onPath('/communities/nonexistent-zzz-slug'),
      respond: () => jsonResponse({}, { status: 404 }),
    });
    expect(await service.getCommunity('nonexistent-zzz-slug', ctx())).toBeUndefined();
    expect(await service.getCommunity('nonexistent-zzz-slug', ctx())).toBeUndefined();
    expect(fm.calls).toHaveLength(1);
  });

  it('validates a ROR id and caches hits and misses', async () => {
    fm.route(
      {
        match: onPath('/funders/01cwqze88'),
        respond: () => jsonResponse(fixture('funder-01cwqze88.json')),
      },
      {
        match: onPath('/funders/0zzzzzz00'),
        respond: () => jsonResponse(fixture('error-404-funder.json'), { status: 404 }),
      },
    );
    const nih = {
      ror_id: '01cwqze88',
      name: 'National Institutes of Health',
      funder_doi: '10.13039/100000002',
      acronym: 'NIH',
      country: 'US',
      country_name: 'United States',
    };
    expect(await service.getFunder('01cwqze88', ctx())).toEqual(nih);
    expect(await service.getFunder('01cwqze88', ctx())).toEqual(nih);
    expect(await service.getFunder('0zzzzzz00', ctx())).toBeUndefined();
    expect(await service.getFunder('0zzzzzz00', ctx())).toBeUndefined();
    expect(fm.calls).toHaveLength(2);
  });

  it('expires a cached funder miss after 10 minutes', async () => {
    fm.route({
      match: onPath('/funders/0zzzzzz00'),
      respond: () => jsonResponse({}, { status: 404 }),
    });
    await service.getFunder('0zzzzzz00', ctx());
    vi.advanceTimersByTime(10 * 60_000);
    await service.getFunder('0zzzzzz00', ctx());
    expect(fm.calls).toHaveLength(2);
  });

  it('resolves a Crossref Funder DOI through an identifier query', async () => {
    fm.route({
      match: onPath('/funders'),
      respond: () => jsonResponse(fixture('funders-by-doi-10.13039-100000002.json')),
    });
    const funder = await service.resolveFunder(
      { kind: 'funder_doi', doi: '10.13039/100000002' },
      ctx(),
    );
    expect(funder?.ror_id).toBe('01cwqze88');
    expect(queryOf(fm.calls[0]?.request as Request)).toEqual([
      ['q', 'identifiers.identifier:"10.13039/100000002"'],
      ['size', '1'],
    ]);
  });
});

describe('searchVocabulary', () => {
  it('escapes query syntax and scopes awards by funder', async () => {
    fm.route({
      match: onPath('/awards'),
      respond: () => jsonResponse(fixture('awards-q-symba.json')),
    });
    await service.searchVocabulary(
      'awards',
      { query: 'a:b/c', funderRor: '00k4n6c32', page: 2, size: 5 },
      ctx(),
    );
    expect(queryOf(fm.calls[0]?.request as Request)).toEqual([
      ['q', 'a\\:b\\/c'],
      ['funders', '00k4n6c32'],
      ['page', '2'],
      ['size', '5'],
    ]);
  });

  it('never sends funders= for a vocabulary other than awards', async () => {
    fm.route({
      match: onPath('/funders'),
      respond: () => jsonResponse(fixture('funders-q-wellcome.json')),
    });
    await service.searchVocabulary(
      'funders',
      { query: 'wellcome', funderRor: '00k4n6c32', page: 1, size: 3 },
      ctx(),
    );
    expect(queryOf(fm.calls[0]?.request as Request).map(([k]) => k)).toEqual(['q', 'page', 'size']);
  });

  it('omits q when browsing', async () => {
    fm.route({
      match: onPath('/vocabularies/licenses'),
      respond: () => jsonResponse(fixture('licenses-q-mit.json')),
    });
    await service.searchVocabulary('licenses', { page: 1, size: 3 }, ctx());
    expect(queryOf(fm.calls[0]?.request as Request)).toEqual([
      ['page', '1'],
      ['size', '3'],
    ]);
  });

  it('normalizes communities, dropping null upstream fields', async () => {
    fm.route({
      match: onPath('/communities'),
      respond: () => jsonResponse(fixture('communities-q-astronomy.json')),
    });
    const page = await service.searchVocabulary(
      'communities',
      { query: 'astronomy', page: 1, size: 2 },
      ctx(),
    );
    expect(page).toEqual({
      vocabulary: 'communities',
      total: 1148,
      entries: [
        {
          slug: 'sochias',
          uuid: '9649d306-cf94-49cc-a14d-934ca8fcb515',
          title: 'Sociedad Chilena de Astronomía (SOCHIAS)',
          community_type: 'Organization',
          website: 'https://zenodo.org/communities/sochias',
          organizations: ['SOCHIAS'],
        },
        {
          slug: 'siac',
          uuid: '981b34f3-760d-4264-8ab8-b2f94464937f',
          title: 'Sociedad Interamericana de Astronomía en la Cultura',
          organizations: [],
        },
      ],
    });
  });

  it('maps license OSI approval y → true, n → false, blank → omitted', async () => {
    const body = fixture<{ hits: { hits: { props: { osi_approved: string } }[] } }>(
      'licenses-q-mit.json',
    );
    (body.hits.hits[2] as { props: { osi_approved: string } }).props.osi_approved = 'n';
    fm.route({ match: onPath('/vocabularies/licenses'), respond: () => jsonResponse(body) });
    const page = await service.searchVocabulary(
      'licenses',
      { query: 'mit', page: 1, size: 3 },
      ctx(),
    );
    expect(
      page.vocabulary === 'licenses' && page.entries.map((l) => [l.id, l.osi_approved]),
    ).toEqual([
      ['mit', true],
      ['aml', undefined],
      ['mit-0', false],
    ]);
  });

  it('caches a page for an hour', async () => {
    fm.route({
      match: onPath('/vocabularies/licenses'),
      respond: () => jsonResponse(fixture('licenses-q-mit.json')),
    });
    await service.searchVocabulary('licenses', { query: 'mit', page: 1, size: 3 }, ctx());
    await service.searchVocabulary('licenses', { query: 'mit', page: 1, size: 3 }, ctx());
    vi.advanceTimersByTime(60 * 60_000);
    await service.searchVocabulary('licenses', { query: 'mit', page: 1, size: 3 }, ctx());
    expect(fm.calls).toHaveLength(2);
  });
});

describe('searchRecords', () => {
  const body = () => {
    const raw = fixture<{ aggregations: unknown; hits: { hits: RawRecord[]; total: number } }>(
      'search-doi-10.3897-ap.e134190.json',
    );
    return raw;
  };

  it('sends only allowlisted params, returns the composed q, strips manifests, and normalizes facets', async () => {
    fm.route({
      match: onPath('/records'),
      respond: () => jsonResponse(body(), { bucket: 'search' }),
    });
    const result = await service.searchRecords(
      {
        query: 'dairy',
        license: 'cc-by-4.0',
        resourceTypes: ['publication-article'],
        fileTypes: ['pdf'],
        allVersions: false,
        page: 1,
        size: 10,
        sort: 'bestmatch',
      },
      ctx(),
    );
    const params = queryOf(fm.calls[0]?.request as Request);
    for (const [key] of params) expect(SEARCH_ALLOWLIST.has(key)).toBe(true);
    const q =
      '(dairy) AND metadata.rights.id:"cc-by-4.0" AND metadata.resource_type.id:"publication-article" AND files.types:"pdf"';
    expect(params[0]).toEqual(['q', q]);
    expect(result.q).toBe(q);
    expect(result.total).toBe(1);
    expect(result.hits[0]).toMatchObject({
      recid: '15308258',
      doi_provider: 'external',
      file_count: 2,
      license_ids: ['cc-by-4.0'],
      zenodo_url: 'https://zenodo.org/records/15308258',
    });
    expect(result.hits[0]).not.toHaveProperty('files');
    expect(result.facets).toEqual({
      resource_type: [
        {
          id: 'publication',
          label: 'Publication',
          count: 1,
          subtypes: [{ id: 'publication-article', label: expect.any(String), count: 1 }],
        },
      ],
      access_status: [{ id: 'open', label: 'Open', count: 1 }],
      file_type: [
        { id: 'pdf', label: 'PDF', count: 1 },
        { id: 'xml', label: 'XML', count: 1 },
      ],
      subject: [
        { label: 'competitiveness index', count: 1 },
        { label: 'dairy products', count: 1 },
        { label: 'milk', count: 1 },
      ],
      publication_year: [{ year: '2025', count: 1 }],
    });
  });

  it('caches an identical search for 60 s', async () => {
    fm.route({
      match: onPath('/records'),
      respond: () => jsonResponse(body(), { bucket: 'search' }),
    });
    const filters = { allVersions: false, page: 1, size: 10, sort: 'newest' as const };
    await service.searchRecords(filters, ctx());
    await service.searchRecords(filters, ctx());
    expect(fm.calls).toHaveLength(1);
    vi.advanceTimersByTime(60_000);
    await service.searchRecords(filters, ctx());
    expect(fm.calls).toHaveLength(2);
  });
});
