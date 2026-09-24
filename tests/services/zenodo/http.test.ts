/**
 * @fileoverview Tests for the Zenodo fetch boundary against a strict fetch fake:
 * per-call status accept-lists, request construction, the retry matrix (search 500
 * never retried, record 500 retried once, slow 504 and attempt timeouts never
 * retried, 429 retried only under a short Retry-After), the per-bucket header gate,
 * and the two pacers (a search 429 must not freeze general traffic). Fake timers
 * drive every backoff, gateway delay, and attempt budget.
 * @module tests/services/zenodo/http.test
 */

import { type ErrorContract, JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createMockContext,
  type FetchMockHarness,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONTENT_ATTEMPT_MS,
  JSON_ATTEMPT_MS,
  readCapped,
  readJson,
  ZenodoHttp,
  type ZenodoRequest,
} from '@/services/zenodo/http.js';
import {
  GATEWAY_TIMEOUT_HTML,
  hangUntilAborted,
  jsonResponse,
  onPath,
  RDM,
  rateHeaders,
  respondAfter,
  settle,
  textResponse,
} from '../../helpers/zenodo-fixtures.js';

/** The fixed clock every test starts from (a whole second, so reset math is exact). */
const NOW = new Date('2026-09-23T12:00:00Z');
const UA = 'zenodo-mcp-server/0.0.0-test (+https://github.com/cyanheads/zenodo-mcp-server)';

/** The reasons the boundary throws, with the recovery strings the design fixes. */
const CONTRACT = [
  {
    reason: 'query_failed',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'search 500',
    recovery:
      'Simplify the query (quote phrases, escape : and / with a backslash, or move identifiers into the dedicated filters) and call zenodo_search_records again; if a plain keyword query also fails, Zenodo is degraded, so retry in a few minutes.',
  },
  {
    reason: 'upstream_timeout',
    code: JsonRpcErrorCode.Timeout,
    when: 'search or versions timed out',
    recovery:
      'Call zenodo_search_records again with a smaller size (5) or narrower filters so the page holds fewer large deposits.',
  },
  {
    reason: 'record_unavailable',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'record 500 twice or slow 504',
    recovery:
      'Look the record up with zenodo_search_records using query doi:"<its DOI>" (all_versions true) or its title.',
  },
  {
    reason: 'archive_unavailable',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'container or member 500 twice, or no complete response',
    recovery: 'Download the archive from the URL in the error message and open it locally.',
  },
  {
    reason: 'rate_limited',
    code: JsonRpcErrorCode.RateLimited,
    when: '429, header gate, or pacer shed',
    recovery:
      'Wait for the retryAfter seconds in the error data, then call the tool again with the same arguments.',
  },
] as const satisfies readonly ErrorContract[];

const hint = (reason: (typeof CONTRACT)[number]['reason']) =>
  CONTRACT.find((c) => c.reason === reason)?.recovery;

function recordReq(recid = '22705923', over: Partial<ZenodoRequest> = {}): ZenodoRequest {
  return {
    path: `/records/${recid}`,
    accept: RDM,
    bucket: 'general',
    endpoint: 'record',
    okStatuses: [200, 403, 404, 410],
    operation: 'getRecord',
    attemptMs: JSON_ATTEMPT_MS,
    ...over,
  };
}

function searchReq(over: Partial<ZenodoRequest> = {}): ZenodoRequest {
  return {
    path: '/records',
    accept: RDM,
    bucket: 'search',
    endpoint: 'search',
    okStatuses: [200],
    operation: 'searchRecords',
    attemptMs: JSON_ATTEMPT_MS,
    query: [
      ['q', 'climate model'],
      ['sort', 'bestmatch'],
      ['page', '1'],
      ['size', '10'],
    ],
    ...over,
  };
}

const readStatus = async (res: Response) => {
  await res.body?.cancel();
  return res.status;
};

const hitsBody = { hits: { hits: [], total: 0 } };

let fm: FetchMockHarness;
let http: ZenodoHttp;
let ctx: ReturnType<typeof createMockContext<typeof CONTRACT>>;

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  fm = createFetchMock();
  fm.install();
  http = new ZenodoHttp({ userAgent: UA });
  ctx = createMockContext({ errors: CONTRACT });
});

