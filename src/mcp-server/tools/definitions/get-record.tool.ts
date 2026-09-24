/**
 * @fileoverview zenodo_get_record — resolves one Zenodo deposit from a record id,
 * Zenodo or external DOI, or zenodo.org/doi.org URL and returns its full metadata,
 * the first 25 files, and optionally a formatted citation. A miss (unknown id,
 * deleted record, restricted metadata, DOI not on Zenodo) is a result, not an error.
 * @module mcp-server/tools/definitions/get-record
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { parseRecordRef, recordUrl } from '@/services/zenodo/identifiers.js';
import type { ZenodoRecord } from '@/services/zenodo/types.js';
import { getZenodoService } from '@/services/zenodo/zenodo-service.js';
import { notOnZenodoMiss, recordMiss, TombstoneSchema } from '../record-miss.js';
import { hasLineBreak, inline, quoteBlock } from '../render.js';
import { enumPreprocess } from '../schema-helpers.js';

const CITATION_STYLES = [
  'bibtex',
  'csl-json',
  'apa',
  'chicago-author-date',
  'harvard-cite-them-right',
  'ieee',
  'modern-language-association',
  'nature',
] as const;

const FILES_CAP = 25;
const PEOPLE_CAP = 25;
const LIST_CAP = 50;
const COMMUNITIES_CAP = 25;
const DESCRIPTION_CAP = 4_000;
const ADDITIONAL_DESCRIPTIONS_CAP = 5;
const ADDITIONAL_DESCRIPTION_TEXT_CAP = 1_000;

const PersonSchema = z
  .object({
    name: z.string().describe('Display name as deposited.'),
    type: z.string().optional().describe('personal or organizational.'),
    orcid: z.string().optional().describe('ORCID iD, when the depositor supplied one.'),
    role: z.string().optional().describe('Contributor role, e.g. Editor (contributors only).'),
    affiliations: z
      .array(
        z
          .object({
            name: z.string().optional().describe('Affiliation name.'),
            ror: z.string().optional().describe('Affiliation ROR id, when linked.'),
          })
          .describe('One affiliation.'),
      )
      .describe('Affiliations as deposited.'),
  })
  .describe('A creator or contributor.');

const UsageSchema = z
  .object({
    views: z
      .number()
      .optional()
      .describe('Unique views, as zenodo.org displays them; absent when not reported.'),
    downloads: z
      .number()
      .optional()
      .describe('Unique downloads, as zenodo.org displays them; absent when not reported.'),
  })
  .describe('Usage counts.');

const RecordSchema = z
  .object({
    recid: z.string().describe('Record id of this version.'),
    concept_recid: z
      .string()
      .optional()
      .describe('Concept record id naming the whole version series; absent if Zenodo omits it.'),
    doi: z.string().optional().describe('DOI of this version; absent on some old records.'),
    doi_provider: z
      .string()
      .optional()
      .describe('datacite (minted by Zenodo) or external (publisher-minted).'),
    concept_doi: z
      .string()
      .optional()
      .describe('Concept DOI of the version series; absent for external DOIs.'),
    oai_id: z.string().optional().describe('OAI-PMH identifier; absent when not assigned.'),
    title: z.string().describe('Title as deposited.'),
    publication_date: z
      .string()
      .optional()
      .describe(
        'Publication date (EDTF as given: 2026-09-11, 2020, 2020-05); absent when not recorded.',
      ),
    version: z
      .string()
      .optional()
      .describe('Version label as deposited; absent when the depositor set none.'),
    publisher: z
      .string()
      .optional()
      .describe('Publisher as deposited (usually Zenodo); absent when not set.'),
    resource_type: z
      .object({
        id: z.string().describe('Resource type id, e.g. dataset or publication-article.'),
        title: z.string().optional().describe('Resource type label, when Zenodo supplies one.'),
      })
      .optional()
      .describe('Resource type; absent when not recorded.'),
    description: z
      .string()
      .optional()
      .describe(
        'Description converted from HTML to plain text, capped at 4,000 characters; absent when the record has none.',
      ),
    description_truncated: z
      .boolean()
      .optional()
      .describe('True when the description was cut at 4,000 characters. Present with description.'),
    description_length: z
      .number()
      .optional()
      .describe(
        'Full plain-text length of the description in characters. Present with description.',
      ),
    additional_descriptions: z
      .array(
        z
          .object({
            type: z.string().optional().describe('Description type, e.g. Notes or Methods.'),
            text: z.string().describe('Plain text, capped at 1,000 characters.'),
          })
          .describe('One additional description.'),
      )
      .describe('Up to 5 additional descriptions.'),
    creators: z.array(PersonSchema).describe('First 25 creators.'),
    creator_count: z.number().describe('Total creators.'),
    contributors: z.array(PersonSchema).describe('First 25 contributors.'),
    contributor_count: z.number().describe('Total contributors.'),
    keywords: z.array(z.string()).describe('Up to 50 subject keywords.'),
    rights: z
      .array(
        z
          .object({
            id: z.string().optional().describe('License id (custom rights may lack one).'),
            title: z.string().describe('License or rights title.'),
            url: z.string().optional().describe('License URL.'),
          })
          .describe('One license or rights statement.'),
      )
      .describe('Licenses and rights. Files carry the deposit’s license.'),
    access: z
      .object({
        status: z
          .string()
          .describe('open, restricted, embargoed, or metadata-only (unknown if Zenodo omits it).'),
        record: z
          .string()
          .optional()
          .describe('Record (metadata) access: public or restricted; absent when not reported.'),
        files: z
          .string()
          .optional()
          .describe('File access: public or restricted; absent when not reported.'),
        embargo_active: z.boolean().describe('True while an embargo is in force.'),
        embargo_until: z.string().optional().describe('Embargo end date, when active.'),
        embargo_reason: z.string().optional().describe('Embargo reason, when active.'),
      })
      .describe('Access status and embargo.'),
    funding: z
      .array(
        z
          .object({
            funder_id: z.string().optional().describe('Funder ROR id.'),
            funder_name: z.string().optional().describe('Funder name.'),
            award_id: z
              .string()
              .optional()
              .describe('Award id (<funder-ror>::<number>) — feeds zenodo_search_records award.'),
            award_number: z.string().optional().describe('Grant number.'),
            award_acronym: z.string().optional().describe('Award acronym.'),
            award_title: z.string().optional().describe('Award title.'),
            award_program: z.string().optional().describe('Funding program.'),
            award_doi: z.string().optional().describe('Award DOI, e.g. 10.3030/101135562.'),
            award_url: z.string().optional().describe('Award landing page URL.'),
          })
          .describe('One funding entry.'),
      )
      .describe('Up to 50 funding entries (funders and grants).'),
    related_identifiers: z
      .array(
        z
          .object({
            identifier: z
              .string()
              .describe('The related identifier (DOI, arXiv id, URL, PMID, …).'),
            scheme: z.string().optional().describe('Identifier scheme, e.g. doi, arxiv, url.'),
            relation: z
              .string()
              .optional()
              .describe('Relation type id, e.g. issupplementto or cites.'),
            resource_type: z.string().optional().describe('Resource type id of the related item.'),
          })
          .describe('One related identifier.'),
      )
      .describe('First 50 related identifiers.'),
    related_identifier_count: z.number().describe('Total related identifiers.'),
    code_repository: z
      .string()
      .optional()
      .describe('Source code repository URL; absent when none is linked.'),
    communities: z
      .array(
        z
          .object({
            slug: z.string().describe('Community slug — feeds zenodo_search_records community.'),
            title: z.string().optional().describe('Community title.'),
          })
          .describe('One community.'),
      )
      .describe('Up to 25 communities holding this record.'),
    versions: z
      .object({
        index: z
          .number()
          .optional()
          .describe(
            'Position of this version in its series (1 = first); absent if Zenodo omits version data.',
          ),
        is_latest: z
          .boolean()
          .optional()
          .describe('True when this is the newest version; absent if Zenodo omits version data.'),
        latest_recid: z
          .string()
          .optional()
          .describe('Record id of the newest version, when this one is not it.'),
      })
      .describe('Version position.'),
    stats: z
      .object({
        this_version: UsageSchema,
        all_versions: UsageSchema,
      })
      .optional()
      .describe(
        'Unique views and downloads for this version and for the whole series; absent when Zenodo reports no usage counts.',
      ),
    files: z
      .object({
        enabled: z.boolean().describe('False for a metadata-only deposit.'),
        count: z
          .number()
          .optional()
          .describe('Total files; absent when files are restricted or embargoed.'),
        total_bytes: z
          .number()
          .optional()
          .describe('Total file size in bytes; absent when files are restricted or embargoed.'),
        shown: z.number().describe('File entries included below.'),
        entries: z
          .array(
            z
              .object({
                key: z.string().describe('File key (path within the deposit).'),
                size: z.number().optional().describe('Size in bytes.'),
                mimetype: z.string().optional().describe('MIME type.'),
                md5: z.string().optional().describe('MD5 checksum (hex).'),
                download_url: z.string().describe('Direct download URL.'),
              })
              .describe('One file.'),
          )
          .describe('First 25 files in upstream order.'),
      })
      .describe('File manifest summary.'),
    revision: z.number().optional().describe('Record revision id; absent when not reported.'),
    zenodo_url: z.string().describe('Record landing page on zenodo.org.'),
  })
  .describe('The deposit’s metadata.');

type RecordView = z.infer<typeof RecordSchema>;

/** Applies get_record's display caps to a normalized record. */
function toRecordView(record: ZenodoRecord, latestRecid: string | undefined): RecordView {
  const description = record.description;
  const entries = record.files.entries.slice(0, FILES_CAP);
  return {
    recid: record.recid,
    ...(record.concept_recid ? { concept_recid: record.concept_recid } : {}),
    ...(record.doi ? { doi: record.doi } : {}),
    ...(record.doi_provider ? { doi_provider: record.doi_provider } : {}),
    ...(record.concept_doi ? { concept_doi: record.concept_doi } : {}),
    ...(record.oai_id ? { oai_id: record.oai_id } : {}),
    title: record.title,
    ...(record.publication_date ? { publication_date: record.publication_date } : {}),
    ...(record.version ? { version: record.version } : {}),
    ...(record.publisher ? { publisher: record.publisher } : {}),
    ...(record.resource_type ? { resource_type: record.resource_type } : {}),
    ...(description
      ? {
          description: description.slice(0, DESCRIPTION_CAP),
          description_truncated: description.length > DESCRIPTION_CAP,
          description_length: description.length,
        }
      : {}),
    additional_descriptions: record.additional_descriptions
      .slice(0, ADDITIONAL_DESCRIPTIONS_CAP)
      .map((d) => ({
        ...(d.type ? { type: d.type } : {}),
        text: d.text.slice(0, ADDITIONAL_DESCRIPTION_TEXT_CAP),
      })),
    creators: record.creators.slice(0, PEOPLE_CAP),
    creator_count: record.creators.length,
    contributors: record.contributors.slice(0, PEOPLE_CAP),
    contributor_count: record.contributors.length,
    keywords: record.keywords.slice(0, LIST_CAP),
    rights: record.rights,
    access: record.access,
    funding: record.funding.slice(0, LIST_CAP),
    related_identifiers: record.related_identifiers.slice(0, LIST_CAP),
    related_identifier_count: record.related_identifiers.length,
    ...(record.code_repository ? { code_repository: record.code_repository } : {}),
    communities: record.communities.slice(0, COMMUNITIES_CAP),
    versions: { ...record.versions, ...(latestRecid ? { latest_recid: latestRecid } : {}) },
    ...(record.stats ? { stats: record.stats } : {}),
    files: {
      enabled: record.files.enabled,
      ...(record.files.count !== undefined ? { count: record.files.count } : {}),
      ...(record.files.total_bytes !== undefined ? { total_bytes: record.files.total_bytes } : {}),
      shown: entries.length,
      entries,
    },
    ...(record.revision !== undefined ? { revision: record.revision } : {}),
    zenodo_url: recordUrl(record.recid),
  };
}

