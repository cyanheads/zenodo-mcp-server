/**
 * @fileoverview zenodo_search_records — keyword search over Zenodo deposits with
 * verified filters (resource type, community, funder, award, creator ORCID, file
 * type, license, access status, publication date), returning manifest-free
 * summaries plus facet counts over the full match set, every filter applied.
 * @module mcp-server/tools/definitions/search-records
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  isValidOrcid,
  isWholeIdentifier,
  normalizeOrcid,
  ORCID_PATTERN,
  parseAwardRef,
  parseCommunityRef,
  parseFunderRef,
} from '@/services/zenodo/identifiers.js';
import {
  ACCESS_STATUSES,
  expandPartialDate,
  hasUnpairedSlash,
  isValidPartialDate,
  SEARCH_SORTS,
  type SearchFilters,
} from '@/services/zenodo/query-builder.js';
import { RESOURCE_TYPE_IDS, resolveResourceTypeId } from '@/services/zenodo/resource-types.js';
import { getZenodoService } from '@/services/zenodo/zenodo-service.js';
import { inline } from '../render.js';
import { blankToUndefined, enumPreprocess, toOptionalArray } from '../schema-helpers.js';

const RESULT_WINDOW = 10_000;
const PARTIAL_DATE_PATTERN = /^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$/;

/**
 * Resource type preprocess: a lone string or array, each value resolved to its id
 * (any case; `publication::publication-article` → `publication-article`). A value
 * that names no resource type raises its own issue here rather than reaching the
 * enum: the enum's issue would point at an array index a lone-string input never
 * had, and read as a missing field.
 */
const resourceTypeInput = z.preprocess((v, ctx) => {
  const arr = toOptionalArray(v);
  if (!Array.isArray(arr)) return arr;
  const unknown = arr.filter(
    (x): x is string => typeof x === 'string' && !resolveResourceTypeId(x),
  );
  if (unknown.length) {
    ctx.addIssue({
      code: 'custom',
      input: v,
      message: `${unknown.map((x) => JSON.stringify(x.slice(0, 100))).join(', ')} ${unknown.length > 1 ? 'are not Zenodo resource type ids' : 'is not a Zenodo resource type id'}. Expected one of: ${RESOURCE_TYPE_IDS.join(', ')} (a subtype may also be written <type>::<id>, e.g. publication::publication-article). Look types up with zenodo_lookup_vocabulary (vocabulary: resource_types).`,
    });
    return z.NEVER;
  }
  return arr.map((x) => (typeof x === 'string' ? (resolveResourceTypeId(x) ?? x) : x));
}, z.array(z.enum(RESOURCE_TYPE_IDS)).max(10).optional());

/** A lone string or array of strings, blanks dropped, each value lowercased with a leading `.` stripped (`.CSV` → `csv`). */
const toFileTypes = (v: unknown): unknown => {
  const arr = toOptionalArray(v);
  return Array.isArray(arr)
    ? arr.map((x) => (typeof x === 'string' ? x.toLowerCase().replace(/^\./, '') : x))
    : arr;
};

const lowerBlank = (v: unknown): unknown => {
  const b = blankToUndefined(v);
  return typeof b === 'string' ? b.toLowerCase() : b;
};

const orcidBlank = (v: unknown): unknown => {
  const b = blankToUndefined(v);
  return typeof b === 'string' ? normalizeOrcid(b) : b;
};

const dateField = (description: string) =>
  z
    .preprocess(
      blankToUndefined,
      z
        .string()
        .regex(PARTIAL_DATE_PATTERN, 'Expected YYYY, YYYY-MM, or YYYY-MM-DD.')
        .refine(isValidPartialDate, 'Not a real calendar date.')
        .optional(),
    )
    .describe(description);

const FacetSchema = z
  .object({
    id: z.string().describe('Facet value id; feeds the matching zenodo_search_records filter.'),
    label: z.string().describe('Display label.'),
    count: z.number().describe('Matching records with this value.'),
  })
  .describe('One facet bucket.');