afterEach(() => {
  http.dispose();
  fm.restore();
  vi.useRealTimers();
});

/** Runs a request while fake time advances, returning its settled outcome. */
async function drive<T>(promise: Promise<T>, ms = 60_000) {
  const outcome = settle(promise);
  await vi.advanceTimersByTimeAsync(ms);
  return outcome;
}

function errorOf(outcome: { ok: boolean; error?: unknown }): McpError {
  expect(outcome.ok).toBe(false);
  expect(outcome.error).toBeInstanceOf(McpError);
  return outcome.error as McpError;
}

describe('request construction', () => {
  it('builds the URL from the constant base, the path, and the encoded query', async () => {
    fm.route({
      match: onPath('/records'),
      respond: () => jsonResponse(hitsBody, { bucket: 'search' }),
    });
    await http.request(searchReq(), readStatus, ctx);
    const request = fm.calls[0]?.request;
    expect(request?.url).toBe(
      'https://zenodo.org/api/records?q=climate+model&sort=bestmatch&page=1&size=10',
    );
    expect(request?.method).toBe('GET');
  });

  it('sends Accept and User-Agent, and no Authorization without a token', async () => {
    fm.route({ match: onPath('/records/22705923'), respond: () => jsonResponse({}) });
    await http.request(recordReq(), readStatus, ctx);
    const headers = fm.calls[0]?.request.headers;
    expect(headers?.get('accept')).toBe(RDM);
    expect(headers?.get('user-agent')).toBe(UA);
    expect(headers?.get('authorization')).toBeNull();
    expect(headers?.get('range')).toBeNull();
  });

  it('sends a bearer token when one is configured', async () => {
    const authed = new ZenodoHttp({ accessToken: 'tok-123', userAgent: UA });
    fm.route({ match: onPath('/records/22705923'), respond: () => jsonResponse({}) });
    try {
      await authed.request(recordReq(), readStatus, ctx);
    } finally {
      authed.dispose();
    }
    expect(fm.calls[0]?.request.headers.get('authorization')).toBe('Bearer tok-123');
  });

  it('sends the Range header and a manual redirect mode when asked', async () => {
    fm.route({
      match: onPath('/records/1/files/a.csv/content'),
      respond: () => textResponse('id', 206, { 'content-range': 'bytes 0-1/2' }),
    });
    fm.route({
      match: onPath('/records/1/versions/latest'),
      respond: () => textResponse(null, 301, { location: 'https://zenodo.org/api/records/2' }),
    });
    await http.request(
      {
        ...recordReq('1', { endpoint: 'other', okStatuses: [206] }),
        path: '/records/1/files/a.csv/content',
        range: 'bytes=0-1',
        attemptMs: CONTENT_ATTEMPT_MS,
      },
      readStatus,
      ctx,
    );
    await http.request(
      {
        ...recordReq('1', { okStatuses: [301] }),
        path: '/records/1/versions/latest',
        redirect: 'manual',
      },
      readStatus,
      ctx,
    );
    expect(fm.calls[0]?.request.headers.get('range')).toBe('bytes=0-1');
    expect(fm.calls[1]?.request.redirect).toBe('manual');
  });
});

