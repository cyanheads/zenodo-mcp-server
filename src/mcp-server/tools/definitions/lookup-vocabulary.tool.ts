/**
 * @fileoverview zenodo_lookup_vocabulary — resolves community, funder, award,
 * license, and resource-type names to the ids zenodo_search_records filters on.
 * The routing target for every unknown-value and zero-hit path.
 * @module mcp-server/tools/definitions/lookup-vocabulary
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { parseFunderRef } from '@/services/zenodo/identifiers.js';
import { filterResourceTypes } from '@/services/zenodo/resource-types.js';
import type { VocabularyPage } from '@/services/zenodo/types.js';
import { getZenodoService } from '@/services/zenodo/zenodo-service.js';
import { inline, quoteBlock } from '../render.js';
import { blankToUndefined } from '../schema-helpers.js';

const VOCABULARIES = ['communities', 'funders', 'awards', 'licenses', 'resource_types'] as const;
const RESULT_WINDOW = 10_000;

const EntrySchema = z
  .object({
    filter_param: z
      .enum(['community', 'funder', 'award', 'license', 'resource_type'])
      .describe('The zenodo_search_records parameter this entry’s filter_value feeds.'),
    filter_value: z
      .string()
      .describe(
        'The id to pass to zenodo_search_records as filter_param (community slug, funder ROR id, award id, license id, or resource type id).',
      ),
    label: z
      .string()
      .describe(
        'Display name: community title, funder name, award acronym (else title or number), license title, or resource type label.',
      ),
    slug: z.string().optional().describe('Community slug (communities).'),
    uuid: z.string().optional().describe('Community UUID (communities).'),
    community_type: z
      .string()
      .optional()
      .describe('Community type, e.g. Organization or Project (communities).'),
    website: z.string().optional().describe('Community website (communities).'),
    organizations: z
      .array(z.string())
      .optional()
      .describe('Organizations behind the community, by name or ROR id (communities).'),
    ror_id: z.string().optional().describe('Funder ROR id (funders).'),
    funder_doi: z
      .string()
      .optional()
      .describe('Crossref Funder Registry DOI, 10.13039/… (funders).'),
    acronym: z.string().optional().describe('Funder or award acronym (funders, awards).'),
    country: z.string().optional().describe('Funder country code, ISO 3166-1 alpha-2 (funders).'),
    country_name: z.string().optional().describe('Funder country name (funders).'),
    number: z.string().optional().describe('Grant number (awards).'),
    title: z.string().optional().describe('Full award title (awards).'),
    program: z.string().optional().describe('Funding program, e.g. HORIZON.2.6 (awards).'),
    funder_id: z.string().optional().describe('ROR id of the awarding funder (awards).'),
    funder_name: z.string().optional().describe('Name of the awarding funder (awards).'),
    award_doi: z.string().optional().describe('Award DOI, e.g. a CORDIS 10.3030/… DOI (awards).'),
    award_url: z.string().optional().describe('Award landing page URL (awards).'),
    start_date: z.string().optional().describe('Award start date (awards).'),
    end_date: z.string().optional().describe('Award end date (awards).'),
    url: z.string().optional().describe('License text URL (licenses).'),
    osi_approved: z
      .boolean()
      .optional()
      .describe(
        'Whether the license is OSI-approved; omitted when upstream does not say (licenses).',
      ),
    tags: z
      .array(z.string())
      .optional()
      .describe('License tags, e.g. recommended, software, data (licenses).'),
    parent_type: z
      .string()
      .optional()
      .describe('Parent type id of a resource subtype (resource_types).'),
    search_value: z
      .string()
      .optional()
      .describe(
        'The value Zenodo’s search matches for this type (<type>::<id> for a subtype); informational — pass filter_value (resource_types).',
      ),
  })
  .describe(
    'One vocabulary entry. Fields beyond filter_param, filter_value, and label are present only for the vocabulary they belong to, and only when Zenodo supplies them.',
  );

type Entry = z.infer<typeof EntrySchema>;

/** Maps a remote vocabulary page to the flat entry shape. */
function toEntries(page: VocabularyPage): Entry[] {
  switch (page.vocabulary) {
    case 'communities':
      return page.entries.map((c) => ({
        filter_param: 'community',
        filter_value: c.slug,
        label: c.title ?? c.slug,
        slug: c.slug,
        uuid: c.uuid,
        ...(c.community_type ? { community_type: c.community_type } : {}),
        ...(c.website ? { website: c.website } : {}),
        ...(c.organizations.length ? { organizations: c.organizations } : {}),
      }));
    case 'funders':
      return page.entries.map((f) => ({
        filter_param: 'funder',
        filter_value: f.ror_id,
        label: f.name ?? f.ror_id,
        ror_id: f.ror_id,
        ...(f.funder_doi ? { funder_doi: f.funder_doi } : {}),
        ...(f.acronym ? { acronym: f.acronym } : {}),
        ...(f.country ? { country: f.country } : {}),
        ...(f.country_name ? { country_name: f.country_name } : {}),
      }));
    case 'awards':
      return page.entries.map((a) => ({
        filter_param: 'award',
        filter_value: a.id,
        label: a.acronym ?? a.title ?? a.number ?? a.id,
        ...(a.number ? { number: a.number } : {}),
        ...(a.acronym ? { acronym: a.acronym } : {}),
        ...(a.title ? { title: a.title } : {}),
        ...(a.program ? { program: a.program } : {}),
        ...(a.funder_id ? { funder_id: a.funder_id } : {}),
        ...(a.funder_name ? { funder_name: a.funder_name } : {}),
        ...(a.award_doi ? { award_doi: a.award_doi } : {}),
        ...(a.award_url ? { award_url: a.award_url } : {}),
        ...(a.start_date ? { start_date: a.start_date } : {}),
        ...(a.end_date ? { end_date: a.end_date } : {}),
      }));
    case 'licenses':
      return page.entries.map((l) => ({
        filter_param: 'license',
        filter_value: l.id,
        label: l.title ?? l.id,
        ...(l.url ? { url: l.url } : {}),
        ...(l.osi_approved !== undefined ? { osi_approved: l.osi_approved } : {}),
        ...(l.tags.length ? { tags: l.tags } : {}),
      }));
  }
}