function renderPerson(p: z.infer<typeof PersonSchema>): string {
  const parts = [inline(p.name)];
  if (p.type) parts.push(`[${p.type}]`);
  if (p.orcid) parts.push(`ORCID ${p.orcid}`);
  if (p.role) parts.push(`role: ${inline(p.role)}`);
  const affiliations = p.affiliations
    .map((a) =>
      [a.name ? inline(a.name) : undefined, a.ror ? `ROR ${a.ror}` : undefined]
        .filter(Boolean)
        .join(' '),
    )
    .filter(Boolean);
  if (affiliations.length) parts.push(`— ${affiliations.join('; ')}`);
  return `- ${parts.join(' ')}`;
}

export const getRecord = tool('zenodo_get_record', {
  title: 'Get a Zenodo record',
  description:
    'Resolve one Zenodo deposit from a record id, a Zenodo DOI (10.5281/zenodo.N), a concept DOI or concept record id (resolves to the latest version), another DOI deposited on Zenodo, or a zenodo.org or doi.org URL, and return its full metadata: description, creators with ORCIDs and ROR affiliations, license, access and embargo, funding and grants, related identifiers, communities, version position, usage counts, and the first 25 files. Optionally includes a formatted citation. A miss (an unknown id, a deleted record with its removal tombstone, restricted metadata, or a DOI not registered on Zenodo) returns found: false with guidance instead of an error.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    id: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .describe(
        'The deposit to resolve: a record id (22705923), a Zenodo DOI (10.5281/zenodo.22705923, doi: prefix and any case accepted), a concept DOI or concept record id such as 10.5281/zenodo.591564 (resolves to the latest version), another DOI registered to a Zenodo record, or a zenodo.org/records or doi.org URL.',
      ),
    citation_style: z
      .preprocess(enumPreprocess(CITATION_STYLES), z.enum(CITATION_STYLES).optional())
      .describe(
        'Include a formatted citation of the resolved version: bibtex, csl-json, or a text style (apa, chicago-author-date, harvard-cite-them-right, ieee, modern-language-association, nature). Case, spaces, hyphens, and underscores are ignored when matching (BibTeX, APA, CSL JSON). Omit for none.',
      ),
  }),
  output: z.object({
    found: z.boolean().describe('True when the record resolved.'),
    input_kind: z
      .enum(['record_id', 'zenodo_doi', 'external_doi', 'url'])
      .describe(
        'How id was parsed: record_id (digits), zenodo_doi (10.5281/zenodo.N or zenodo.N), external_doi (another DOI), or url (a zenodo.org or doi.org link).',
      ),
    resolved_from: z
      .enum(['version', 'concept_to_latest', 'external_doi'])
      .optional()
      .describe(
        'How the record was reached: a version id, a concept id resolved to the latest version, or a non-Zenodo DOI. Present when found.',
      ),
    miss_kind: z
      .enum(['not_found', 'deleted', 'restricted', 'not_on_zenodo'])
      .optional()
      .describe('Why nothing resolved. Present when not found.'),
    guidance: z.string().optional().describe('What to do next. Present when not found.'),
    tombstone: TombstoneSchema.optional().describe(
      'Removal tombstone. Present when miss_kind is deleted.',
    ),
    record: RecordSchema.optional().describe('The record. Present when found.'),
    citation: z
      .string()
      .optional()
      .describe('The formatted citation. Present when requested and found.'),
    citation_style: z
      .string()
      .optional()
      .describe('The citation style used. Present with citation.'),
  }),
  enrichment: {
    truncated: z.boolean().describe('True when the record has more files than the 25 shown.'),
    shown: z.number().describe('File entries shown.'),
    cap: z.number().describe('Maximum file entries shown (25).'),
    notice: z.string().optional().describe('File access notes or a pointer to zenodo_list_files.'),
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
      reason: 'record_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Zenodo could not serve this record: HTTP 500 after one retry, HTTP 500 while resolving a non-Zenodo DOI, or no complete response within the time budget (its gateway cuts off near 30 s, which deposits with about 10,000 or more files hit)',
      thrownBy: 'service',
      recovery:
        'Look the record up with zenodo_search_records using query doi:"<its DOI>" (all_versions true) or its title; withdrawn legacy records and deposits with more than about 10,000 files fail on the record endpoint, and if a keyword search also fails, Zenodo is degraded.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: "Zenodo answered HTTP 429, or this server's shared Zenodo request budget is spent for the current window",
      retryable: true,
      thrownBy: 'service',
      recovery:
        'Wait for the retryAfter seconds in the error data, then call zenodo_get_record again with the same arguments.',
    },
  ],

  async handler(input, ctx) {
    ctx.enrich({ truncated: false, shown: 0, cap: FILES_CAP });

    const ref = parseRecordRef(input.id);
    if (ref.kind === 'invalid') {
      throw ctx.fail('invalid_identifier', ref.message, ctx.recoveryFor('invalid_identifier'));
    }
    const service = getZenodoService();
    const inputKind = ref.inputKind;

    let record: ZenodoRecord;
    let resolvedFrom: 'version' | 'concept_to_latest' | 'external_doi';
    if (ref.kind === 'external_doi') {
      const resolution = await service.resolveDoi(ref.doi, ref.strippedDoi, ctx);
      if (resolution.status === 'not_on_zenodo') {
        return {
          found: false,
          input_kind: inputKind,
          ...notOnZenodoMiss(ref.strippedDoi ?? ref.doi),
        };
      }
      record = resolution.record;
      resolvedFrom = 'external_doi';
    } else {
      const lookup = await service.getRecord(ref.recid, ctx);
      if (lookup.status !== 'found') {
        return { found: false, input_kind: inputKind, ...recordMiss(ref.recid, lookup) };
      }
      record = lookup.record;
      resolvedFrom = record.concept_recid === ref.recid ? 'concept_to_latest' : 'version';
    }

    const [latestRecid, citation] = await Promise.all([
      record.versions.is_latest === false ? service.latestRecid(record.recid, ctx) : undefined,
      input.citation_style
        ? service.getCitation(record.recid, input.citation_style, ctx)
        : undefined,
    ]);
    const view = toRecordView(record, latestRecid);

    ctx.enrich({ shown: view.files.shown });
    const fileCount = record.files.count ?? record.files.entries.length;
    if (record.files.enabled && record.access.files === 'restricted') {
      const until = record.access.embargo_until ? ` until ${record.access.embargo_until}` : '';
      ctx.enrich.notice(`Files are ${record.access.status}${until}; metadata only.`);
    } else if (record.files.entries.length > FILES_CAP) {
      ctx.enrich.truncated({
        shown: view.files.shown,
        cap: FILES_CAP,
        guidance: `Showing ${FILES_CAP} of ${fileCount} files; page the rest with zenodo_list_files.`,
      });
    }

    return {
      found: true,
      input_kind: inputKind,
      resolved_from: resolvedFrom,
      record: view,
      ...(citation !== undefined && input.citation_style
        ? { citation, citation_style: input.citation_style }
        : {}),
    };
  },

  format: (result) => {
    const lines: string[] = [
      `**Found:** ${result.found} | **Input kind:** ${result.input_kind}${result.resolved_from ? ` | **Resolved from:** ${result.resolved_from}` : ''}`,
    ];
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

    const r = result.record;
    if (r) {
      lines.push('', `# ${inline(r.title)}`);
      lines.push(
        `**Record:** ${r.recid}${r.concept_recid ? ` | **Concept record:** ${r.concept_recid}` : ''} | **URL:** ${r.zenodo_url}`,
      );
      const ids = [
        r.doi ? `**DOI:** ${r.doi}${r.doi_provider ? ` (${r.doi_provider})` : ''}` : undefined,
        r.concept_doi ? `**Concept DOI:** ${r.concept_doi}` : undefined,
        r.oai_id ? `**OAI:** ${r.oai_id}` : undefined,
      ].filter(Boolean);
      if (ids.length) lines.push(ids.join(' | '));
      const facts = [
        r.resource_type
          ? `**Type:** ${r.resource_type.title ? `${inline(r.resource_type.title)} ` : ''}(${r.resource_type.id})`
          : undefined,
        r.publication_date ? `**Published:** ${inline(r.publication_date)}` : undefined,
        r.version ? `**Version:** ${inline(r.version)}` : undefined,
        r.publisher ? `**Publisher:** ${inline(r.publisher)}` : undefined,
        r.revision !== undefined ? `**Revision:** ${r.revision}` : undefined,
      ].filter(Boolean);
      if (facts.length) lines.push(facts.join(' | '));

      const v = r.versions;
      lines.push(
        `**Version position:** index ${v.index ?? 'unknown'}, latest: ${v.is_latest ?? 'unknown'}${v.latest_recid ? `, latest version is record ${v.latest_recid}` : ''}`,
      );
      const a = r.access;
      lines.push(
        `**Access:** ${a.status}${a.record ? `, record ${a.record}` : ''}${a.files ? `, files ${a.files}` : ''}; embargo active: ${a.embargo_active}${a.embargo_until ? `, until ${a.embargo_until}` : ''}${a.embargo_reason ? `, reason: ${inline(a.embargo_reason)}` : ''}`,
      );
      if (r.rights.length) {
        lines.push(
          `**Rights:** ${r.rights
            .map(
              (x) =>
                `${inline(x.title)}${x.id ? ` (${x.id})` : ''}${x.url ? ` ${inline(x.url)}` : ''}`,
            )
            .join('; ')}`,
        );
      }
      if (r.stats) {
        const s = r.stats;
        lines.push(
          `**Usage:** this version ${s.this_version.views ?? '?'} views / ${s.this_version.downloads ?? '?'} downloads; all versions ${s.all_versions.views ?? '?'} views / ${s.all_versions.downloads ?? '?'} downloads`,
        );
      }
      if (r.code_repository) lines.push(`**Code repository:** ${inline(r.code_repository)}`);

      lines.push('', `### Creators (${r.creator_count})`, ...r.creators.map(renderPerson));
      if (r.contributors.length || r.contributor_count) {
        lines.push(
          '',
          `### Contributors (${r.contributor_count})`,
          ...r.contributors.map(renderPerson),
        );
      }
      if (r.keywords.length) lines.push('', `**Keywords:** ${r.keywords.map(inline).join('; ')}`);
      if (r.communities.length) {
        lines.push(
          `**Communities:** ${r.communities.map((c) => `${inline(c.slug)}${c.title ? ` (${inline(c.title)})` : ''}`).join('; ')}`,
        );
      }

      if (r.funding.length) {
        lines.push('', '### Funding');
        for (const f of r.funding) {
          const funder = [
            f.funder_name ? inline(f.funder_name) : undefined,
            f.funder_id ? `(${f.funder_id})` : undefined,
          ]
            .filter(Boolean)
            .join(' ');
          const award = [
            f.award_acronym ? inline(f.award_acronym) : undefined,
            f.award_number ? `no. ${inline(f.award_number)}` : undefined,
            f.award_id ? `[award id ${inline(f.award_id)}]` : undefined,
            f.award_program ? `program ${inline(f.award_program)}` : undefined,
            f.award_doi ? `DOI ${inline(f.award_doi)}` : undefined,
            f.award_url ? inline(f.award_url) : undefined,
          ]
            .filter(Boolean)
            .join(', ');
          lines.push(`- ${funder || 'Unnamed funder'}${award ? ` — ${award}` : ''}`);
          if (f.award_title) {
            lines.push(
              hasLineBreak(f.award_title)
                ? quoteBlock(f.award_title, '  Award title (untrusted):')
                : `  Award title: ${f.award_title}`,
            );
          }
        }
      }

      if (r.related_identifiers.length || r.related_identifier_count) {
        lines.push('', `### Related identifiers (${r.related_identifier_count})`);
        for (const x of r.related_identifiers) {
          lines.push(
            `- ${x.relation ?? 'related'}: ${inline(x.identifier)}${x.scheme ? ` (${x.scheme})` : ''}${x.resource_type ? ` [${x.resource_type}]` : ''}`,
          );
        }
      }

      if (r.description) {
        lines.push(
          '',
          `### Description (${r.description_length ?? r.description.length} chars${r.description_truncated ? ', truncated to 4,000' : ''})`,
          quoteBlock(r.description),
        );
      } else if (r.description_length !== undefined || r.description_truncated !== undefined) {
        lines.push(
          `Description length: ${r.description_length}, truncated: ${r.description_truncated}`,
        );
      }
      for (const d of r.additional_descriptions) {
        lines.push(
          '',
          `### Additional description${d.type ? ` — ${inline(d.type)}` : ''}`,
          quoteBlock(d.text),
        );
      }

      const files = r.files;
      lines.push(
        '',
        `### Files (enabled: ${files.enabled}, count: ${files.count ?? 'not disclosed'}, total bytes: ${files.total_bytes ?? 'not disclosed'}, shown: ${files.shown})`,
      );
      for (const f of files.entries) {
        lines.push(
          `- ${inline(f.key)} — ${f.size ?? '?'} bytes${f.mimetype ? `, ${f.mimetype}` : ''}${f.md5 ? `, md5 ${f.md5}` : ''} — ${f.download_url}`,
        );
      }
    }

    if (result.citation) {
      lines.push(
        '',
        quoteBlock(
          result.citation,
          `Citation (${result.citation_style ?? 'requested style'}, untrusted):`,
        ),
      );
    } else if (result.citation_style) {
      lines.push(`Citation style: ${result.citation_style}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