describe('redirects', () => {
  it('follows a zenodo.org redirect itself, with the token still attached', async () => {
    const authed = new ZenodoHttp({ accessToken: 'tok-123', userAgent: UA });
    fm.route(
      {
        match: onPath('/records/591564'),
        respond: () =>
          textResponse(null, 302, { location: 'https://zenodo.org/api/records/22705923' }),
      },
      { match: onPath('/records/22705923'), respond: () => jsonResponse({ id: '22705923' }) },
    );
    try {
      const body = await authed.request(
        recordReq('591564'),
        (res) => readJson<{ id: string }>(res),
        ctx,
      );
      expect(body).toEqual({ id: '22705923' });
    } finally {
      authed.dispose();
    }
    expect(fm.calls.map((c) => c.request.url)).toEqual([
      'https://zenodo.org/api/records/591564',
      'https://zenodo.org/api/records/22705923',
    ]);
    for (const call of fm.calls) {
      expect(call.request.redirect).toBe('manual');
      expect(call.request.headers.get('authorization')).toBe('Bearer tok-123');
    }
  });

  it('resolves a relative Location against the request URL', async () => {
    fm.route(
      {
        match: onPath('/records/591564'),
        respond: () => textResponse(null, 301, { location: '/api/records/22705923' }),
      },
      { match: onPath('/records/22705923'), respond: () => jsonResponse({}) },
    );
    expect(await http.request(recordReq('591564'), readStatus, ctx)).toBe(200);
    expect(fm.calls).toHaveLength(2);
  });

  it.each([
    'https://attacker.example/api/records/1',
    'http://zenodo.org/api/records/1',
    'https://zenodo.org:8443/api/records/1',
    'https://zenodo.org.attacker.example/api/records/1',
    '//attacker.example/api/records/1',
  ])('refuses a redirect to %s without requesting it', async (location) => {
    const authed = new ZenodoHttp({ accessToken: 'tok-123', userAgent: UA });
    fm.route({ match: onPath('/records/1'), respond: () => textResponse(null, 302, { location }) });
    try {
      const err = errorOf(await drive(authed.request(recordReq('1'), readStatus, ctx)));
      expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(err.message).toContain('off zenodo.org');
      expect(err.data).toMatchObject({ status: 302, retryable: false });
    } finally {
      authed.dispose();
    }
    expect(fm.calls).toHaveLength(1);
  });

  it('stops after three redirects', async () => {
    fm.route({
      match: onPath('/records/1'),
      respond: () => textResponse(null, 302, { location: 'https://zenodo.org/api/records/1' }),
    });
    const err = errorOf(await drive(http.request(recordReq('1'), readStatus, ctx)));
    expect(err.message).toContain('more than 3 times');
    expect(fm.calls).toHaveLength(4);
  });
});

describe('accept-lists', () => {
  it.each([206, 301, 302, 403, 404, 410, 416])(
    'returns HTTP %i as a result when the call accepts it',
    async (status) => {
      fm.route({
        match: onPath('/records/1'),
        respond: () => textResponse(status === 301 || status === 302 ? null : '{}', status),
      });
      const result = await http.request(recordReq('1', { okStatuses: [status] }), readStatus, ctx);
      expect(result).toBe(status);
      expect(fm.calls).toHaveLength(1);
    },
  );

  it('maps a 4xx outside the accept-list to an error without retrying', async () => {
    fm.route({
      match: onPath('/records'),
      respond: () =>
        jsonResponse(
          { errors: [{ field: '_schema', messages: ["Invalid sort option 'bogus'."] }] },
          { status: 400, bucket: 'search' },
        ),
    });
    const err = errorOf(await drive(http.request(searchReq(), readStatus, ctx)));
    expect(err.data).toMatchObject({ status: 400, operation: 'searchRecords' });
    expect(err.code).not.toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(fm.calls).toHaveLength(1);
  });

  it('drops the Retry-After Zenodo sends on every response from a non-429 error', async () => {
    fm.route({
      match: onPath('/records'),
      respond: () => jsonResponse({ status: 400 }, { status: 400, bucket: 'search' }),
    });
    const err = errorOf(await drive(http.request(searchReq(), readStatus, ctx)));
    expect(err.data).not.toHaveProperty('retryAfter');
    expect(err.data).toMatchObject({ status: 400, operation: 'searchRecords' });
    expect(fm.calls).toHaveLength(1);
  });

  it('maps a 404 outside the accept-list to NotFound', async () => {
    fm.route({
      match: onPath('/funders'),
      respond: () => jsonResponse({ status: 404 }, { status: 404 }),
    });
    const err = errorOf(
      await drive(
        http.request(
          { ...recordReq(), path: '/funders', endpoint: 'other', okStatuses: [200] },
          readStatus,
          ctx,
        ),
      ),
    );
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(fm.calls).toHaveLength(1);
  });
});

