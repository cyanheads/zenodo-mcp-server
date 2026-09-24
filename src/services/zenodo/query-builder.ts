/**
 * @fileoverview Composes the Zenodo search request from validated filters. Only
 * allowlisted query parameters are ever emitted; every other filter composes into
 * `q` as a quoted field clause. Also holds the local query pre-checks and the
 * partial-date expansion search needs.
 * @module services/zenodo/query-builder
 */

/** Sort options Zenodo's record search accepts. */
export const SEARCH_SORTS = [
  'bestmatch',
  'newest',
  'oldest',
  'mostviewed',
  'mostdownloaded',
  'updated-desc',
  'updated-asc',
] as const;
export type SearchSort = (typeof SEARCH_SORTS)[number];

/** Access-status filter values. */
export const ACCESS_STATUSES = ['open', 'restricted', 'embargoed', 'metadata-only'] as const;
export type AccessStatus = (typeof ACCESS_STATUSES)[number];

/** Filters in their resolved, upstream-ready form. */
export interface SearchFilters {
  accessStatus?: AccessStatus;
  allVersions: boolean;
  /** Award clause from `parseAwardRef`. */
  award?: { field: 'id' | 'number'; value: string };
  /** Canonical community UUID. */
  communityId?: string;
  creatorOrcid?: string;
  fileTypes?: string[];
  /** Funder ROR id. */
  funderRor?: string;
  license?: string;
  page: number;
  /** Expanded full date, `YYYY-MM-DD`. */
  publishedFrom?: string;
  /** Expanded full date, `YYYY-MM-DD`. */
  publishedTo?: string;
  query?: string;
  /** `resource_type` param values (`dataset`, `publication::publication-article`). */
  resourceTypes?: string[];
  size: number;
  sort: SearchSort;
}

/** A built search request: the composed `q` (when any) and the ordered param list. */
export interface BuiltSearch {
  params: [string, string][];
  q?: string;
}

/** Wraps a value in double quotes, escaping `\` and `"`. */
export function quoteValue(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/** Composes `q` and the allowlisted params from resolved filters. */
export function buildSearch(filters: SearchFilters): BuiltSearch {
  const clauses: string[] = [];
  if (filters.funderRor)
    clauses.push(`metadata.funding.funder.id:${quoteValue(filters.funderRor)}`);
  if (filters.award) {
    clauses.push(
      `metadata.funding.award.${filters.award.field}:${quoteValue(filters.award.value)}`,
    );
  }
  if (filters.creatorOrcid) {
    clauses.push(
      `metadata.creators.person_or_org.identifiers.identifier:${quoteValue(filters.creatorOrcid)}`,
    );
  }
  if (filters.license) clauses.push(`metadata.rights.id:${quoteValue(filters.license)}`);
  if (filters.publishedFrom || filters.publishedTo) {
    clauses.push(
      `metadata.publication_date:[${filters.publishedFrom ?? '*'} TO ${filters.publishedTo ?? '*'}]`,
    );
  }

  const query = filters.query?.trim();
  const q = query
    ? clauses.length > 0
      ? [`(${query})`, ...clauses].join(' AND ')
      : query
    : clauses.length > 0
      ? clauses.join(' AND ')
      : undefined;

  const params: [string, string][] = [];
  if (q) params.push(['q', q]);
  for (const t of filters.resourceTypes ?? []) params.push(['resource_type', t]);
  for (const t of filters.fileTypes ?? []) params.push(['file_type', t]);
  if (filters.accessStatus) params.push(['access_status', filters.accessStatus]);
  if (filters.communityId) params.push(['communities', filters.communityId]);
  if (filters.allVersions) params.push(['all_versions', 'true']);
  params.push(
    ['sort', filters.sort],
    ['page', String(filters.page)],
    ['size', String(filters.size)],
  );
  return q ? { q, params } : { params };
}

/**
 * Escapes the query-syntax characters that make Zenodo's vocabulary endpoints
 * answer HTTP 500 (`10.13039/100000002`, `a:b:c`), so a name, acronym, or DOI
 * typed as a vocabulary query searches as text. Quotes, `*`, `+`, and `-` keep
 * their meaning.
 */
export function escapeVocabularyQuery(query: string): string {
  return query.replace(/[\\/:[\]{}()^~!?]/g, '\\$&');
}

/**
 * True when the query holds an odd number of `/` that are unescaped and outside
 * double quotes. Zenodo parses `/` as a regex delimiter and answers an
 * unterminated one with HTTP 500.
 */
export function hasUnpairedSlash(query: string): boolean {
  let inQuotes = false;
  let slashes = 0;
  for (let i = 0; i < query.length; i++) {
    const ch = query[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === '/' && !inQuotes) slashes++;
  }
  return slashes % 2 === 1;
}

const PARTIAL_DATE = /^(\d{4})(?:-(0[1-9]|1[0-2])(?:-(0[1-9]|[12]\d|3[01]))?)?$/;

/**
 * Days in a month (1-based), leap years included. `setUTCFullYear` takes the year
 * literally; `Date.UTC` would map years 0–99 to 1900–1999.
 */
function daysInMonth(year: number, month: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month, 0);
  return date.getUTCDate();
}

/** True when `value` is `YYYY`, `YYYY-MM`, or a real calendar date `YYYY-MM-DD`. */
export function isValidPartialDate(value: string): boolean {
  const m = PARTIAL_DATE.exec(value);
  if (!m) return false;
  if (!m[3]) return true;
  return Number(m[3]) <= daysInMonth(Number(m[1]), Number(m[2]));
}

/**
 * Expands a partial date to a full day: `from` takes the first day of the year or
 * month, `to` the last. Upstream compares partial dates as instants, so
 * `[2020 TO 2020]` would match only records dated exactly `2020`.
 */
export function expandPartialDate(value: string, side: 'from' | 'to'): string {
  const m = PARTIAL_DATE.exec(value);
  if (!m?.[1]) return value;
  const year = m[1];
  if (m[3] && m[2]) return value;
  if (m[2]) {
    const day = side === 'from' ? 1 : daysInMonth(Number(year), Number(m[2]));
    return `${year}-${m[2]}-${String(day).padStart(2, '0')}`;
  }
  return side === 'from' ? `${year}-01-01` : `${year}-12-31`;
}