export const lookupVocabulary = tool('zenodo_lookup_vocabulary', {
  title: 'Look up Zenodo filter ids',
  description:
    "Resolve names to the ids zenodo_search_records filters on, and browse Zenodo's reference vocabularies: communities (slug), funders (ROR id), awards and grants (award id), licenses (license id), and resource types (type id). Search by name, acronym, or keyword; awards can be scoped to one funder. Each entry names the zenodo_search_records parameter its id feeds.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    vocabulary: z
      .enum(VOCABULARIES)
      .describe(
        'Which vocabulary to search: communities, funders, awards (grants), licenses, or resource_types.',
      ),
    query: z
      .preprocess(blankToUndefined, z.string().max(200).optional())
      .describe(
        'Name, acronym, or keyword, e.g. "SYMBA", "wellcome", "mit", "journal article". For resource_types every word must appear in the type id or label. Omit to browse the vocabulary.',
      ),
    funder: z
      .preprocess(blankToUndefined, z.string().max(200).optional())
      .describe(
        'awards only: scope grants to one funder, given as a ROR id (00k4n6c32), a ROR URL, or a Crossref Funder DOI (10.13039/100000002). Resolve a funder name to its ROR id with vocabulary funders first.',
      ),
    page: z.number().int().min(1).default(1).describe('Result page, starting at 1.'),
    size: z.number().int().min(1).max(25).default(10).describe('Entries per page (1–25).'),
  }),
  output: z.object({
    vocabulary: z.enum(VOCABULARIES).describe('The vocabulary searched.'),
    query: z.string().optional().describe('The query as applied; absent when browsing.'),
    total: z.number().describe('Total entries matching the query.'),
    page: z.number().describe('Page returned.'),
    size: z.number().describe('Page size applied.'),
    has_more: z.boolean().describe('True when more pages follow this one.'),
    next_page: z.number().optional().describe('The next page number, when has_more.'),
    entries: z.array(EntrySchema).describe('Matching entries for this page.'),
  }),
  enrichment: {
    truncated: z.boolean().describe('True when more entries exist beyond this page.'),
    shown: z.number().describe('Entries returned on this page.'),
    cap: z.number().describe('Page size applied.'),
    totalCount: z.number().describe('Total entries matching the query.'),
    notice: z
      .string()
      .optional()
      .describe('Guidance on empty results, ambiguous funders, or further pages.'),
  },
  errors: [
    {
      reason: 'funder_only_for_awards',
      code: JsonRpcErrorCode.ValidationError,
      when: 'funder is set with a vocabulary other than awards',
      recovery:
        'Call zenodo_lookup_vocabulary again without funder, or set vocabulary to awards to scope grants by funder.',
    },
    {
      reason: 'unknown_funder',
      code: JsonRpcErrorCode.ValidationError,
      when: 'funder (awards) resolves to no Zenodo funder',
      recovery:
        'Resolve the funder first with zenodo_lookup_vocabulary (vocabulary: funders) and pass its ROR id as funder.',
    },
    {
      reason: 'result_window_exceeded',
      code: JsonRpcErrorCode.ValidationError,
      when: 'page × size exceeds 10,000',
      recovery:
        'Narrow the query and call zenodo_lookup_vocabulary again instead of paging past 10,000 entries.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: "Zenodo answered HTTP 429, or this server's shared Zenodo request budget is spent for the current window",
      retryable: true,
      thrownBy: 'service',
      recovery:
        'Wait for the retryAfter seconds in the error data, then call zenodo_lookup_vocabulary again with the same arguments.',
    },
  ],

  async handler(input, ctx) {
    ctx.enrich({ truncated: false, shown: 0, cap: input.size, totalCount: 0 });

    if (input.funder && input.vocabulary !== 'awards') {
      throw ctx.fail(
        'funder_only_for_awards',
        `funder applies only to vocabulary awards, not ${input.vocabulary}.`,
        {
          ...ctx.recoveryFor('funder_only_for_awards'),
        },
      );
    }
    if (input.page * input.size > RESULT_WINDOW) {
      throw ctx.fail(
        'result_window_exceeded',
        `page ${input.page} × size ${input.size} is past the first ${RESULT_WINDOW.toLocaleString('en-US')} entries.`,
        { ...ctx.recoveryFor('result_window_exceeded') },
      );
    }

    let total: number;
    let entries: Entry[];
    if (input.vocabulary === 'resource_types') {
      const matched = filterResourceTypes(input.query);
      total = matched.length;
      entries = matched.slice((input.page - 1) * input.size, input.page * input.size).map((t) => ({
        filter_param: 'resource_type',
        filter_value: t.id,
        label: t.label,
        ...(t.parentType ? { parent_type: t.parentType } : {}),
        search_value: t.searchValue,
      }));
    } else {
      const service = getZenodoService();
      let funderRor: string | undefined;
      if (input.funder) {
        const ref = parseFunderRef(input.funder);
        const funder = ref ? await service.resolveFunder(ref, ctx) : undefined;
        if (!funder) {
          throw ctx.fail(
            'unknown_funder',
            `"${inline(input.funder)}" is not a known ROR id and no funder carries that Crossref Funder DOI.`,
            { ...ctx.recoveryFor('unknown_funder') },
          );
        }
        funderRor = funder.ror_id;
      }
      const page = await service.searchVocabulary(
        input.vocabulary,
        { query: input.query, funderRor, page: input.page, size: input.size },
        ctx,
      );
      total = page.total;
      entries = toEntries(page);
    }

    const reachable = Math.min(total, RESULT_WINDOW);
    const hasMore = input.page * input.size < reachable;
    ctx.enrich({ shown: entries.length });
    ctx.enrich.total(total);

    const notice: string[] = [];
    if (total === 0) {
      notice.push(
        input.query
          ? `No ${input.vocabulary} matched "${inline(input.query)}"; try a shorter name, the acronym, or the funder's or project's acronym.`
          : `No ${input.vocabulary} entries were returned.`,
      );
    } else if (entries.length === 0) {
      const last = Math.max(1, Math.ceil(reachable / input.size));
      notice.push(
        `Page ${input.page} is past the last page (${last}); call again with page ${last} or lower.`,
      );
    }
    if (input.vocabulary === 'funders' && entries.length > 1) {
      notice.push('Several funders share names across countries; pick by country and ROR id.');
    }
    if (hasMore) {
      notice.push(`Showing ${entries.length} of ${total}; call again with page ${input.page + 1}.`);
      ctx.enrich.truncated({ shown: entries.length, cap: input.size, guidance: notice.join(' ') });
    } else if (notice.length) {
      ctx.enrich.notice(notice.join(' '));
    }

    return {
      vocabulary: input.vocabulary,
      ...(input.query ? { query: input.query } : {}),
      total,
      page: input.page,
      size: input.size,
      has_more: hasMore,
      ...(hasMore ? { next_page: input.page + 1 } : {}),
      entries,
    };
  },

  format: (result) => {
    const lines = [
      `## Zenodo ${result.vocabulary}${result.query ? ` matching "${inline(result.query)}"` : ''}`,
      `**Total:** ${result.total} | **Page:** ${result.page} | **Size:** ${result.size} | **Has more:** ${result.has_more}${result.next_page !== undefined ? ` | **Next page:** ${result.next_page}` : ''}`,
    ];
    for (const e of result.entries) {
      lines.push(
        '',
        `### ${inline(e.label)}`,
        `- **Filter:** ${e.filter_param} = \`${inline(e.filter_value)}\``,
      );
      const field = (label: string, value: string | undefined) => {
        if (value) lines.push(`- **${label}:** ${inline(value)}`);
      };
      field('Slug', e.slug);
      field('UUID', e.uuid);
      field('Community type', e.community_type);
      field('Website', e.website);
      if (e.organizations?.length)
        lines.push(`- **Organizations:** ${e.organizations.map(inline).join('; ')}`);
      field('ROR id', e.ror_id);
      field('Funder DOI', e.funder_doi);
      field('Acronym', e.acronym);
      field('Country', e.country);
      field('Country name', e.country_name);
      field('Number', e.number);
      if (e.title) {
        lines.push(
          /[\r\n\u0085\u2028\u2029]/.test(e.title)
            ? `- **Title:**\n${quoteBlock(e.title, 'Award title (untrusted):')}`
            : `- **Title:** ${e.title}`,
        );
      }
      field('Program', e.program);
      field('Funder id', e.funder_id);
      field('Funder name', e.funder_name);
      field('Award DOI', e.award_doi);
      field('Award URL', e.award_url);
      field('Start date', e.start_date);
      field('End date', e.end_date);
      field('URL', e.url);
      if (e.osi_approved !== undefined) lines.push(`- **OSI approved:** ${e.osi_approved}`);
      if (e.tags?.length) lines.push(`- **Tags:** ${e.tags.map(inline).join(', ')}`);
      field('Parent type', e.parent_type);
      field('Search value', e.search_value);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