describe('retry matrix — HTTP 500', () => {
  it('never retries a search 500 and types it query_failed', async () => {
    fm.route({
      match: onPath('/records'),
      respond: () => jsonResponse({}, { status: 500, bucket: 'search' }),
    });
    const err = errorOf(await drive(http.request(searchReq(), readStatus, ctx)));
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data).toMatchObject({
      reason: 'query_failed',
      status: 500,
      retryable: false,
      recovery: { hint: hint('query_failed') },
    });
    expect(fm.calls).toHaveLength(1);
  });

  it('never retries a DOI-lookup 500 and types it record_unavailable', async () => {
    fm.route({
      match: onPath('/records'),
      respond: () => jsonResponse({}, { status: 500, bucket: 'search' }),
    });
    const err = errorOf(
      await drive(http.request(searchReq({ endpoint: 'doi_lookup' }), readStatus, ctx)),
    );
    expect(err.data).toMatchObject({ reason: 'record_unavailable', retryable: false });
    expect(fm.calls).toHaveLength(1);
  });

  it('retries a record 500 once, then types it record_unavailable', async () => {
    fm.route({
      match: onPath('/records/1'),
      respond: () => textResponse('Internal Server Error', 500),
    });
    const err = errorOf(await drive(http.request(recordReq('1'), readStatus, ctx)));
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data).toMatchObject({
      reason: 'record_unavailable',
      status: 500,
      retryAttempts: 2,
      recovery: { hint: hint('record_unavailable') },
    });
    expect(fm.calls).toHaveLength(2);
  });

  it('recovers when the record retry succeeds', async () => {
    fm.route(
      { match: onPath('/records/1'), once: true, respond: () => textResponse('oops', 500) },
      { match: onPath('/records/1'), respond: () => jsonResponse({ id: '1' }) },
    );
    const outcome = await drive(http.request(recordReq('1'), readStatus, ctx));
    expect(outcome).toEqual({ ok: true, value: 200 });
    expect(fm.calls).toHaveLength(2);
  });

  it('retries a /versions 500 once', async () => {
    fm.route({ match: onPath('/records/1/versions'), respond: () => textResponse('oops', 500) });
    const err = errorOf(
      await drive(
        http.request(
          {
            ...recordReq('1'),
            path: '/records/1/versions',
            endpoint: 'versions',
            okStatuses: [200, 404],
          },
          readStatus,
          ctx,
        ),
      ),
    );
    expect(err.data).toMatchObject({ reason: 'record_unavailable', retryAttempts: 2 });
    expect(fm.calls).toHaveLength(2);
  });

  it('retries a 500 on other endpoints once, without a typed reason', async () => {
    fm.route({
      match: onPath('/records/1/files/x.csv/content'),
      respond: () => textResponse('oops', 500),
    });
    const err = errorOf(
      await drive(
        http.request(
          {
            ...recordReq('1'),
            path: '/records/1/files/x.csv/content',
            endpoint: 'other',
            okStatuses: [200],
          },
          readStatus,
          ctx,
        ),
      ),
    );
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data?.reason).toBeUndefined();
    expect(fm.calls).toHaveLength(2);
  });

  const archiveReq = (): ZenodoRequest => ({
    ...recordReq('22917909'),
    path: '/records/22917909/files/Metadaten.zip/container',
    accept: 'application/json',
    endpoint: 'archive',
    okStatuses: [200, 404],
    operation: 'getContainer',
    downloadUrl: 'https://zenodo.org/api/records/22917909/files/Metadaten.zip/content',
  });

  it('retries an archive 500 once, then types it archive_unavailable naming the download URL', async () => {
    fm.route({
      match: onPath('/records/22917909/files/Metadaten.zip/container'),
      respond: () => jsonResponse({ status: 500 }, { status: 500 }),
    });
    const err = errorOf(await drive(http.request(archiveReq(), readStatus, ctx)));
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data).toMatchObject({
      reason: 'archive_unavailable',
      status: 500,
      retryAttempts: 2,
      recovery: { hint: hint('archive_unavailable') },
    });
    expect(err.data).not.toHaveProperty('retryAfter');
    expect(err.message).toContain(
      'download it from https://zenodo.org/api/records/22917909/files/Metadaten.zip/content',
    );
    expect(fm.calls).toHaveLength(2);
  });

  it('never retries an archive attempt timeout and types it archive_unavailable', async () => {
    fm.route({
      match: onPath('/records/22917909/files/Metadaten.zip/container'),
      respond: hangUntilAborted,
    });
    const err = errorOf(await drive(http.request(archiveReq(), readStatus, ctx)));
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data).toMatchObject({ reason: 'archive_unavailable', retryable: false });
    expect(fm.calls).toHaveLength(1);
  });
});