const HitSchema = z
  .object({
    recid: z.string().describe('Record id of this version — pass to zenodo_get_record as id.'),
    doi: z.string().optional().describe('DOI of this version; absent on some old records.'),
    doi_provider: z
      .string()
      .optional()
      .describe('datacite (minted by Zenodo) or external (publisher-minted).'),
    concept_recid: z
      .string()
      .optional()
      .describe('Concept record id naming the whole version series; absent if Zenodo omits it.'),
    concept_doi: z
      .string()
      .optional()
      .describe('Concept DOI of the version series; absent for external DOIs.'),
    title: z.string().describe('Title as deposited.'),
    publication_date: z
      .string()
      .optional()
      .describe(
        'Publication date (EDTF as given: 2026-09-11, 2020, 2020-05); absent when not recorded.',
      ),
    resource_type: z
      .object({
        id: z.string().describe('Resource type id, e.g. dataset or publication-article.'),
        title: z.string().optional().describe('Resource type label, when Zenodo supplies one.'),
      })
      .optional()
      .describe('Resource type; absent when not recorded.'),
    version: z
      .string()
      .optional()
      .describe('Version label as deposited; absent when the depositor set none.'),
    is_latest: z
      .boolean()
      .optional()
      .describe('True when this is the newest version; absent if Zenodo omits version data.'),
    version_index: z
      .number()
      .optional()
      .describe(
        'Position of this version in its series (1 = first); absent if Zenodo omits version data.',
      ),
    creators: z
      .array(
        z
          .object({
            name: z.string().describe('Creator name as deposited.'),
            orcid: z.string().optional().describe('Creator ORCID iD, when supplied.'),
          })
          .describe('One creator.'),
      )
      .describe('First 5 creators.'),
    creator_count: z.number().describe('Total creators.'),
    license_ids: z
      .array(z.string())
      .describe('License ids (custom rights without an id are omitted; see zenodo_get_record).'),
    access: z
      .object({
        status: z
          .string()
          .describe('open, restricted, embargoed, or metadata-only (unknown if Zenodo omits it).'),
        files: z
          .string()
          .optional()
          .describe('File access: public or restricted; absent when not reported.'),
        embargo_until: z.string().optional().describe('Embargo end date, when active.'),
      })
      .describe('Access status.'),
    communities: z.array(z.string()).describe('First 5 community slugs holding this record.'),
    file_count: z
      .number()
      .optional()
      .describe('Number of files; absent when files are restricted or embargoed.'),
    total_bytes: z
      .number()
      .optional()
      .describe('Total file size in bytes; absent when files are restricted or embargoed.'),
    views: z
      .number()
      .optional()
      .describe('Unique views across all versions; absent when Zenodo reports no usage counts.'),
    downloads: z
      .number()
      .optional()
      .describe(
        'Unique downloads across all versions; absent when Zenodo reports no usage counts.',
      ),
    description_snippet: z
      .string()
      .optional()
      .describe(
        'First ~280 characters of the plain-text description; absent when the record has none.',
      ),
    zenodo_url: z.string().describe('Record landing page on zenodo.org.'),
  })
  .describe('One matching deposit.');

