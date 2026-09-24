/**
 * @fileoverview Zenodo REST API service: records, DOI resolution, versions,
 * citations, file content and ZIP listings, and the reference vocabularies. Every
 * call goes through the paced, retried fetch boundary in `http.ts`; results are
 * cached process-wide (Zenodo data is public).
 * @module services/zenodo/zenodo-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { validationError } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { TtlLruCache } from './cache.js';
import {
  CONTENT_ATTEMPT_MS,
  discardBody,
  JSON_ATTEMPT_MS,
  readCapped,
  readJson,
  readText,
  ZenodoHttp,
  type ZenodoRequest,
} from './http.js';
import { downloadUrl, encodeKeySegments, type FunderRef, hasDotSegment } from './identifiers.js';
import {
  normalizeAward,
  normalizeCommunity,
  normalizeContainer,
  normalizeFacets,
  normalizeFunder,
  normalizeLicense,
  normalizeRecord,
  normalizeSearchHit,
  normalizeTombstone,
  normalizeVersionHit,
  opt,
} from './normalize.js';
import {
  buildSearch,
  escapeVocabularyQuery,
  quoteValue,
  type SearchFilters,
} from './query-builder.js';
import type {
  CitationStyle,
  CommunityEntry,
  ContainerLookup,
  ContentRead,
  FunderEntry,
  RawAward,
  RawCommunity,
  RawContainer,
  RawFunder,
  RawLicense,
  RawRecord,
  RawSearchResponse,
  RawTombstone,
  RecordLookup,
  RemoteVocabulary,
  SearchPage,
  VersionsLookup,
  VocabularyPage,
  ZenodoRecord,
} from './types.js';

const RDM = 'application/vnd.inveniordm.v1+json';
const JSON_ACCEPT = 'application/json';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const CITATION_ACCEPT: Record<CitationStyle, string> = {
  bibtex: 'application/x-bibtex',
  'csl-json': 'application/vnd.citationstyles.csl+json',
  apa: 'text/x-bibliography',
  'chicago-author-date': 'text/x-bibliography',
  'harvard-cite-them-right': 'text/x-bibliography',
  ieee: 'text/x-bibliography',
  'modern-language-association': 'text/x-bibliography',
  nature: 'text/x-bibliography',
};

const VOCABULARY_PATHS: Record<RemoteVocabulary, string> = {
  communities: '/communities',
  funders: '/funders',
  awards: '/awards',
  licenses: '/vocabularies/licenses',
};

/**
 * Request path of a file endpoint: `/records/{recid}/files/{key}` plus any further
 * segments, each key or member path percent-encoded. A `.` or `..` segment is
 * refused, since the URL parser would resolve it to another zenodo.org endpoint.
 */
function filePath(recid: string, key: string, ...rest: string[]): string {
  for (const part of [key, ...rest]) {
    if (hasDotSegment(part)) {
      throw validationError(
        'A file key or archive member path with a "." or ".." segment names no file on Zenodo.',
      );
    }
  }
  return `/records/${recid}/files/${[key, ...rest].map(encodeKeySegments).join('/')}`;
}

/** A search page plus the exact `q` that was sent. */
export type SearchResult = SearchPage & { q?: string };

/** Outcome of resolving a non-Zenodo DOI through search. */
export type DoiResolution = { record: ZenodoRecord; status: 'found' } | { status: 'not_on_zenodo' };

/** Zenodo REST API client with process-local caching. */
export class ZenodoService {
  readonly #cache = new TtlLruCache({ maxBytes: 64 * 1024 * 1024, maxEntryBytes: 4 * 1024 * 1024 });
  readonly #http: ZenodoHttp;

  constructor(options: { accessToken?: string | undefined; userAgent: string }) {
    this.#http = new ZenodoHttp(options);
  }

  /** Releases the pacers' timers and queued waiters. */
  dispose(): void {
    this.#http.dispose();
    this.#cache.clear();
  }