describe('retry matrix — 502/503/504, network errors, timeouts', () => {
  it.each([502, 503])('retries a search %i once', async (status) => {
    fm.route(
      {
        match: onPath('/records'),
        once: true,
        respond: () => jsonResponse({}, { status, bucket: 'search' }),
      },
      { match: onPath('/records'), respond: () => jsonResponse(hitsBody, { bucket: 'search' }) },
    );
    expect(await drive(http.request(searchReq(), readStatus, ctx))).toEqual({
      ok: true,
      value: 200,
    });
    expect(fm.calls).toHaveLength(2);
  });

  it('gives up after one retry of a 503, keeping the status', async () => {
    fm.route({ match: onPath('/records/1'), respond: () => textResponse('busy', 503) });
    const err = errorOf(await drive(http.request(recordReq('1'), readStatus, ctx)));
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data).toMatchObject({ status: 503, retryAttempts: 2 });
    expect(fm.calls).toHaveLength(2);
  });

  it('retries a fast 504 (<10 s) once', async () => {
    fm.route(
      {
        match: onPath('/records/1'),
        once: true,
        respond: respondAfter(2_000, () => textResponse(GATEWAY_TIMEOUT_HTML, 504)),
      },
      { match: onPath('/records/1'), respond: () => jsonResponse({ id: '1' }) },
    );
    expect(await drive(http.request(recordReq('1'), readStatus, ctx))).toEqual({
      ok: true,
      value: 200,
    });
    expect(fm.calls).toHaveLength(2);
  });

  it('never retries a slow 504 on a record GET and types it record_unavailable', async () => {
    fm.route({
      match: onPath('/records/2594613'),
      respond: respondAfter(30_500, () => textResponse(GATEWAY_TIMEOUT_HTML, 504)),
    });
    const err = errorOf(await drive(http.request(recordReq('2594613'), readStatus, ctx)));
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data).toMatchObject({
      reason: 'record_unavailable',
      retryable: false,
      recovery: { hint: hint('record_unavailable') },
    });
    expect(fm.calls).toHaveLength(1);
  });

  it('never retries a slow 504 on search and types it upstream_timeout', async () => {
    fm.route({
      match: onPath('/records'),
      respond: respondAfter(21_000, () => textResponse(GATEWAY_TIMEOUT_HTML, 504)),
    });
    const err = errorOf(await drive(http.request(searchReq(), readStatus, ctx)));
    expect(err.code).toBe(JsonRpcErrorCode.Timeout);
    expect(err.data).toMatchObject({
      reason: 'upstream_timeout',
      retryable: false,
      recovery: { hint: hint('upstream_timeout') },
    });
    expect(fm.calls).toHaveLength(1);
  });

  it('never retries a slow 504 on /versions and types it upstream_timeout', async () => {
    fm.route({
      match: onPath('/records/7793716/versions'),
      respond: respondAfter(12_000, () => textResponse(GATEWAY_TIMEOUT_HTML, 504)),
    });
    const err = errorOf(
      await drive(
        http.request(
          {
            ...recordReq('7793716'),
            path: '/records/7793716/versions',
            endpoint: 'versions',
            okStatuses: [200, 404],
          },
          readStatus,
          ctx,
        ),
      ),
    );
    expect(err.code).toBe(JsonRpcErrorCode.Timeout);
    expect(err.data).toMatchObject({ reason: 'upstream_timeout', retryable: false });
    expect(fm.calls).toHaveLength(1);
  });

  it('never retries an attempt timeout on a record GET (45 s budget)', async () => {
    fm.route({ match: onPath('/records/1'), respond: hangUntilAborted });
    const pending = settle(http.request(recordReq('1'), readStatus, ctx));
    await vi.advanceTimersByTimeAsync(JSON_ATTEMPT_MS - 1);
    expect(fm.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    const err = errorOf(await pending);
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data).toMatchObject({ reason: 'record_unavailable', retryable: false });
    expect(fm.calls).toHaveLength(1);
  });

  it('never retries a search attempt timeout and types it upstream_timeout', async () => {
    fm.route({ match: onPath('/records'), respond: hangUntilAborted });
    const err = errorOf(await drive(http.request(searchReq(), readStatus, ctx)));
    expect(err.code).toBe(JsonRpcErrorCode.Timeout);
    expect(err.data).toMatchObject({ reason: 'upstream_timeout', retryable: false });
    expect(fm.calls).toHaveLength(1);
  });

  it('times a content read out at 20 s without retrying', async () => {
    fm.route({ match: onPath('/records/1/files/a.csv/content'), respond: hangUntilAborted });
    const pending = settle(
      http.request(
        {
          ...recordReq('1'),
          path: '/records/1/files/a.csv/content',
          endpoint: 'other',
          okStatuses: [200, 206],
          attemptMs: CONTENT_ATTEMPT_MS,
        },
        readStatus,
        ctx,
      ),
    );
    await vi.advanceTimersByTimeAsync(CONTENT_ATTEMPT_MS);
    const err = errorOf(await pending);
    expect(err.code).toBe(JsonRpcErrorCode.Timeout);
    expect(err.data).toMatchObject({ retryable: false });
    expect(fm.calls).toHaveLength(1);
  });

  it('maps a ladder deadline that expires during the retry to upstream_timeout', async () => {
    fm.route(
      {
        match: onPath('/records'),
        once: true,
        respond: respondAfter(40_000, () => jsonResponse({}, { status: 503, bucket: 'search' })),
      },
      { match: onPath('/records'), respond: hangUntilAborted },
    );
    const err = errorOf(await drive(http.request(searchReq(), readStatus, ctx)));
    expect(err.code).toBe(JsonRpcErrorCode.Timeout);
    expect(err.data).toMatchObject({ reason: 'upstream_timeout' });
    expect(fm.calls).toHaveLength(2);
  });

  it('retries a network error once', async () => {
    let first = true;
    fm.route({
      match: onPath('/records/1'),
      respond: () => {
        if (first) {
          first = false;
          throw new TypeError('fetch failed');
        }
        return jsonResponse({ id: '1' });
      },
    });
    expect(await drive(http.request(recordReq('1'), readStatus, ctx))).toEqual({
      ok: true,
      value: 200,
    });
    expect(fm.calls).toHaveLength(2);
  });

  it('surfaces a caller cancellation as-is, without retrying', async () => {
    const controller = new AbortController();
    const cancelCtx = createMockContext({ errors: CONTRACT, signal: controller.signal });
    fm.route({ match: onPath('/records/1'), respond: hangUntilAborted });
    const pending = settle(http.request(recordReq('1'), readStatus, cancelCtx));
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await vi.advanceTimersByTimeAsync(5_000);
    const outcome = await pending;
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).not.toBeInstanceOf(McpError);
    expect(fm.calls).toHaveLength(1);
  });

  it('retries a 2xx HTML edge page once as a transient fault', async () => {
    fm.route({
      match: onPath('/records/1'),
      respond: () => textResponse('<!DOCTYPE html><html><body>Maintenance</body></html>', 200),
    });
    const err = errorOf(await drive(http.request(recordReq('1'), (res) => readJson(res), ctx)));
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.message).toMatch(/HTML page/);
    expect(fm.calls).toHaveLength(2);
  });

  it('retries an unparseable 2xx body once as a transient fault', async () => {
    fm.route(
      { match: onPath('/records/1'), once: true, respond: () => textResponse('{"truncated', 200) },
      { match: onPath('/records/1'), respond: () => jsonResponse({ id: '1' }) },
    );
    const outcome = await drive(
      http.request(recordReq('1'), (res) => readJson<{ id: string }>(res), ctx),
    );
    expect(outcome).toEqual({ ok: true, value: { id: '1' } });
    expect(fm.calls).toHaveLength(2);
  });
});

