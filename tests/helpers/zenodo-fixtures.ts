/**
 * @fileoverview Shared test fixtures for the Zenodo service and tools: loaders for
 * the trimmed upstream bodies captured from zenodo.org (tests/fixtures/zenodo),
 * response builders carrying Zenodo's rate-limit headers, and request matchers for
 * `createFetchMock` routes.
 * @module tests/helpers/zenodo-fixtures
 */

import { readFileSync } from 'node:fs';
import type { RawRecord } from '@/services/zenodo/types.js';

const FIXTURE_DIR = new URL('../fixtures/zenodo/', import.meta.url);

/** Reads a fixture file as text. */
export function fixtureText(name: string): string {
  return readFileSync(new URL(name, FIXTURE_DIR), 'utf8');
}

/** Reads a fixture file as raw bytes (file content captured byte-for-byte). */
export function fixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(name, FIXTURE_DIR)));
}

/** Parses a JSON fixture. Each call returns a fresh copy, safe to mutate. */
export function fixture<T>(name: string): T {
  return JSON.parse(fixtureText(name)) as T;
}

/** Record 22705923 — scikit-learn 1.9.1, latest version of concept 591564. */
export const recordFixture = () => fixture<RawRecord>('record-22705923.json');

export const RDM = 'application/vnd.inveniordm.v1+json';

/**
 * Zenodo's rate-limit headers for one bucket. `Retry-After` rides every response,
 * 200s included (it counts seconds to the window reset), so it is set here too.
 */
export function rateHeaders(
  bucket: 'general' | 'search',
  remaining = bucket === 'search' ? 29 : 132,
  resetInSec = 60,
): Record<string, string> {
  return {
    'x-ratelimit-limit': bucket === 'search' ? '30' : '133',
    'x-ratelimit-remaining': String(remaining),
    'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + resetInSec),
    'retry-after': String(resetInSec),
  };
}

/**
 * A JSON response with rate-limit headers for `bucket` (general by default).
 *
 * Register it on a fetch-mock route through a factory (`respond: () => jsonResponse(…)`),
 * never as a static `Response`: the mock clones a static response per call, the
 * clone is a stream tee, and `body.cancel()` on one tee branch never resolves while
 * the other branch stays open — the service's `await res.body?.cancel()` would hang.
 */
export function jsonResponse(
  body: unknown,
  init: { bucket?: 'general' | 'search'; headers?: Record<string, string>; status?: number } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      'content-type': 'application/json',
      ...rateHeaders(init.bucket ?? 'general'),
      ...init.headers,
    },
  });
}

/** A plain-text (or HTML) response with general-bucket rate-limit headers. */
export function textResponse(
  body: string | null,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, { status, headers: { ...rateHeaders('general'), ...headers } });
}

/** Zenodo's gateway timeout page — an HTML body, not JSON. */
export const GATEWAY_TIMEOUT_HTML =
  "<html><body><h1>504 Gateway Time-out</h1>\nThe server didn't respond in time.\n</body></html>";

/**
 * Matches a request by `/api` path (exact, as sent — percent-encoding included) and,
 * optionally, by Accept header.
 */
export function onPath(path: string, accept?: string): (request: Request) => boolean {
  return (request) =>
    new URL(request.url).pathname === `/api${path}` &&
    (accept === undefined || request.headers.get('accept') === accept);
}

/** The query parameters a captured request carried, as ordered pairs. */
export function queryOf(request: Request): [string, string][] {
  return [...new URL(request.url).searchParams.entries()];
}

/** A responder that never answers, rejecting only when the request is aborted. */
export function hangUntilAborted(request: Request): Promise<Response> {
  return new Promise((_resolve, reject) => {
    request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
  });
}

/** A responder that answers with `make()` after `ms` (drive it with fake timers). */
export function respondAfter(ms: number, make: () => Response): () => Promise<Response> {
  return () =>
    new Promise((resolve) => {
      setTimeout(() => resolve(make()), ms);
    });
}

/** Adds `count` synthetic file entries to a raw record (for the 25-file display cap). */
export function withFiles(record: RawRecord, count: number): RawRecord {
  const entries: NonNullable<RawRecord['files']>['entries'] = {};
  for (let i = 1; i <= count; i++) {
    const key = `data/part-${String(i).padStart(3, '0')}.csv`;
    entries[key] = {
      key,
      size: 1000 + i,
      mimetype: 'text/csv',
      checksum: `md5:${i.toString(16).padStart(32, '0')}`,
    };
  }
  return {
    ...record,
    files: { enabled: true, order: [], count, total_bytes: count * 1000, entries },
  };
}

/** One manifest entry as {@link withEntries} writes it (`checksum` is the raw `md5:<hex>` form). */
export interface ManifestEntry {
  checksum?: string;
  key: string;
  mimetype?: string;
  size?: number;
}

/** Replaces a raw record's manifest with `entries` (count and total bytes derived from them). */
export function withEntries(record: RawRecord, entries: ManifestEntry[]): RawRecord {
  return {
    ...record,
    files: {
      enabled: true,
      order: [],
      count: entries.length,
      total_bytes: entries.reduce((sum, e) => sum + (e.size ?? 0), 0),
      entries: Object.fromEntries(entries.map((e) => [e.key, e])),
    },
  };
}

/** A search/versions list body (`{ hits: { hits, total } }`), with optional aggregations. */
export function hitsBody(
  hits: RawRecord[],
  total = hits.length,
  aggregations?: Record<string, unknown>,
): Record<string, unknown> {
  return { hits: { hits, total }, ...(aggregations ? { aggregations } : {}) };
}

/**
 * A binary-safe body response with general-bucket rate-limit headers (for BOM, NUL,
 * and multibyte file content). Register through a factory, as with {@link jsonResponse}.
 */
export function bytesResponse(
  body: Uint8Array | string,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  return new Response(bytes, { status, headers: { ...rateHeaders('general'), ...headers } });
}

/** A 206 for `bytes` taken from `offset` of a `total`-byte file, with its Content-Range. */
export function rangeResponse(bytes: Uint8Array | string, offset: number, total: number): Response {
  const body = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  return bytesResponse(body, 206, {
    'content-range': `bytes ${offset}-${offset + body.length - 1}/${total}`,
  });
}

/**
 * A `/container` body cut at Zenodo's 1,000-node cap: `files` members plus
 * `directories` directory nodes, `truncated: true` when they reach 1,000 (the
 * scikit-learn 1.9.1 ZIP listed 857 files + 143 directories). Upstream `total`
 * counts the listed files only.
 */
export function containerBody(
  files: number,
  directories: number,
  prefix = 'scikit-learn-1.9.1',
): Record<string, unknown> {
  return {
    entries: Array.from({ length: files }, (_, i) => ({
      key: `${prefix}/sklearn/module_${String(i).padStart(3, '0')}.py`,
      size: 1000 + i,
      compressed_size: 400 + i,
      mimetype: 'text/x-python',
      crc: i,
    })),
    directories: Array.from({ length: directories }, (_, i) => ({ key: `${prefix}/dir_${i}/` })),
    total: files,
    truncated: files + directories >= 1000,
  };
}

/**
 * Settles a promise (or a handler's `T | Promise<T>`) into a value-or-error record,
 * for assertions after fake timers advance.
 */
export async function settle<T>(
  promise: Promise<T> | T,
): Promise<{ error: unknown; ok: false } | { ok: true; value: T }> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}
