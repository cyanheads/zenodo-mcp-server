/**
 * @fileoverview The single fetch boundary to the Zenodo REST API. Per-call status
 * accept-lists (206/301/302/403/404/410/416 are outcomes here, not errors), the
 * rate-limit header gate, two pacers (search and general buckets), and the retry
 * matrix. Only paths the service builds are fetched, against a constant base URL.
 * @module services/zenodo/http
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  JsonRpcErrorCode,
  McpError,
  rateLimited,
  serviceUnavailable,
  timeout,
} from '@cyanheads/mcp-ts-core/errors';
import {
  createPacer,
  httpErrorFromResponse,
  type Pacer,
  type RetryAttempt,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';

const BASE_URL = 'https://zenodo.org/api';

/** Upstream rate-limit bucket. `search` is the record-search list only (30/min). */
export type Bucket = 'search' | 'general';

/**
 * Which row of the retry matrix a call follows: `search` (record search),
 * `doi_lookup` (the server-built DOI search), `record` (record GET), `versions`
 * (`/versions`), `archive` (a ZIP's `/container` listing or member read), `other`
 * (file content, `versions/latest`, citations, vocabularies).
 */
export type EndpointKind = 'search' | 'doi_lookup' | 'record' | 'versions' | 'archive' | 'other';

/** One upstream request as the service builds it. */
export interface ZenodoRequest {
  accept: string;
  /** Per-attempt time budget (capped by the ladder's remaining budget). */
  attemptMs: number;
  bucket: Bucket;
  /** `archive` endpoints: the archive's download URL, named in a typed failure. */
  downloadUrl?: string;
  endpoint: EndpointKind;
  /** Statuses returned to the caller as results rather than mapped to errors. */
  okStatuses: readonly number[];
  /** Log label. */
  operation: string;
  /** Path under `/api`, starting with `/`, already percent-encoded. */
  path: string;
  query?: readonly (readonly [string, string])[];
  range?: string;
  redirect?: 'follow' | 'manual';
}

/** Per-attempt budgets. Multi-thousand-file record GETs legitimately take 32–34 s. */
export const JSON_ATTEMPT_MS = 45_000;
export const CONTENT_ATTEMPT_MS = 20_000;

const LADDER_DEADLINE_MS = 50_000;
const PACER_MAX_WAIT_MS = 20_000;
/** A 504 slower than this is Zenodo's ~30 s gateway cutoff — deterministic, never retried. */
const SLOW_GATEWAY_MS = 10_000;

interface BucketHeaders {
  limit?: number;
  remaining?: number;
  /** Epoch seconds. */
  resetAt?: number;
}

function headerNumber(headers: Headers, name: string): number | undefined {
  const value = headers.get(name);
  if (value === null || value.trim() === '') return;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function looksLikeHtml(text: string): boolean {
  return /^\s*<(?:!doctype\s+html|html[\s>]|head[\s>]|body[\s>])/i.test(text);
}

/** Cancels a response body that will not be read, releasing the connection. */
export async function discardBody(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => undefined);
}

/** Reads a JSON body. An HTML page or unparseable body on a 2xx is a transient upstream fault. */
export async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (res.ok && looksLikeHtml(text)) {
    throw serviceUnavailable('Zenodo returned an HTML page instead of JSON (edge error page).', {
      status: res.status,
    });
  }
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw serviceUnavailable(
      'Zenodo returned a body that is not valid JSON.',
      { status: res.status },
      { cause },
    );
  }
}

/**
 * Streams a body, keeping at most `maxBytes` after skipping `skipBytes`, and
 * cancels the stream as soon as the cap is passed. `more` is true when bytes
 * remained past the cap.
 */