describe('retry matrix — 429', () => {
  it('fails fast on a 429 whose Retry-After exceeds 15 s', async () => {
    fm.route({
      match: onPath('/records/1'),
      respond: () => textResponse('{}', 429, { ...rateHeaders('general', 0, 60) }),
    });
    const err = errorOf(await drive(http.request(recordReq('1'), readStatus, ctx)));
    expect(err.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(err.data).toMatchObject({
      reason: 'rate_limited',
      status: 429,
      retryAfter: 60,
      recovery: { hint: hint('rate_limited') },
    });
    expect(fm.calls).toHaveLength(1);
  });

  it('waits out a short Retry-After and retries once', async () => {
    fm.route(
      {
        match: onPath('/records/1'),
        once: true,
        respond: () => textResponse('{}', 429, { ...rateHeaders('general', 0, 2) }),
      },
      { match: onPath('/records/1'), respond: () => jsonResponse({ id: '1' }) },
    );
    const pending = settle(http.request(recordReq('1'), readStatus, ctx));
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fm.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ ok: true, value: 200 });
    expect(fm.calls).toHaveLength(2);
  });

  it('derives retryAfter from X-RateLimit-Reset when Retry-After is absent', async () => {
    const reset = Math.floor(NOW.getTime() / 1000) + 40;
    fm.route({
      match: onPath('/records/1'),
      respond: () =>
        new Response('{}', {
          status: 429,
          headers: {
            'x-ratelimit-limit': '133',
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(reset),
          },
        }),
    });
    const err = errorOf(await drive(http.request(recordReq('1'), readStatus, ctx)));
    expect(err.data).toMatchObject({ reason: 'rate_limited', retryAfter: 40 });
  });
});