export const searchRecords = tool('zenodo_search_records', {
  title: 'Search Zenodo records',
  description:
    'Search Zenodo\'s open research repository — datasets, software releases, publications, and other deposits — by keyword query plus filters for resource type, community, funder, grant, creator ORCID, file type, license, access status, and publication date. Returns one summary per deposit (ids, DOIs, title, type, version, creators, license, access, file totals, usage counts) plus facet counts over the full match set, every filter applied. Query terms are OR-ed unless joined with AND, quoted phrases match exactly, and field syntax works on record fields (metadata.title:"…", metadata.subjects.subject:"…"). Only the latest version of each deposit is searched unless all_versions is true, and only the first 10,000 matches are reachable by paging. Resolve community, funder, and grant names to ids with zenodo_lookup_vocabulary first; open one deposit in full with zenodo_get_record.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    query: z
      .preprocess(blankToUndefined, z.string().max(1000).optional())
      .describe(
        'Keyword query. Terms are OR-ed unless joined with AND; "quoted phrases" match exactly; field syntax such as metadata.title:"…" or doi:"10.5281/zenodo.N" works. Escape a literal / as \\/. A bare DOI or record URL is rejected; open it with zenodo_get_record instead. Omit to browse with filters only.',
      ),
    resource_type: resourceTypeInput.describe(
      'Resource type ids, OR-ed (a single string is accepted): dataset, software, publication, publication-article, image-photo, … Any case; a subtype may also be written in the <type>::<id> form zenodo_lookup_vocabulary shows as its search value (publication::publication-article). A top-level type includes its subtypes. Look ids up with zenodo_lookup_vocabulary (vocabulary: resource_types).',
    ),
    community: z
      .preprocess(blankToUndefined, z.string().max(200).optional())
      .describe(
        'One community: its slug, UUID, or zenodo.org/communities/<slug> URL. Find slugs with zenodo_lookup_vocabulary (vocabulary: communities).',
      ),
    funder: z
      .preprocess(blankToUndefined, z.string().max(200).optional())
      .describe(
        'One funder: a ROR id (01cwqze88), a ROR URL, or a Crossref Funder DOI (10.13039/100000002). Resolve a funder name with zenodo_lookup_vocabulary (vocabulary: funders).',
      ),
    award: z
      .preprocess(blankToUndefined, z.string().max(200).optional())
      .describe(
        'One grant: an award id <funder-ror>::<number> (00k4n6c32::101135562), a bare grant number, or a CORDIS award DOI (10.3030/101135562). Find ids with zenodo_lookup_vocabulary (vocabulary: awards).',
      ),
    creator_orcid: z
      .preprocess(
        orcidBlank,
        z
          .string()
          .regex(ORCID_PATTERN, 'Expected an ORCID iD such as 0000-0002-1825-0097.')
          .refine(isValidOrcid, 'ORCID iD check digit does not match.')
          .optional(),
      )
      .describe(
        'Creator ORCID iD, e.g. 0000-0002-1825-0097; an https://orcid.org/ prefix is stripped and a trailing x uppercased.',
      ),
    file_type: z
      .preprocess(
        toFileTypes,
        z
          .array(
            z
              .string()
              .regex(/^[a-z0-9]{1,16}$/, 'Expected a file extension such as csv or zip.')
              .describe('A file extension, e.g. csv.'),
          )
          .max(10)
          .optional(),
      )
      .describe(
        'File extensions, OR-ed (a single string is accepted): csv, zip, pdf, … Lowercased with any leading dot stripped.',
      ),
    license: z
      .preprocess(
        lowerBlank,
        z
          .string()
          .regex(/^[a-z0-9][a-z0-9.+-]{0,63}$/, 'Expected a license id such as cc-by-4.0 or mit.')
          .optional(),
      )
      .describe(
        'License id, e.g. cc-by-4.0, cc0-1.0, mit (lowercased). Find ids with zenodo_lookup_vocabulary (vocabulary: licenses).',
      ),
    access_status: z
      .preprocess(enumPreprocess(ACCESS_STATUSES), z.enum(ACCESS_STATUSES).optional())
      .describe(
        'Access status: open, restricted, embargoed, or metadata-only. Case, spaces, hyphens, and underscores are ignored when matching (Metadata Only reads as metadata-only).',
      ),
    published_from: dateField(
      'Earliest publication date, YYYY, YYYY-MM, or YYYY-MM-DD; a partial date starts at its first day.',
    ),
    published_to: dateField(
      'Latest publication date, YYYY, YYYY-MM, or YYYY-MM-DD; a partial date ends at its last day.',
    ),
    all_versions: z
      .boolean()
      .default(false)
      .describe('Include superseded versions; by default only the latest version is searched.'),
    sort: z
      .preprocess(enumPreprocess(SEARCH_SORTS), z.enum(SEARCH_SORTS).optional())
      .describe(
        'Sort order: bestmatch, newest, oldest, mostviewed, mostdownloaded, updated-desc, updated-asc. Case, spaces, hyphens, and underscores are ignored when matching (MostViewed reads as mostviewed). Defaults to bestmatch with a query, newest without.',
      ),
    page: z
      .number()
      .int()
      .min(1)
      .default(1)
      .describe('Result page, starting at 1. page × size may not exceed 10,000.'),
    size: z.number().int().min(1).max(25).default(10).describe('Results per page (1–25).'),
  }),
  output: z.object({
    total: z.number().describe('Exact number of matching records.'),
    reachable: z.number().describe('Matches reachable by paging: min(total, 10,000).'),
    page: z.number().describe('Page returned.'),
    size: z.number().describe('Page size applied.'),
    has_more: z.boolean().describe('True when another reachable page follows.'),
    next_page: z.number().optional().describe('The next page number, when has_more.'),
    hits: z.array(HitSchema).describe('Matching deposits on this page.'),
    facets: z
      .object({
        resource_type: z
          .array(
            FacetSchema.extend({
              subtypes: z
                .array(FacetSchema)
                .optional()
                .describe('Top 5 subtypes of this resource type.'),
            }).describe('One resource type bucket.'),
          )
          .describe('Top 10 resource types; ids feed resource_type.'),
        access_status: z.array(FacetSchema).describe('Access status buckets.'),
        file_type: z.array(FacetSchema).describe('Top 10 file types; ids feed file_type.'),
        subject: z
          .array(
            z
              .object({
                label: z.string().describe('Subject keyword.'),
                count: z.number().describe('Matching records with this subject.'),
              })
              .describe('One subject bucket.'),
          )
          .describe('Top 10 subjects; query them as metadata.subjects.subject:"<label>".'),
        publication_year: z
          .array(
            z
              .object({
                year: z.string().describe('Publication year.'),
                count: z.number().describe('Matching records published that year.'),
              })
              .describe('One year bucket.'),
          )
          .describe('The 10 most recent publication years present.'),
      })
      .describe(
        'Facet counts over the full match set (every filter applied, so they agree with total), not just this page.',
      ),
  }),
  enrichment: {
    truncated: z.boolean().describe('True when more reachable matches follow this page.'),
    shown: z.number().describe('Hits returned on this page.'),
    cap: z.number().describe('Page size applied.'),
    totalCount: z.number().describe('Exact number of matching records.'),
    effectiveQuery: z.string().optional().describe('The exact q sent to Zenodo.'),
    appliedSort: z.enum(SEARCH_SORTS).describe('The sort order applied.'),
    allVersions: z.boolean().describe('Whether superseded versions were searched.'),
    notice: z
      .string()
      .optional()
      .describe('Guidance on empty results, the 10,000-result window, or further pages.'),
  },
  errors: [
    {
      reason: 'query_is_identifier',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The query is a single DOI, doi.org URL, or zenodo.org record URL',
      recovery: 'Pass this identifier to zenodo_get_record as id instead of searching for it.',
    },
    {
      reason: 'query_syntax',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The query has an unpaired unescaped / outside quotes',
      recovery:
        'Escape the slash as \\/ or wrap that term in double quotes, then call zenodo_search_records again.',
    },
    {
      reason: 'query_failed',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Zenodo answered HTTP 500 for a query that passed the local checks',
      retryable: false,
      thrownBy: 'service',
      recovery:
        'Simplify the query (quote phrases, escape : and / with a backslash, or move identifiers into the dedicated filters) and call zenodo_search_records again; if a plain keyword query also fails, Zenodo is degraded, so retry in a few minutes.',
    },
    {
      reason: 'upstream_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'The search attempt got no complete response within its time budget',
      retryable: false,
      thrownBy: 'service',
      recovery:
        'Call zenodo_search_records again with a smaller size (5) or narrower filters so the page holds fewer large deposits.',
    },
    {
      reason: 'unknown_community',
      code: JsonRpcErrorCode.ValidationError,
      when: 'community resolves to no Zenodo community',
      recovery:
        'Find the community’s slug with zenodo_lookup_vocabulary (vocabulary: communities), then pass it as community.',
    },
    {
      reason: 'unknown_funder',
      code: JsonRpcErrorCode.ValidationError,
      when: 'funder is not a known ROR id and no funder carries that Crossref Funder DOI',
      recovery:
        'Resolve the funder with zenodo_lookup_vocabulary (vocabulary: funders) and pass the returned ROR id as funder.',
    },
    {
      reason: 'invalid_date_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The expanded published_from is after published_to',
      recovery:
        'Set published_from to a date on or before published_to and call zenodo_search_records again.',
    },
    {
      reason: 'result_window_exceeded',
      code: JsonRpcErrorCode.ValidationError,
      when: 'page × size exceeds 10,000',
      recovery:
        'Zenodo serves only the first 10,000 matches; add filters or a published_from/published_to range to zenodo_search_records instead of paging deeper.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: "Zenodo answered HTTP 429, or this server's shared Zenodo request budget is spent for the current window",
      retryable: true,
      thrownBy: 'service',
      recovery:
        'Wait for the retryAfter seconds in the error data, then call zenodo_search_records again with the same arguments.',
    },
  ],

  async handler(input, ctx) {
    const sort = input.sort ?? (input.query ? 'bestmatch' : 'newest');
    ctx.enrich({
      truncated: false,
      shown: 0,
      cap: input.size,
      totalCount: 0,
      appliedSort: sort,
      allVersions: input.all_versions,
    });

    if (input.page * input.size > RESULT_WINDOW) {
      throw ctx.fail(
        'result_window_exceeded',
        `page ${input.page} × size ${input.size} is past the first ${RESULT_WINDOW.toLocaleString('en-US')} matches.`,
        ctx.recoveryFor('result_window_exceeded'),
      );
    }
    if (input.query && isWholeIdentifier(input.query)) {
      throw ctx.fail(
        'query_is_identifier',
        `The query "${inline(input.query)}" is a record identifier, not search terms.`,
        ctx.recoveryFor('query_is_identifier'),
      );
    }
    if (input.query && hasUnpairedSlash(input.query)) {
      throw ctx.fail(
        'query_syntax',
        'The query has an unpaired / outside quotes, which Zenodo parses as an unterminated regular expression.',
        ctx.recoveryFor('query_syntax'),
      );
    }

    const publishedFrom = input.published_from
      ? expandPartialDate(input.published_from, 'from')
      : undefined;
    const publishedTo = input.published_to
      ? expandPartialDate(input.published_to, 'to')
      : undefined;
    if (publishedFrom && publishedTo && publishedFrom > publishedTo) {
      throw ctx.fail(
        'invalid_date_range',
        `published_from ${publishedFrom} is after published_to ${publishedTo}.`,
        ctx.recoveryFor('invalid_date_range'),
      );
    }

    const service = getZenodoService();

    let communityId: string | undefined;
    if (input.community) {
      const ref = parseCommunityRef(input.community);
      const community = ref ? await service.getCommunity(ref, ctx) : undefined;
      if (!community) {
        throw ctx.fail(
          'unknown_community',
          `No Zenodo community matches "${inline(input.community)}" as a slug, UUID, or community URL.`,
          ctx.recoveryFor('unknown_community'),
        );
      }
      communityId = community.uuid;
    }

    let funderRor: string | undefined;
    if (input.funder) {
      const ref = parseFunderRef(input.funder);
      const funder = ref ? await service.resolveFunder(ref, ctx) : undefined;
      if (!funder) {
        throw ctx.fail(
          'unknown_funder',
          `"${inline(input.funder)}" is not a known ROR id and no funder carries that Crossref Funder DOI.`,
          ctx.recoveryFor('unknown_funder'),
        );
      }
      funderRor = funder.ror_id;
    }

    const filters: SearchFilters = {
      allVersions: input.all_versions,
      page: input.page,
      size: input.size,
      sort,
      ...(input.query ? { query: input.query } : {}),
      ...(input.resource_type ? { resourceTypes: input.resource_type } : {}),
      ...(input.file_type ? { fileTypes: input.file_type } : {}),
      ...(input.access_status ? { accessStatus: input.access_status } : {}),
      ...(communityId ? { communityId } : {}),
      ...(funderRor ? { funderRor } : {}),
      ...(input.award ? { award: parseAwardRef(input.award) } : {}),
      ...(input.creator_orcid ? { creatorOrcid: input.creator_orcid } : {}),
      ...(input.license ? { license: input.license } : {}),
      ...(publishedFrom ? { publishedFrom } : {}),
      ...(publishedTo ? { publishedTo } : {}),
    };
    const result = await service.searchRecords(filters, ctx);

    const total = result.total;
    const reachable = Math.min(total, RESULT_WINDOW);
    const hasMore = input.page * input.size < reachable;
    ctx.enrich({ shown: result.hits.length });
    ctx.enrich.total(total);
    if (result.q) ctx.enrich.echo(result.q);

    const notice: string[] = [];
    if (total === 0) {
      notice.push('No records matched.');
      const narrowing = (
        [
          ['resource_type', input.resource_type],
          ['file_type', input.file_type],
          ['access_status', input.access_status],
          ['license', input.license],
        ] as const
      )
        .filter(([, v]) => v !== undefined)
        .map(([name]) => name);
      if (narrowing.length) {
        notice.push(
          narrowing.length === 1
            ? `The ${narrowing[0]} filter narrows the set; drop it and call zenodo_search_records again.`
            : `The ${narrowing.join(', ')} filters narrow the set; drop one and call zenodo_search_records again.`,
        );
      }
      const ids = (
        [
          ['community', input.community],
          ['funder', input.funder],
          ['award', input.award],
        ] as const
      )
        .filter(([, v]) => v !== undefined)
        .map(([name]) => name);
      if (ids.length) {
        notice.push(
          `Check the ${ids.join(', ')} id${ids.length > 1 ? 's' : ''} with zenodo_lookup_vocabulary.`,
        );
      }
      if (!input.all_versions) {
        notice.push(
          'Only the latest version of each deposit is searched; set all_versions to true to include superseded versions.',
        );
      }
      if (input.query && /\bAND\b|"/.test(input.query)) {
        notice.push(
          'Terms joined by AND must all match and quoted phrases must match exactly; loosen the query.',
        );
      }
      if (input.published_from || input.published_to) {
        notice.push('Widen or drop published_from/published_to.');
      }
    } else if (result.hits.length === 0) {
      const last = Math.max(1, Math.ceil(reachable / input.size));
      notice.push(
        `Page ${input.page} is past the last page (${last}); call again with page ${last} or lower.`,
      );
    }
    if (total > RESULT_WINDOW) {
      notice.push(
        `Only the first 10,000 of ${total.toLocaleString('en-US')} matches are reachable; add filters or a date range, or change sort.`,
      );
    }
    if (hasMore) {
      notice.push(
        `Showing ${result.hits.length} of ${reachable.toLocaleString('en-US')}; call again with page ${input.page + 1}.`,
      );
      ctx.enrich.truncated({
        shown: result.hits.length,
        cap: input.size,
        guidance: notice.join(' '),
      });
    } else if (notice.length) {
      ctx.enrich.notice(notice.join(' '));
    }

    return {
      total,
      reachable,
      page: input.page,
      size: input.size,
      has_more: hasMore,
      ...(hasMore ? { next_page: input.page + 1 } : {}),
      hits: result.hits,
      facets: result.facets,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `## Zenodo search: ${result.total} matches (${result.reachable} reachable)`,
      `**Page:** ${result.page} | **Size:** ${result.size} | **Has more:** ${result.has_more}${result.next_page !== undefined ? ` | **Next page:** ${result.next_page}` : ''}`,
    ];

    for (const h of result.hits) {
      lines.push('', `### ${inline(h.title)}`);
      lines.push(
        `**Record:** ${h.recid}${h.concept_recid ? ` | **Concept record:** ${h.concept_recid}` : ''} | **URL:** ${h.zenodo_url}`,
      );
      const ids = [
        h.doi
          ? `**DOI:** ${inline(h.doi)}${h.doi_provider ? ` (${inline(h.doi_provider)})` : ''}`
          : undefined,
        h.concept_doi ? `**Concept DOI:** ${inline(h.concept_doi)}` : undefined,
      ].filter(Boolean);
      if (ids.length) lines.push(ids.join(' | '));
      const facts = [
        h.resource_type
          ? `**Type:** ${h.resource_type.title ? `${inline(h.resource_type.title)} ` : ''}(${inline(h.resource_type.id)})`
          : undefined,
        h.publication_date ? `**Published:** ${inline(h.publication_date)}` : undefined,
        h.version ? `**Version:** ${inline(h.version)}` : undefined,
        h.version_index !== undefined ? `**Version index:** ${h.version_index}` : undefined,
        h.is_latest !== undefined ? `**Latest:** ${h.is_latest}` : undefined,
      ].filter(Boolean);
      if (facts.length) lines.push(facts.join(' | '));
      const creators = h.creators
        .map((c) => `${inline(c.name)}${c.orcid ? ` (ORCID ${inline(c.orcid)})` : ''}`)
        .join('; ');
      lines.push(
        `**Creators (${h.creator_count}):** ${creators || 'none listed'}${h.creator_count > h.creators.length ? '; …' : ''}`,
      );
      lines.push(
        `**Access:** ${inline(h.access.status)}${h.access.files ? `, files ${inline(h.access.files)}` : ''}${h.access.embargo_until ? `, embargoed until ${inline(h.access.embargo_until)}` : ''} | **Licenses:** ${h.license_ids.length ? h.license_ids.map(inline).join(', ') : 'none with an id'}`,
      );
      lines.push(
        `**Files:** ${h.file_count ?? 'not disclosed'} (${h.total_bytes ?? 'not disclosed'} bytes) | **Views:** ${h.views ?? 'not available'} | **Downloads:** ${h.downloads ?? 'not available'}`,
      );
      if (h.communities.length)
        lines.push(`**Communities:** ${h.communities.map(inline).join(', ')}`);
      if (h.description_snippet) lines.push(`**Snippet:** ${inline(h.description_snippet)}`);
    }

    const f = result.facets;
    const bucketList = (buckets: { count: number; id: string; label: string }[]) =>
      buckets.map((b) => `${inline(b.label)} \`${inline(b.id)}\` (${b.count})`).join('; ');
    const facetsHeading = '### Facets (full match set, every filter applied)';
    lines.push('', facetsHeading);
    if (f.resource_type.length) {
      lines.push('**Resource types:**');
      for (const b of f.resource_type) {
        lines.push(
          `- ${inline(b.label)} \`${inline(b.id)}\` (${b.count})${b.subtypes?.length ? ` — ${bucketList(b.subtypes)}` : ''}`,
        );
      }
    }
    if (f.access_status.length) lines.push(`**Access status:** ${bucketList(f.access_status)}`);
    if (f.file_type.length) lines.push(`**File types:** ${bucketList(f.file_type)}`);
    if (f.subject.length) {
      lines.push(
        `**Subjects:** ${f.subject.map((s) => `${inline(s.label)} (${s.count})`).join('; ')}`,
      );
    }
    if (f.publication_year.length) {
      lines.push(
        `**Publication years:** ${f.publication_year.map((y) => `${inline(y.year)} (${y.count})`).join('; ')}`,
      );
    }
    if (lines.at(-1) === facetsHeading) lines.push('No facet counts (nothing matched).');
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