export async function readCapped(
  res: Response,
  maxBytes: number,
  skipBytes = 0,
): Promise<{ bytes: Uint8Array; more: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(0), more: false };
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let toSkip = skipBytes;
  let more = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    let chunk = value;
    if (toSkip > 0) {
      const drop = Math.min(toSkip, chunk.length);
      toSkip -= drop;
      chunk = chunk.subarray(drop);
      if (chunk.length === 0) continue;
    }
    if (kept + chunk.length > maxBytes) {
      chunks.push(chunk.subarray(0, maxBytes - kept));
      kept = maxBytes;
      more = true;
      break;
    }
    chunks.push(chunk);
    kept += chunk.length;
  }
  if (more) await reader.cancel().catch(() => undefined);
  const bytes = new Uint8Array(kept);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  return { bytes, more };
}

/** The HTTP client: pacing, header gate, retry ladder, and status mapping. */
export class ZenodoHttp {
  readonly #general: Pacer;
  readonly #headers: Record<Bucket, BucketHeaders> = { search: {}, general: {} };
  readonly #search: Pacer;
  readonly #token: string | undefined;
  readonly #userAgent: string;

  constructor(options: { accessToken?: string | undefined; userAgent: string }) {
    this.#token = options.accessToken;
    this.#userAgent = options.userAgent;
    const cooldown = { baseMs: 2_000, maxMs: 60_000 };
    this.#search = createPacer({
      name: 'zenodo-search',
      limits: [{ requests: 25, perMs: 60_000 }],
      maxConcurrent: 2,
      cooldown,
    });
    this.#general = createPacer({
      name: 'zenodo-general',
      limits: this.#token
        ? [
            { requests: 90, perMs: 60_000 },
            { requests: 4_800, perMs: 3_600_000 },
          ]
        : [
            { requests: 55, perMs: 60_000 },
            { requests: 1_900, perMs: 3_600_000 },
          ],
      maxConcurrent: 4,
      cooldown,
    });
  }

  /** Rejects queued waiters and clears the pacers' timers. */
  dispose(): void {
    this.#search.dispose();
    this.#general.dispose();
  }

  /**
   * Runs one request through the retry ladder (outside) and the bucket's pacer
   * (inside). `read` consumes the response of an accepted status and runs inside
   * the attempt, so parse faults are retried with the fetch.
   */
  async request<T>(
    req: ZenodoRequest,
    read: (res: Response) => Promise<T>,
    ctx: Context,
  ): Promise<T> {
    try {
      return await withRetry((attempt) => this.#paced(req, read, ctx, attempt), {
        maxRetries: 1,
        baseDelayMs: 1_000,
        maxDelayMs: 15_000,
        deadlineMs: LADDER_DEADLINE_MS,
        signal: ctx.signal,
        operation: req.operation,
        context: ctx,
      });
    } catch (error) {
      if (!(error instanceof McpError)) throw error;
      const reason = error.data?.reason;
      if (reason === 'pacer_shed') {
        const retryAfter = error.data?.retryAfter;
        throw rateLimited(
          "Zenodo request queue is full; this server's shared rate budget is spent for now.",
          {
            reason: 'rate_limited',
            ...(retryAfter !== undefined ? { retryAfter } : {}),
            ...ctx.recoveryFor('rate_limited'),
          },
          { cause: error },
        );
      }
      if (reason === 'retry_deadline_exceeded') throw this.#timeoutError(req, ctx, error);
      throw error;
    }
  }

  #paced<T>(
    req: ZenodoRequest,
    read: (res: Response) => Promise<T>,
    ctx: Context,
    attempt: RetryAttempt,
  ): Promise<T> {
    const options = { signal: attempt.signal, maxWaitMs: PACER_MAX_WAIT_MS };
    const task = (signal: AbortSignal) =>
      this.#dispatch(req, read, ctx, signal, attempt.remainingMs);
    if (req.bucket === 'general') return this.#general.run(task, options);
    // A search also counts against the global budget: reserve a general start slot,
    // then run in the search pacer, so a search 429 closes only the search gate.
    return this.#general
      .run(async () => undefined, options)
      .then(() => this.#search.run(task, options));
  }

  async #dispatch<T>(
    req: ZenodoRequest,
    read: (res: Response) => Promise<T>,
    ctx: Context,
    signal: AbortSignal,
    remainingMs: number,
  ): Promise<T> {
    this.#checkGate(req.bucket, ctx);

    const budget = Math.max(1, Math.min(req.attemptMs, remainingMs));
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), budget);
    const started = Date.now();
    try {
      const res = await fetch(this.#url(req), {
        headers: this.#requestHeaders(req),
        redirect: req.redirect ?? 'follow',
        signal: AbortSignal.any([signal, deadline.signal]),
      });
      this.#track(req.bucket, res.headers);
      if (!req.okStatuses.includes(res.status)) {
        throw await this.#statusError(req, res, ctx, Date.now() - started);
      }
      return await read(res);
    } catch (error) {
      if (error instanceof McpError) throw error;
      if (deadline.signal.aborted && !signal.aborted) throw this.#timeoutError(req, ctx, error);
      if (signal.aborted) throw error;
      throw serviceUnavailable(
        `Zenodo request failed before a response arrived (${req.operation}).`,
        { operation: req.operation },
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  #url(req: ZenodoRequest): string {
    const query = req.query?.length
      ? `?${new URLSearchParams(req.query as [string, string][])}`
      : '';
    return `${BASE_URL}${req.path}${query}`;
  }

  #requestHeaders(req: ZenodoRequest): Record<string, string> {
    return {
      Accept: req.accept,
      'User-Agent': this.#userAgent,
      ...(this.#token ? { Authorization: `Bearer ${this.#token}` } : {}),
      ...(req.range ? { Range: req.range } : {}),
    };
  }

  /** Records `X-RateLimit-*` for the bucket — on every response, error statuses included. */
  #track(bucket: Bucket, headers: Headers): void {
    const limit = headerNumber(headers, 'x-ratelimit-limit');
    const remaining = headerNumber(headers, 'x-ratelimit-remaining');
    const resetAt = headerNumber(headers, 'x-ratelimit-reset');
    if (limit === undefined && remaining === undefined && resetAt === undefined) return;
    this.#headers[bucket] = {
      ...(limit !== undefined ? { limit } : {}),
      ...(remaining !== undefined ? { remaining } : {}),
      ...(resetAt !== undefined ? { resetAt } : {}),
    };
  }

  /** Refuses to dispatch while the bucket's advertised window is spent. */
  #checkGate(bucket: Bucket, ctx: Context): void {
    const { remaining, resetAt } = this.#headers[bucket];
    if (remaining === undefined || resetAt === undefined || remaining > 0) return;
    const waitMs = resetAt * 1000 - Date.now();
    if (waitMs <= 0) return;
    throw rateLimited(`Zenodo's ${bucket} rate-limit window is spent until it resets.`, {
      reason: 'rate_limited',
      retryAfter: Math.ceil(waitMs / 1000),
      ...ctx.recoveryFor('rate_limited'),
    });
  }

  async #statusError(
    req: ZenodoRequest,
    res: Response,
    ctx: Context,
    elapsedMs: number,
  ): Promise<McpError> {
    const status = res.status;
    if (status === 429) {
      const reset = headerNumber(res.headers, 'x-ratelimit-reset');
      const retryAfter =
        headerNumber(res.headers, 'retry-after') ??
        (reset === undefined ? undefined : Math.max(1, Math.ceil(reset - Date.now() / 1000)));
      await discardBody(res);
      return rateLimited('Zenodo answered HTTP 429 (rate limit reached).', {
        reason: 'rate_limited',
        status,
        ...(retryAfter !== undefined ? { retryAfter } : {}),
        ...ctx.recoveryFor('rate_limited'),
      });
    }

    if (status >= 500) {
      await discardBody(res);
      if (status === 504 && elapsedMs >= SLOW_GATEWAY_MS) return this.#timeoutError(req, ctx);
      if (status === 500) return this.#serverError(req, ctx);
      return serviceUnavailable(`Zenodo answered HTTP ${status} (${req.operation}).`, { status });
    }

    const error = await httpErrorFromResponse(res, {
      service: 'Zenodo',
      data: { operation: req.operation },
    });
    // Zenodo sends Retry-After on every response, counting to its window reset; it
    // means "wait" only on a 429, which is mapped above.
    const { retryAfter: _windowReset, ...data } = error.data ?? {};
    return new McpError(error.code, error.message, data);
  }

  /**
   * A ZIP Zenodo cannot open: its `/container` listing or member read answered 500
   * (after the one retry) or never finished. The message names the archive's
   * download URL, the path that still works.
   */
  #archiveError(
    req: ZenodoRequest,
    ctx: Context,
    failure: 'status_500' | 'timeout',
    cause?: unknown,
  ): McpError {
    const what = failure === 'status_500' ? 'HTTP 500' : 'no complete response in time';
    return new McpError(
      JsonRpcErrorCode.ServiceUnavailable,
      `Zenodo could not open this .zip archive (${what}); download it from ${req.downloadUrl ?? 'its download_url'} instead.`,
      {
        reason: 'archive_unavailable',
        ...(failure === 'status_500' ? { status: 500 } : { retryable: false }),
        ...ctx.recoveryFor('archive_unavailable'),
      },
      cause === undefined ? undefined : { cause },
    );
  }

  /** HTTP 500, per the retry matrix. */
  #serverError(req: ZenodoRequest, ctx: Context): McpError {
    switch (req.endpoint) {
      case 'search':
        return serviceUnavailable('Zenodo answered HTTP 500 for this search query.', {
          reason: 'query_failed',
          status: 500,
          retryable: false,
          ...ctx.recoveryFor('query_failed'),
        });
      case 'doi_lookup':
        return serviceUnavailable('Zenodo answered HTTP 500 while resolving the DOI.', {
          reason: 'record_unavailable',
          status: 500,
          retryable: false,
          ...ctx.recoveryFor('record_unavailable'),
        });
      case 'record':
      case 'versions':
        return serviceUnavailable('Zenodo answered HTTP 500 for this record.', {
          reason: 'record_unavailable',
          status: 500,
          ...ctx.recoveryFor('record_unavailable'),
        });
      case 'archive':
        return this.#archiveError(req, ctx, 'status_500');
      default:
        return serviceUnavailable(`Zenodo answered HTTP 500 (${req.operation}).`, { status: 500 });
    }
  }

  /** Slow 504, attempt timeout, or ladder deadline — deterministic for oversized payloads, never retried. */
  #timeoutError(req: ZenodoRequest, ctx: Context, cause?: unknown): McpError {
    const options = cause === undefined ? undefined : { cause };
    switch (req.endpoint) {
      case 'search':
        return timeout(
          'Zenodo did not finish the search page within its time budget; large file manifests in the hits make pages heavy.',
          { reason: 'upstream_timeout', retryable: false, ...ctx.recoveryFor('upstream_timeout') },
          options,
        );
      case 'versions':
        return timeout(
          'Zenodo did not finish the versions page within its time budget; the series holds large file manifests.',
          { reason: 'upstream_timeout', retryable: false, ...ctx.recoveryFor('upstream_timeout') },
          options,
        );
      case 'record':
      case 'doi_lookup':
        return new McpError(
          JsonRpcErrorCode.ServiceUnavailable,
          'Zenodo did not serve this record within its time budget (gateway cutoff or timeout).',
          {
            reason: 'record_unavailable',
            retryable: false,
            ...ctx.recoveryFor('record_unavailable'),
          },
          options,
        );
      case 'archive':
        return this.#archiveError(req, ctx, 'timeout', cause);
      default:
        return timeout(
          `Zenodo did not respond within the time budget (${req.operation}).`,
          { retryable: false },
          options,
        );
    }
  }
}