describe('header gate', () => {
  it('ignores Retry-After on a 200', async () => {
    fm.route({ match: onPath('/records/1'), respond: () => jsonResponse({ id: '1' }) });
    await http.request(recordReq('1'), readStatus, ctx);
    await http.request(recordReq('1'), readStatus, ctx);
    expect(fm.calls).toHaveLength(2);
  });

  it('refuses to dispatch while the advertised window is spent, then resumes after reset', async () => {
    fm.route({
      match: onPath('/records/1'),
      respond: () => jsonResponse({ id: '1' }, { headers: rateHeaders('general', 0, 30) }),
    });
    await http.request(recordReq('1'), readStatus, ctx);

    const err = errorOf(await settle(http.request(recordReq('1'), readStatus, ctx)));
    expect(err.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(err.data).toMatchObject({
      reason: 'rate_limited',
      retryAfter: 30,
      recovery: { hint: hint('rate_limited') },
    });
    expect(fm.calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(30_001);
    fm.reset();
    fm.route({ match: onPath('/records/1'), respond: () => jsonResponse({ id: '1' }) });
    await expect(http.request(recordReq('1'), readStatus, ctx)).resolves.toBe(200);
    expect(fm.calls).toHaveLength(1);
  });

  it('gates only the bucket whose window is spent', async () => {
    fm.route(
      {
        match: onPath('/records'),
        respond: () =>
          jsonResponse(hitsBody, { bucket: 'search', headers: rateHeaders('search', 0, 45) }),
      },
      { match: onPath('/records/1'), respond: () => jsonResponse({ id: '1' }) },
    );
    await http.request(searchReq(), readStatus, ctx);

    const gated = errorOf(await settle(http.request(searchReq(), readStatus, ctx)));
    expect(gated.data).toMatchObject({ reason: 'rate_limited', retryAfter: 45 });
    await expect(http.request(recordReq('1'), readStatus, ctx)).resolves.toBe(200);
    expect(fm.calls.map((c) => new URL(c.request.url).pathname)).toEqual([
      '/api/records',
      '/api/records/1',
    ]);
  });

  it('tracks the headers of error responses too (a search 500 spends the window)', async () => {
    fm.route({
      match: onPath('/records'),
      respond: () =>
        jsonResponse({}, { status: 500, bucket: 'search', headers: rateHeaders('search', 0, 20) }),
    });
    errorOf(await drive(http.request(searchReq(), readStatus, ctx), 0));
    const gated = errorOf(await settle(http.request(searchReq(), readStatus, ctx)));
    expect(gated.data).toMatchObject({ reason: 'rate_limited', retryAfter: 20 });
    expect(fm.calls).toHaveLength(1);
  });
});

describe('pacers', () => {
  it('lets general traffic through while a search 429 holds the search gate shut', async () => {
    fm.route(
      {
        match: onPath('/records'),
        respond: () =>
          jsonResponse(
            {},
            { status: 429, bucket: 'search', headers: rateHeaders('search', 0, 60) },
          ),
      },
      { match: onPath('/records/22705923'), respond: () => jsonResponse({ id: '22705923' }) },
    );
    const limited = errorOf(await settle(http.request(searchReq(), readStatus, ctx)));
    expect(limited.data).toMatchObject({ reason: 'rate_limited', retryAfter: 60 });

    await expect(http.request(recordReq(), readStatus, ctx)).resolves.toBe(200);
    await expect(http.request(recordReq(), readStatus, ctx)).resolves.toBe(200);

    const shed = errorOf(await settle(http.request(searchReq(), readStatus, ctx)));
    expect(shed.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(shed.data).toMatchObject({
      reason: 'rate_limited',
      retryAfter: 60,
      recovery: { hint: hint('rate_limited') },
    });
    expect(fm.calls.map((c) => new URL(c.request.url).pathname)).toEqual([
      '/api/records',
      '/api/records/22705923',
      '/api/records/22705923',
    ]);
  });

  it('sheds the 26th search in a minute as rate_limited instead of queueing past the wait budget', async () => {
    fm.route({
      match: onPath('/records'),
      respond: () => jsonResponse(hitsBody, { bucket: 'search' }),
    });
    for (let i = 0; i < 25; i++) await http.request(searchReq(), readStatus, ctx);
    const shed = errorOf(await settle(http.request(searchReq(), readStatus, ctx)));
    expect(shed.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(shed.data).toMatchObject({ reason: 'rate_limited', retryAfter: 60 });
    expect((shed.cause as McpError).data?.reason).toBe('pacer_shed');
    expect(fm.calls).toHaveLength(25);

    await vi.advanceTimersByTimeAsync(60_000);
    await expect(http.request(searchReq(), readStatus, ctx)).resolves.toBe(200);
  });

  it('rejects queued work after dispose', async () => {
    http.dispose();
    const outcome = await settle(http.request(recordReq('1'), readStatus, ctx));
    expect(outcome.ok).toBe(false);
    expect(fm.calls).toHaveLength(0);
  });
});

describe('readJson', () => {
  it('parses a JSON body', async () => {
    await expect(readJson(jsonResponse({ a: 1 }))).resolves.toEqual({ a: 1 });
  });

  it('rejects an HTML page on a 2xx as an edge error page', async () => {
    await expect(readJson(textResponse('<html><body>x</body></html>', 200))).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { status: 200 },
    });
  });

  it('rejects an unparseable body as ServiceUnavailable, not SerializationError', async () => {
    await expect(readJson(textResponse('not json', 200))).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
    });
  });

  it('refuses a body over 32 MiB without buffering the rest of it', async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(0x20);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 64) controller.enqueue(chunk);
        else controller.close();
      },
    });
    await expect(readJson(new Response(body))).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { retryable: false },
    });
    expect(sent).toBeLessThan(40);
  });
});