  /** Record search (search bucket). Only allowlisted params reach the URL. */
  async searchRecords(filters: SearchFilters, ctx: Context): Promise<SearchResult> {
    const built = buildSearch(filters);
    const cacheKey = `search/${JSON.stringify(built.params)}`;
    const cached = this.#cache.get<SearchResult>(cacheKey);
    if (cached) return cached;

    const raw = await this.#http.request(
      this.#jsonRequest('/records', RDM, 'search', 'search', [200], 'searchRecords', built.params),
      (res) => readJson<RawSearchResponse>(res),
      ctx,
    );
    const result: SearchResult = {
      total: raw.hits?.total ?? 0,
      hits: (raw.hits?.hits ?? []).map(normalizeSearchHit),
      facets: normalizeFacets(raw.aggregations),
      ...(built.q ? { q: built.q } : {}),
    };
    this.#cache.set(cacheKey, result, MINUTE);
    return result;
  }

  /**
   * Record GET (follows a concept id's 302 to the latest version). A 404, 403, or
   * 410 is a result, not an error.
   */
  async getRecord(recid: string, ctx: Context): Promise<RecordLookup> {
    const cached = this.#cachedRecord(recid);
    if (cached) return { status: 'found', record: cached };

    const lookup = await this.#http.request(
      this.#jsonRequest(
        `/records/${recid}`,
        RDM,
        'general',
        'record',
        [200, 403, 404, 410],
        'getRecord',
      ),
      async (res): Promise<RecordLookup> => {
        if (res.status === 200) {
          return { status: 'found', record: normalizeRecord(await readJson<RawRecord>(res)) };
        }
        if (res.status === 410) {
          const body = await readJson<{ tombstone?: RawTombstone }>(res).catch(
            () => ({}) as { tombstone?: RawTombstone },
          );
          return { status: 'deleted', tombstone: normalizeTombstone(body.tombstone) };
        }
        await discardBody(res);
        return { status: res.status === 403 ? 'restricted' : 'not_found' };
      },
      ctx,
    );
    if (lookup.status === 'found') this.#storeRecord(lookup.record, recid);
    return lookup;
  }

  /**
   * Resolves a DOI through record search with `all_versions=true` (a superseded
   * version's DOI misses without it). When the as-given DOI misses and a form with
   * trailing punctuation stripped exists, that form is tried once. A hit is cached
   * as `doi/{doi}` → recid next to the record, so the drill-down tools reuse it
   * instead of spending the search budget again.
   */
  async resolveDoi(
    doi: string,
    strippedDoi: string | undefined,
    ctx: Context,
  ): Promise<DoiResolution> {
    for (const candidate of strippedDoi ? [doi, strippedDoi] : [doi]) {
      const cachedRecid = this.#cache.get<string>(`doi/${candidate.toLowerCase()}`);
      const cached = cachedRecid && this.#cache.get<ZenodoRecord>(`record/${cachedRecid}`);
      if (cached) return { status: 'found', record: cached };

      const raw = await this.#http.request(
        this.#jsonRequest('/records', RDM, 'search', 'doi_lookup', [200], 'resolveDoi', [
          ['q', `doi:${quoteValue(candidate)}`],
          ['all_versions', 'true'],
          ['size', '2'],
        ]),
        (res) => readJson<RawSearchResponse>(res),
        ctx,
      );
      const hits = raw.hits?.hits ?? [];
      const wanted = candidate.toLowerCase();
      const hit = hits.find((h) => h.pids?.doi?.identifier?.toLowerCase() === wanted) ?? hits[0];
      if (hit) {
        const record = normalizeRecord(hit);
        this.#storeRecord(record, record.recid);
        this.#cache.set(`doi/${candidate.toLowerCase()}`, record.recid, 5 * MINUTE);
        return { status: 'found', record };
      }
    }
    return { status: 'not_on_zenodo' };
  }

  /**
   * Latest version's recid for any recid in a series (`/versions/latest`, Location
   * only). Its failures stay untyped: the record itself already resolved, so
   * `record_unavailable` would misdescribe them.
   */
  async latestRecid(recid: string, ctx: Context): Promise<string | undefined> {
    const cacheKey = `concept/${recid}`;
    const cached = this.#cache.get<string>(cacheKey);
    if (cached) return cached;
    const latest = await this.#http.request(
      {
        ...this.#jsonRequest(
          `/records/${recid}/versions/latest`,
          RDM,
          'general',
          'other',
          [301, 302, 404],
          'latestRecid',
        ),
        redirect: 'manual',
      },
      async (res) => {
        await discardBody(res);
        if (res.status === 404) return;
        return /\/records\/(\d+)/.exec(res.headers.get('location') ?? '')?.[1];
      },
      ctx,
    );
    if (latest) this.#cache.set(cacheKey, latest, 5 * MINUTE);
    return latest;
  }

  /**
   * One page of a version series, newest first. A 404 (a concept id), 403, or 410
   * means the id names no listable series; the caller classifies it with the record GET.
   */
  listVersions(recid: string, page: number, size: number, ctx: Context): Promise<VersionsLookup> {
    return this.#http.request(
      this.#jsonRequest(
        `/records/${recid}/versions`,
        RDM,
        'general',
        'versions',
        [200, 403, 404, 410],
        'listVersions',
        [
          ['page', String(page)],
          ['size', String(size)],
          ['sort', 'version'],
        ],
      ),
      async (res): Promise<VersionsLookup> => {
        if (res.status !== 200) {
          await discardBody(res);
          return { status: 'not_found' };
        }
        const raw = await readJson<RawSearchResponse>(res);
        const hits = raw.hits?.hits ?? [];
        const parent = hits[0]?.parent;
        return {
          status: 'ok',
          total: raw.hits?.total ?? 0,
          hits: hits.map(normalizeVersionHit),
          ...opt('concept_recid', parent?.id),
          ...opt('concept_doi', parent?.pids?.doi?.identifier),
        };
      },
      ctx,
    );
  }

  /**
   * A formatted citation for a version recid. Always call with the resolved
   * version: a concept recid's redirect drops `?style=`.
   */
  getCitation(recid: string, style: CitationStyle, ctx: Context): Promise<string> {
    const accept = CITATION_ACCEPT[style];
    const query: [string, string][] = accept === 'text/x-bibliography' ? [['style', style]] : [];
    return this.#http.request(
      this.#jsonRequest(
        `/records/${recid}`,
        accept,
        'general',
        'other',
        [200],
        'getCitation',
        query,
      ),
      async (res) => (await readText(res)).trim(),
      ctx,
    );
  }

  /**
   * Member listing of a ZIP file (`/container`). Call only for `.zip` keys — other
   * archives answer 500, and so do some ZIPs, which surfaces as `archive_unavailable`.
   */
  async getContainer(recid: string, key: string, ctx: Context): Promise<ContainerLookup> {
    const cacheKey = `container/${recid}/${key}`;
    const cached = this.#cache.get<ContainerLookup>(cacheKey);
    if (cached) return cached;
    const lookup = await this.#http.request(
      {
        ...this.#jsonRequest(
          filePath(recid, key, 'container'),
          JSON_ACCEPT,
          'general',
          'archive',
          [200, 404],
          'getContainer',
        ),
        downloadUrl: downloadUrl(recid, key),
      },
      async (res): Promise<ContainerLookup> => {
        if (res.status === 404) {
          await discardBody(res);
          return { status: 'not_found' };
        }
        return { status: 'ok', listing: normalizeContainer(await readJson<RawContainer>(res)) };
      },
      ctx,
    );
    if (lookup.status === 'ok') this.#cache.set(cacheKey, lookup, 10 * MINUTE);
    return lookup;
  }

  /** Byte-range read of a top-level file. A 200 (range ignored) is streamed and cut at the cap. */
  readContent(
    recid: string,
    key: string,
    offsetBytes: number,
    maxBytes: number,
    ctx: Context,
  ): Promise<ContentRead> {
    return this.#http.request(
      {
        ...this.#jsonRequest(
          filePath(recid, key, 'content'),
          JSON_ACCEPT,
          'general',
          'other',
          [200, 206, 403, 404, 416],
          'readContent',
        ),
        attemptMs: CONTENT_ATTEMPT_MS,
        range: `bytes=${offsetBytes}-${offsetBytes + maxBytes - 1}`,
      },
      async (res): Promise<ContentRead> => {
        const miss = await contentMiss(res);
        if (miss) return miss;
        if (res.status === 206) {
          const total = Number(/\/(\d+)\s*$/.exec(res.headers.get('content-range') ?? '')?.[1]);
          const { bytes, more } = await readCapped(res, maxBytes);
          const fileSize = Number.isFinite(total) ? total : undefined;
          return {
            status: 'ok',
            bytes,
            moreRemains: fileSize !== undefined ? offsetBytes + bytes.length < fileSize : more,
            ...(fileSize !== undefined ? { fileSize } : {}),
          };
        }
        const { bytes, more } = await readCapped(res, maxBytes, offsetBytes);
        return { status: 'ok', bytes, moreRemains: more };
      },
      ctx,
    );
  }

  /** Reads the head of a ZIP member. The member endpoint ignores Range, so the stream is cancelled at the cap. */
  readMember(
    recid: string,
    key: string,
    member: string,
    maxBytes: number,
    ctx: Context,
  ): Promise<ContentRead> {
    return this.#http.request(
      {
        ...this.#jsonRequest(
          filePath(recid, key, 'container', member),
          JSON_ACCEPT,
          'general',
          'archive',
          [200, 403, 404],
          'readMember',
        ),
        attemptMs: CONTENT_ATTEMPT_MS,
        downloadUrl: downloadUrl(recid, key),
      },
      async (res): Promise<ContentRead> => {
        const miss = await contentMiss(res);
        if (miss) return miss;
        const { bytes, more } = await readCapped(res, maxBytes);
        return { status: 'ok', bytes, moreRemains: more };
      },
      ctx,
    );
  }

  /**
   * Resolves a community slug or UUID to its entry. Slugs are case-sensitive, so a
   * 404 is retried once lowercased when that differs. Misses are cached.
   */
  async getCommunity(slugOrId: string, ctx: Context): Promise<CommunityEntry | undefined> {
    const found = await this.#fetchCommunity(slugOrId, ctx);
    if (found) return found;
    const lower = slugOrId.toLowerCase();
    return lower === slugOrId ? undefined : this.#fetchCommunity(lower, ctx);
  }

  /** Validates a ROR id against Zenodo's funder vocabulary. Misses are cached. */
  getFunder(ror: string, ctx: Context): Promise<FunderEntry | undefined> {
    return this.#cachedLookup(`funder/${ror}`, () =>
      this.#http.request(
        this.#jsonRequest(
          `/funders/${encodeURIComponent(ror)}`,
          JSON_ACCEPT,
          'general',
          'other',
          [200, 404],
          'getFunder',
        ),
        async (res) => {
          if (res.status === 404) {
            await discardBody(res);
            return;
          }
          return normalizeFunder(await readJson<RawFunder>(res));
        },
        ctx,
      ),
    );
  }

  /** Finds the funder carrying a Crossref Funder DOI (one-to-one). Misses are cached. */
  findFunderByDoi(doi: string, ctx: Context): Promise<FunderEntry | undefined> {
    return this.#cachedLookup(`funderdoi/${doi}`, () =>
      this.#http.request(
        this.#jsonRequest('/funders', JSON_ACCEPT, 'general', 'other', [200], 'findFunderByDoi', [
          ['q', `identifiers.identifier:${quoteValue(doi)}`],
          ['size', '1'],
        ]),
        async (res) => {
          const hit = (await readJson<RawSearchResponse<RawFunder>>(res)).hits?.hits?.[0];
          return hit ? normalizeFunder(hit) : undefined;
        },
        ctx,
      ),
    );
  }

  /** Resolves a parsed funder reference (ROR id or Funder DOI) to a funder entry. */
  resolveFunder(ref: FunderRef, ctx: Context): Promise<FunderEntry | undefined> {
    return ref.kind === 'ror' ? this.getFunder(ref.ror, ctx) : this.findFunderByDoi(ref.doi, ctx);
  }

  /** One page of a remote vocabulary. `funderRor` scopes awards to one funder. */
  async searchVocabulary(
    vocabulary: RemoteVocabulary,
    params: {
      funderRor?: string | undefined;
      page: number;
      query?: string | undefined;
      size: number;
    },
    ctx: Context,
  ): Promise<VocabularyPage> {
    const query: [string, string][] = [];
    if (params.query) query.push(['q', escapeVocabularyQuery(params.query)]);
    if (vocabulary === 'awards' && params.funderRor) query.push(['funders', params.funderRor]);
    query.push(['page', String(params.page)], ['size', String(params.size)]);

    const cacheKey = `vocab/${vocabulary}/${JSON.stringify(query)}`;
    const cached = this.#cache.get<VocabularyPage>(cacheKey);
    if (cached) return cached;

    const raw = await this.#http.request(
      this.#jsonRequest(
        VOCABULARY_PATHS[vocabulary],
        JSON_ACCEPT,
        'general',
        'other',
        [200],
        'searchVocabulary',
        query,
      ),
      (res) => readJson<RawSearchResponse<unknown>>(res),
      ctx,
    );
    const total = raw.hits?.total ?? 0;
    const hits = raw.hits?.hits ?? [];
    const page: VocabularyPage =
      vocabulary === 'communities'
        ? { vocabulary, total, entries: (hits as RawCommunity[]).map(normalizeCommunity) }
        : vocabulary === 'funders'
          ? { vocabulary, total, entries: (hits as RawFunder[]).map(normalizeFunder) }
          : vocabulary === 'awards'
            ? { vocabulary, total, entries: (hits as RawAward[]).map(normalizeAward) }
            : { vocabulary, total, entries: (hits as RawLicense[]).map(normalizeLicense) };
    this.#cache.set(cacheKey, page, HOUR);
    return page;
  }

  #jsonRequest(
    path: string,
    accept: string,
    bucket: ZenodoRequest['bucket'],
    endpoint: ZenodoRequest['endpoint'],
    okStatuses: readonly number[],
    operation: string,
    query?: readonly (readonly [string, string])[],
  ): ZenodoRequest {
    return {
      path,
      accept,
      bucket,
      endpoint,
      okStatuses,
      operation,
      attemptMs: JSON_ATTEMPT_MS,
      ...(query ? { query } : {}),
    };
  }

  /** A cached record for `recid` — directly, or via a cached concept → latest mapping. */
  #cachedRecord(recid: string): ZenodoRecord | undefined {
    const direct = this.#cache.get<ZenodoRecord>(`record/${recid}`);
    if (direct) return direct;
    const latest = this.#cache.get<string>(`concept/${recid}`);
    if (!latest) return;
    const record = this.#cache.get<ZenodoRecord>(`record/${latest}`);
    // `concept/{recid}` also holds latest-of-series for version ids; only a concept id may redirect.
    return record?.concept_recid === recid ? record : undefined;
  }

  #storeRecord(record: ZenodoRecord, requested: string): void {
    this.#cache.set(`record/${record.recid}`, record, 5 * MINUTE);
    if (requested !== record.recid)
      this.#cache.set(`concept/${requested}`, record.recid, 5 * MINUTE);
  }

  #fetchCommunity(slugOrId: string, ctx: Context): Promise<CommunityEntry | undefined> {
    return this.#cachedLookup(`community/${slugOrId}`, () =>
      this.#http.request(
        this.#jsonRequest(
          `/communities/${encodeURIComponent(slugOrId)}`,
          JSON_ACCEPT,
          'general',
          'other',
          [200, 404],
          'getCommunity',
        ),
        async (res) => {
          if (res.status === 404) {
            await discardBody(res);
            return;
          }
          return normalizeCommunity(await readJson<RawCommunity>(res));
        },
        ctx,
      ),
    );
  }

  /** Cache wrapper for entry lookups: hits for 1 h, misses (stored as `null`) for 10 min. */
  async #cachedLookup<T>(key: string, load: () => Promise<T | undefined>): Promise<T | undefined> {
    const cached = this.#cache.get<T | null>(key);
    if (cached !== undefined) return cached ?? undefined;
    const value = await load();
    this.#cache.set(key, value ?? null, value === undefined ? 10 * MINUTE : HOUR);
    return value;
  }
}

/** Maps a content endpoint's non-content statuses to a result, consuming the body. */
async function contentMiss(res: Response): Promise<ContentRead | undefined> {
  const status =
    res.status === 403
      ? 'forbidden'
      : res.status === 404
        ? 'not_found'
        : res.status === 416
          ? 'range_not_satisfiable'
          : undefined;
  if (!status) return;
  await discardBody(res);
  return { status, bytes: new Uint8Array(0), moreRemains: false };
}

// --- Init/accessor ---

let _service: ZenodoService | undefined;

/** Creates the service. Called once from `createApp({ setup })`. */
export function initZenodoService(config: AppConfig): void {
  _service = new ZenodoService({
    accessToken: getServerConfig().accessToken,
    userAgent: `zenodo-mcp-server/${config.mcpServerVersion} (+https://github.com/cyanheads/zenodo-mcp-server)`,
  });
}

/** The initialized service. Throws when `initZenodoService()` has not run. */
export function getZenodoService(): ZenodoService {
  if (!_service)
    throw new Error('ZenodoService not initialized — call initZenodoService() in setup()');
  return _service;
}

/** Disposes the service's pacers. Called from `createApp({ teardown })`. */
export function disposeZenodoService(): void {
  _service?.dispose();
  _service = undefined;
}
