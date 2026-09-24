/**
 * @fileoverview zenodo_list_versions — lists a Zenodo deposit's version series,
 * newest first. Accepts every identifier form zenodo_get_record accepts; a miss
 * (unknown id, deleted record, restricted metadata, DOI not on Zenodo) is a result.
 * @module mcp-server/tools/definitions/list-versions
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { parseRecordRef } from '@/services/zenodo/identifiers.js';
import type { VersionsLookup } from '@/services/zenodo/types.js';
import { getZenodoService } from '@/services/zenodo/zenodo-service.js';
import { notOnZenodoMiss, recordMiss, TombstoneSchema } from '../record-miss.js';
import { inline, quoteBlock } from '../render.js';

/** Zenodo answers HTTP 400 when page × size passes this window. */
const RESULT_WINDOW = 10_000;

export const listVersions = tool('zenodo_list_versions', {
  title: 'List Zenodo record versions',
  description:
    "List every version of a Zenodo deposit's version series, newest first, with each version's record id, DOI, version label, publication date, file totals, and usage counts. Accepts any identifier zenodo_get_record accepts; a concept DOI and any single version's DOI list the same series. Use it to find the version a paper cited or the current release. A miss (an unknown id, a deleted record with its removal tombstone, restricted metadata, or a DOI not registered on Zenodo) returns found: false with guidance instead of an error.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    id: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .describe(
        'Any version or concept identifier of the deposit: a record id (22705923), a Zenodo DOI (10.5281/zenodo.22705923) or concept DOI (10.5281/zenodo.591564), another DOI registered to a Zenodo record, or a zenodo.org/records or doi.org URL.',
      ),
    page: z
      .number()
      .int()
      .min(1)
      .default(1)
      .describe('Result page, starting at 1. page × size may not exceed 10,000.'),
    size: z.number().int().min(1).max(25).default(25).describe('Versions per page (1–25).'),
  }),
  output: z.object({
    found: z.boolean().describe('True when the version series resolved.'),
    input_kind: z
      .enum(['record_id', 'zenodo_doi', 'external_doi', 'url'])
      .describe(
        'How id was parsed: record_id (digits), zenodo_doi (10.5281/zenodo.N or zenodo.N), external_doi (another DOI), or url (a zenodo.org or doi.org link).',
      ),
    miss_kind: z
      .enum(['not_found', 'deleted', 'restricted', 'not_on_zenodo'])
      .optional()
      .describe('Why nothing resolved. Present when not found.'),
    guidance: z.string().optional().describe('What to do next. Present when not found.'),
    tombstone: TombstoneSchema.optional().describe(
      'Removal tombstone. Present when miss_kind is deleted.',
    ),
    concept_recid: z
      .string()
      .optional()
      .describe(
        'Concept record id naming the whole series; absent when not found or on a page past the end.',
      ),
    concept_doi: z
      .string()
      .optional()
      .describe(
        'Concept DOI of the series, when minted; absent when not found or on a page past the end.',
      ),
    total_versions: z
      .number()
      .optional()
      .describe('Number of versions in the series. Present when found.'),
    latest_recid: z
      .string()
      .optional()
      .describe(
        'Record id of the newest version. Present when found, unless Zenodo cannot name it for a page past the end.',
      ),
    page: z.number().describe('Page returned.'),
    size: z.number().describe('Page size applied.'),
    has_more: z.boolean().describe('True when another page of versions follows.'),
    next_page: z.number().optional().describe('The next page number, when has_more.'),
    versions: z
      .array(
        z
          .object({
            recid: z.string().describe('Record id of this version — feeds zenodo_get_record id.'),
            doi: z.string().optional().describe('DOI of this version; absent on some old records.'),
            version: z
              .string()
              .optional()
              .describe('Version label as deposited; absent when the depositor set none.'),
            title: z.string().describe('Title of this version.'),
            publication_date: z
              .string()
              .optional()
              .describe('Publication date (EDTF as given); absent when not recorded.'),
            index: z
              .number()
              .optional()
              .describe(
                'Position in the series (1 = first version); absent if Zenodo omits version data.',
              ),
            is_latest: z
              .boolean()
              .optional()
              .describe('True for the newest version; absent if Zenodo omits version data.'),
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
              .describe('Unique views of this version; absent when not reported.'),
            downloads: z
              .number()
              .optional()
              .describe('Unique downloads of this version; absent when not reported.'),
          })
          .describe('One version.'),
      )
      .describe('Versions on this page, newest first; empty when not found.'),
  }),
  enrichment: {
    truncated: z.boolean().describe('True when more versions follow this page.'),
    shown: z.number().describe('Versions returned on this page.'),
    cap: z.number().describe('Page size applied.'),
    totalCount: z.number().describe('Number of versions in the series.'),
    notice: z.string().optional().describe('Guidance on paging or a page past the end.'),
  },
  errors: [
    {
      reason: 'invalid_identifier',
      code: JsonRpcErrorCode.ValidationError,
      when: 'id matches no accepted form, or is a GitHub-badge latestdoi id or a non-zenodo.org host',
      recovery:
        'Pass a Zenodo record id (22705923), a DOI (10.5281/zenodo.22705923), or a zenodo.org/records URL as id; for a title or keyword, use zenodo_search_records.',
    },
    {
      reason: 'result_window_exceeded',
      code: JsonRpcErrorCode.ValidationError,
      when: 'page × size exceeds 10,000',
      recovery:
        'Zenodo pages only the first 10,000 versions of a series, and no series comes near that; call zenodo_list_versions with page 1 (total_versions and has_more show how far the series goes).',
    },
    {
      reason: 'record_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Zenodo could not serve this record or its versions page: HTTP 500 after one retry, HTTP 500 while resolving a non-Zenodo DOI, or no complete record response within the time budget (its gateway cuts off near 30 s, which deposits with about 10,000 or more files hit)',
      thrownBy: 'service',
      recovery:
        'Look the record up with zenodo_search_records using query doi:"<its DOI>" (all_versions true) or its title; withdrawn legacy records and deposits with more than about 10,000 files fail on the record endpoint, and if a keyword search also fails, Zenodo is degraded.',
    },
    {
      reason: 'upstream_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'The versions page got no complete response within its time budget',
      retryable: false,
      thrownBy: 'service',
      recovery:
        'Call zenodo_list_versions again with a smaller size (5); this series holds large file manifests.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: "Zenodo answered HTTP 429, or this server's shared Zenodo request budget is spent for the current window",
      retryable: true,
      thrownBy: 'service',
      recovery:
        'Wait for the retryAfter seconds in the error data, then call zenodo_list_versions again with the same arguments.',
    },
  ],

  async handler(input, ctx) {
    ctx.enrich({ truncated: false, shown: 0, cap: input.size, totalCount: 0 });

    if (input.page * input.size > RESULT_WINDOW) {
      throw ctx.fail(
        'result_window_exceeded',
        `page ${input.page} × size ${input.size} is past the first ${RESULT_WINDOW.toLocaleString('en-US')} versions Zenodo pages through.`,
        ctx.recoveryFor('result_window_exceeded'),
      );
    }

    const ref = parseRecordRef(input.id);
    if (ref.kind === 'invalid') {
      throw ctx.fail('invalid_identifier', ref.message, ctx.recoveryFor('invalid_identifier'));
    }
    const service = getZenodoService();
    const inputKind = ref.inputKind;
    const miss = { found: false, input_kind: inputKind, page: input.page, size: input.size };

    let recid: string;
    if (ref.kind === 'external_doi') {
      const resolution = await service.resolveDoi(ref.doi, ref.strippedDoi, ctx);
      if (resolution.status === 'not_on_zenodo') {
        return {
          ...miss,
          ...notOnZenodoMiss(ref.strippedDoi ?? ref.doi),
          has_more: false,
          versions: [],
        };
      }
      recid = resolution.record.recid;
    } else {
      recid = ref.recid;
    }

    let lookup: VersionsLookup = await service.listVersions(recid, input.page, input.size, ctx);
    if (lookup.status === 'not_found' || lookup.total === 0) {
      // A concept id 404s on /versions and a deleted recid answers 200 with no hits; the record GET classifies every miss.
      const record = await service.getRecord(recid, ctx);
      if (record.status !== 'found') {
        return { ...miss, ...recordMiss(recid, record), has_more: false, versions: [] };
      }
      if (record.record.recid !== recid) {
        recid = record.record.recid;
        lookup = await service.listVersions(recid, input.page, input.size, ctx);
      }
      if (lookup.status === 'not_found') lookup = { status: 'ok', total: 0, hits: [] };
      lookup = {
        ...lookup,
        ...(lookup.concept_recid || !record.record.concept_recid
          ? {}
          : { concept_recid: record.record.concept_recid }),
        ...(lookup.concept_doi || !record.record.concept_doi
          ? {}
          : { concept_doi: record.record.concept_doi }),
      };
    }

    const { hits, total } = lookup;
    const latestRecid =
      hits.find((h) => h.is_latest)?.recid ??
      (input.page === 1 ? hits[0]?.recid : await service.latestRecid(recid, ctx));
    const hasMore = input.page * input.size < total;

    ctx.enrich({ shown: hits.length });
    ctx.enrich.total(total);
    if (hasMore) {
      ctx.enrich.truncated({
        shown: hits.length,
        cap: input.size,
        guidance: `Showing ${hits.length} of ${total} versions; call again with page ${input.page + 1}.`,
      });
    } else if (total > 0 && hits.length === 0) {
      ctx.enrich.notice(
        `Page ${input.page} is past the last page (${Math.max(1, Math.ceil(total / input.size))}).`,
      );
    }

    return {
      found: true,
      input_kind: inputKind,
      ...(lookup.concept_recid ? { concept_recid: lookup.concept_recid } : {}),
      ...(lookup.concept_doi ? { concept_doi: lookup.concept_doi } : {}),
      total_versions: total,
      ...(latestRecid ? { latest_recid: latestRecid } : {}),
      page: input.page,
      size: input.size,
      has_more: hasMore,
      ...(hasMore ? { next_page: input.page + 1 } : {}),
      versions: hits,
    };
  },

  format: (result) => {
    const lines: string[] = [`**Found:** ${result.found} | **Input kind:** ${result.input_kind}`];
    if (result.miss_kind) lines.push(`**Miss kind:** ${result.miss_kind}`);
    if (result.guidance) lines.push(`**Guidance:** ${inline(result.guidance)}`);
    const t = result.tombstone;
    if (t) {
      lines.push(
        `**Tombstone:** removed ${t.removal_date ?? 'on an unrecorded date'}; reason: ${t.removal_reason ? inline(t.removal_reason) : 'not given'}`,
      );
      if (t.note) lines.push(quoteBlock(t.note, 'Removal note (untrusted):'));
      if (t.citation_text)
        lines.push(quoteBlock(t.citation_text, 'Tombstone citation (untrusted):'));
    }

    const series = [
      result.concept_recid ? `**Concept record:** ${result.concept_recid}` : undefined,
      result.concept_doi ? `**Concept DOI:** ${result.concept_doi}` : undefined,
      result.total_versions !== undefined ? `**Versions:** ${result.total_versions}` : undefined,
      result.latest_recid ? `**Latest record:** ${result.latest_recid}` : undefined,
    ].filter(Boolean);
    if (series.length) lines.push(series.join(' | '));
    lines.push(
      `**Page:** ${result.page} | **Size:** ${result.size} | **Has more:** ${result.has_more}${result.next_page !== undefined ? ` | **Next page:** ${result.next_page}` : ''}`,
    );

    for (const v of result.versions) {
      lines.push(
        '',
        `### ${v.version ? `${inline(v.version)} — ` : ''}record ${v.recid}${v.is_latest ? ' (latest)' : ''}`,
        `**Title:** ${inline(v.title)}`,
        [
          v.doi ? `**DOI:** ${v.doi}` : undefined,
          v.publication_date ? `**Published:** ${inline(v.publication_date)}` : undefined,
          v.index !== undefined ? `**Index:** ${v.index}` : undefined,
          v.is_latest !== undefined ? `**Latest:** ${v.is_latest}` : undefined,
        ]
          .filter(Boolean)
          .join(' | '),
        `**Files:** ${v.file_count ?? 'not disclosed'} (${v.total_bytes ?? 'not disclosed'} bytes) | **Views:** ${v.views ?? 'not available'} | **Downloads:** ${v.downloads ?? 'not available'}`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