describe('readCapped', () => {
  function chunked(chunks: string[]) {
    let cancelled = false;
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks[i++];
        if (next === undefined) controller.close();
        else controller.enqueue(new TextEncoder().encode(next));
      },
      cancel() {
        cancelled = true;
      },
    });
    return { response: new Response(stream), wasCancelled: () => cancelled };
  }

  it('reads a short body whole', async () => {
    const { response, wasCancelled } = chunked(['ab', 'cd']);
    const { bytes, more } = await readCapped(response, 10);
    expect(new TextDecoder().decode(bytes)).toBe('abcd');
    expect(more).toBe(false);
    expect(wasCancelled()).toBe(false);
  });

  it('stops at the cap mid-chunk and cancels the stream', async () => {
    const { response, wasCancelled } = chunked(['abc', 'def', 'ghi']);
    const { bytes, more } = await readCapped(response, 5);
    expect(new TextDecoder().decode(bytes)).toBe('abcde');
    expect(more).toBe(true);
    expect(wasCancelled()).toBe(true);
  });

  it('skips leading bytes across chunks before keeping any', async () => {
    const { response } = chunked(['abc', 'def', 'ghi']);
    const { bytes, more } = await readCapped(response, 3, 4);
    expect(new TextDecoder().decode(bytes)).toBe('efg');
    expect(more).toBe(true);
  });

  it('returns nothing for a bodiless response', async () => {
    expect(await readCapped(new Response(null, { status: 204 }), 10)).toEqual({
      bytes: new Uint8Array(0),
      more: false,
    });
  });
});
