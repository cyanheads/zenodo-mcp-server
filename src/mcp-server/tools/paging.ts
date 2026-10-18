/**
 * @fileoverview Paging rules shared by the Zenodo tools: Zenodo's 10,000-hit result
 * window on paged searches and listings, and the per-call cap that serves a larger
 * budget input (a page size, an entry limit, a byte count) at the cap instead of
 * rejecting it.
 * @module mcp-server/tools/paging
 */

/** Zenodo pages through only the first 10,000 hits of a search or listing. */
export const RESULT_WINDOW = 10_000;

/**
 * Page size cap of the search, version, and vocabulary pages. Zenodo answers a
 * larger search or versions page with HTTP 400; vocabulary pages share the cap so
 * one paging rule holds across the three tools.
 */
export const PAGE_SIZE_CAP = 25;

/** Hits reachable by paging: the total, or the window when the total passes it. */
export const reachableHits = (total: number): number => Math.min(total, RESULT_WINDOW);

/** True when another page of reachable hits follows: page × size < min(total, 10,000). */
export const hasMorePages = (page: number, size: number, total: number): boolean =>
  page * size < reachableHits(total);

/**
 * The rejection message for a page that starts past the window, or `undefined` when
 * the page is servable. Zenodo rejects only a page whose first hit lies past the
 * window, `(page − 1) × size ≥ 10,000`, and serves the page straddling hit 10,000
 * short; the message names the last servable page at this size, plus `capNote` when
 * a cap lowered the size the page was counted at.
 */
export function windowRejection(
  page: number,
  size: number,
  noun: string,
  capNote?: string,
): string | undefined {
  if ((page - 1) * size < RESULT_WINDOW) return;
  const last = Math.ceil(RESULT_WINDOW / size);
  return `Page ${page} at size ${size} starts past the first 10,000 ${noun}${capNote ? ` (${capNote})` : ''}; the last reachable page at size ${size} is ${last}.`;
}

/** A budget input after its per-call cap. */
export interface CappedValue {
  /** The value the call runs with: the request, or the cap when the request is larger. */
  applied: number;
  /** `<name> <requested> is capped at <cap> per call`; present only when the cap lowered the value. */
  capNote?: string;
}

/**
 * Serves a budget input up to its per-call cap instead of rejecting a larger value.
 * `applied` drives the upstream request, the cache key, continuation, and the value
 * the output reports. `capNote` belongs in the notice only when the cap withheld
 * results, which the calling tool decides (another page or byte range follows).
 */
export function applyCap(name: string, requested: number, cap: number): CappedValue {
  return requested > cap
    ? { applied: cap, capNote: `${name} ${requested} is capped at ${cap} per call` }
    : { applied: requested };
}
