/**
 * @fileoverview zenodo_get_record — resolves one Zenodo deposit from a record id,
 * Zenodo or external DOI, or zenodo.org/doi.org URL and returns its full metadata,
 * the first 25 files, and optionally a formatted citation. Fields cut at a display
 * cap are listed in `continuations` with a cursor; passing one back returns the
 * next window of that field. A miss (unknown id, deleted record, restricted
 * metadata, DOI not on Zenodo) is a result, not an error.
 * @module mcp-server/tools/definitions/get-record
 */

import { type Context, tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { decodeCursor, encodeCursor } from '@cyanheads/mcp-ts-core/utils';
import { parseRecordRef, recordUrl } from '@/services/zenodo/identifiers.js';
import type { ZenodoRecord } from '@/services/zenodo/types.js';
import { getZenodoService } from '@/services/zenodo/zenodo-service.js';
import { notOnZenodoMiss, recordMiss, TombstoneSchema } from '../record-miss.js';
import { hasLineBreak, inline, quoteBlock } from '../render.js';
import { blankToUndefined, enumPreprocess } from '../schema-helpers.js';

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
/** Characters per text window in cursor mode. */
const TEXT_WINDOW = 8_000;

/** The list fields a cursor can page, in record order. */
const LIST_FIELDS = [
  'additional_descriptions',
  'creators',
  'contributors',
  'keywords',
  'funding',
  'related_identifiers',
  'communities',
] as const;
type ListField = (typeof LIST_FIELDS)[number];

const FieldSchema = z.enum(['description', ...LIST_FIELDS] as const);
const UnitSchema = z.enum(['characters', 'entries']);

/** The state a cursor carries: framework pagination state bound to one record revision. */
const CursorStateSchema = z.object({
  offset: z.number().int().min(0),
  limit: z.number().int().min(1),
  recid: z.string(),
  rev: z.number().int().optional(),
  field: FieldSchema,
  index: z.number().int().min(0).optional(),
});
type CursorState = z.infer<typeof CursorStateSchema>;

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

const AdditionalDescriptionSchema = z
  .object({
    type: z.string().optional().describe('Description type, e.g. Notes or Methods.'),
    text: z.string().describe('Plain text, first 1,000 characters.'),
    length: z.number().describe('Full plain-text length in characters.'),
    truncated: z
      .boolean()
      .describe(
        'True when text was cut at 1,000 characters; continuations carries a cursor for the rest.',
      ),
  })
  .describe('One additional description.');

const FundingSchema = z
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
  .describe('One funding entry.');

const RelatedIdentifierSchema = z
  .object({
    identifier: z.string().describe('The related identifier (DOI, arXiv id, URL, PMID, …).'),
    scheme: z.string().optional().describe('Identifier scheme, e.g. doi, arxiv, url.'),
    relation: z.string().optional().describe('Relation type id, e.g. issupplementto or cites.'),
    resource_type: z.string().optional().describe('Resource type id of the related item.'),
  })
  .describe('One related identifier.');

const CommunitySchema = z
  .object({
    slug: z.string().describe('Community slug — feeds zenodo_search_records community.'),
    title: z.string().optional().describe('Community title.'),
  })
  .describe('One community.');

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
        'Description converted from HTML to plain text, first 4,000 characters; absent when the record has none.',
      ),
    description_truncated: z
      .boolean()
      .optional()
      .describe(
        'True when the description was cut at 4,000 characters; continuations carries a cursor for the rest. Present with description.',
      ),
    description_length: z
      .number()
      .optional()
      .describe(
        'Full plain-text length of the description in characters. Present with description.',
      ),
    additional_descriptions: z
      .array(AdditionalDescriptionSchema)
      .describe('First 5 additional descriptions, in record order (index 0 first).'),
    additional_description_count: z.number().describe('Total additional descriptions.'),
    creators: z.array(PersonSchema).describe('First 25 creators.'),
    creator_count: z.number().describe('Total creators.'),
    contributors: z.array(PersonSchema).describe('First 25 contributors.'),
    contributor_count: z.number().describe('Total contributors.'),
    keywords: z.array(z.string()).describe('First 50 subject keywords.'),
    keyword_count: z.number().describe('Total subject keywords.'),
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
    funding: z.array(FundingSchema).describe('First 50 funding entries (funders and grants).'),
    funding_count: z.number().describe('Total funding entries.'),
    related_identifiers: z.array(RelatedIdentifierSchema).describe('First 50 related identifiers.'),
    related_identifier_count: z.number().describe('Total related identifiers.'),
    code_repository: z
      .string()
      .optional()
      .describe('Source code repository URL; absent when none is linked.'),
    communities: z.array(CommunitySchema).describe('First 25 communities holding this record.'),
    community_count: z.number().describe('Total communities holding this record.'),
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

const ContinuationSchema = z
  .object({
    field: FieldSchema.describe('The field that was cut.'),
    index: z
      .number()
      .optional()
      .describe(
        'Position of the additional description whose text was cut (0 = first). Present only for an additional description’s text.',
      ),
    unit: UnitSchema.describe(
      'characters for description text, entries for a list (additional_descriptions without index is the list).',
    ),
    shown: z
      .number()
      .describe(
        'Characters or entries of the field returned so far, counted from its start; the cursor resumes here.',
      ),
    total: z.number().describe('Full length of the field in characters, or its total entries.'),
    id: z
      .string()
      .describe(
        'Record id the cursor is bound to; pass it as id beside the cursor, whatever id form this call took.',
      ),
    cursor: z
      .string()
      .describe('Pass as cursor, with this entry’s id, to get the next window of this field.'),
  })
  .describe('One field cut short in this response.');

const WindowSchema = z
  .object({
    field: FieldSchema.describe('The field this window continues.'),
    index: z
      .number()
      .optional()
      .describe(
        'Position of the additional description whose text this window continues (0 = first). Present only for an additional description’s text.',
      ),
    unit: UnitSchema.describe('characters for a text window, entries for a list window.'),
    offset: z.number().describe('Characters or entries of the field before this window.'),
    shown: z.number().describe('Characters or entries in this window.'),
    total: z.number().describe('Full length of the field in characters, or its total entries.'),
    text: z
      .string()
      .optional()
      .describe(
        'Up to 8,000 characters of the field’s plain text, starting at offset. Present when unit is characters.',
      ),
    additional_descriptions: z
      .array(AdditionalDescriptionSchema)
      .optional()
      .describe(
        'Up to 5 additional descriptions starting at offset, each text cut at 1,000 characters. Present when field is additional_descriptions and unit is entries.',
      ),
    creators: z
      .array(PersonSchema)
      .optional()
      .describe('Up to 25 creators starting at offset. Present when field is creators.'),
    contributors: z
      .array(PersonSchema)
      .optional()
      .describe('Up to 25 contributors starting at offset. Present when field is contributors.'),
    keywords: z
      .array(z.string())
      .optional()
      .describe('Up to 50 subject keywords starting at offset. Present when field is keywords.'),
    funding: z
      .array(FundingSchema)
      .optional()
      .describe('Up to 50 funding entries starting at offset. Present when field is funding.'),
    related_identifiers: z
      .array(RelatedIdentifierSchema)
      .optional()
      .describe(
        'Up to 50 related identifiers starting at offset. Present when field is related_identifiers.',
      ),
    communities: z
      .array(CommunitySchema)
      .optional()
      .describe('Up to 25 communities starting at offset. Present when field is communities.'),
  })
  .describe('One window of a field a previous response cut short.');

type RecordView = z.infer<typeof RecordSchema>;
type AdditionalDescriptionView = z.infer<typeof AdditionalDescriptionSchema>;
type Continuation = z.infer<typeof ContinuationSchema>;
type Window = z.infer<typeof WindowSchema>;
type ListArm = Pick<Window, ListField>;

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;

/** `n`, or `n − 1` when cutting `text` at `n` would split a surrogate pair. */
const cutAt = (text: string, n: number): number =>
  n < text.length && isHighSurrogate(text.charCodeAt(n - 1)) ? n - 1 : n;

function additionalDescriptionView(d: ZenodoRecord['additional_descriptions'][number]) {
  return {
    ...(d.type ? { type: d.type } : {}),
    text: d.text.slice(0, cutAt(d.text, ADDITIONAL_DESCRIPTION_TEXT_CAP)),
    length: d.text.length,
    truncated: d.text.length > ADDITIONAL_DESCRIPTION_TEXT_CAP,
  } satisfies AdditionalDescriptionView;
}

/** A continuation for `field` resuming at `shown`, its cursor bound to this record revision. */
function continuation(
  record: ZenodoRecord,
  cut: Omit<Continuation, 'cursor' | 'id'>,
  limit: number,
): Continuation {
  return {
    ...cut,
    id: record.recid,
    cursor: encodeCursor({
      offset: cut.shown,
      limit,
      recid: record.recid,
      ...(record.revision !== undefined ? { rev: record.revision } : {}),
      field: cut.field,
      ...(cut.index !== undefined ? { index: cut.index } : {}),
    } satisfies CursorState),
  };
}

/** One page of a list field from `offset`, at the field's display cap. */
function listPage(
  record: ZenodoRecord,
  field: ListField,
  offset: number,
): { arm: ListArm; size: number; shown: number; total: number } {
  const page = <T>(all: T[], size: number, arm: (items: T[]) => ListArm) => {
    const items = all.slice(offset, offset + size);
    return { arm: arm(items), size, shown: items.length, total: all.length };
  };
  switch (field) {
    case 'additional_descriptions':
      return page(record.additional_descriptions, ADDITIONAL_DESCRIPTIONS_CAP, (items) => ({
        additional_descriptions: items.map(additionalDescriptionView),
      }));
    case 'creators':
      return page(record.creators, PEOPLE_CAP, (creators) => ({ creators }));
    case 'contributors':
      return page(record.contributors, PEOPLE_CAP, (contributors) => ({ contributors }));
    case 'keywords':
      return page(record.keywords, LIST_CAP, (keywords) => ({ keywords }));
    case 'funding':
      return page(record.funding, LIST_CAP, (funding) => ({ funding }));
    case 'related_identifiers':
      return page(record.related_identifiers, LIST_CAP, (related_identifiers) => ({
        related_identifiers,
      }));
    case 'communities':
      return page(record.communities, COMMUNITIES_CAP, (communities) => ({ communities }));
  }
}

/** Continuations for the cut texts among additional descriptions `from`…`to - 1`. */
function additionalTextCuts(record: ZenodoRecord, from: number, to: number): Continuation[] {
  return record.additional_descriptions.slice(from, to).flatMap((d, i) =>
    d.text.length > ADDITIONAL_DESCRIPTION_TEXT_CAP
      ? [
          continuation(
            record,
            {
              field: 'additional_descriptions',
              index: from + i,
              unit: 'characters',
              shown: cutAt(d.text, ADDITIONAL_DESCRIPTION_TEXT_CAP),
              total: d.text.length,
            },
            TEXT_WINDOW,
          ),
        ]
      : [],
  );
}

/** Every field the record view cuts, in record order; files page through zenodo_list_files instead. */
function recordContinuations(record: ZenodoRecord): Continuation[] {
  const cuts: Continuation[] = [];
  const description = record.description;
  if (description && description.length > DESCRIPTION_CAP) {
    cuts.push(
      continuation(
        record,
        {
          field: 'description',
          unit: 'characters',
          shown: cutAt(description, DESCRIPTION_CAP),
          total: description.length,
        },
        TEXT_WINDOW,
      ),
    );
  }
  for (const field of LIST_FIELDS) {
    const { size, shown, total } = listPage(record, field, 0);
    if (shown < total) {
      cuts.push(continuation(record, { field, unit: 'entries', shown, total }, size));
    }
    if (field === 'additional_descriptions') cuts.push(...additionalTextCuts(record, 0, shown));
  }
  return cuts;
}

/** The window a cursor names in `record`, or why it names none. */
function openWindow(
  record: ZenodoRecord,
  state: CursorState,
): { continuations: Continuation[]; size: number; window: Window } | string {
  const revision = (rev: number | undefined) => (rev === undefined ? '' : ` revision ${rev}`);
  if (state.recid !== record.recid || state.rev !== record.revision) {
    return `The cursor continues record ${state.recid}${revision(state.rev)}, but id resolves to record ${record.recid}${revision(record.revision)}; the cursor belongs to another record or the record has changed since it was issued.`;
  }
  const { field, index, offset } = state;
  const name = `${field}${index === undefined ? '' : ` index ${index}`}`;
  const pastEnd = `The cursor points past the end of ${name} in record ${record.recid}.`;
  const noSuchField = `Record ${record.recid} has no ${name} for the cursor to continue.`;

  const text =
    field === 'description' && index === undefined
      ? record.description
      : field === 'additional_descriptions' && index !== undefined
        ? record.additional_descriptions[index]?.text
        : undefined;
  if (text !== undefined) {
    if (offset >= text.length) return pastEnd;
    const end = cutAt(text, Math.min(offset + TEXT_WINDOW, text.length));
    const cut = { field, ...(index === undefined ? {} : { index }), unit: 'characters' as const };
    return {
      window: {
        ...cut,
        offset,
        shown: end - offset,
        total: text.length,
        text: text.slice(offset, end),
      },
      continuations:
        end < text.length
          ? [continuation(record, { ...cut, shown: end, total: text.length }, TEXT_WINDOW)]
          : [],
      size: TEXT_WINDOW,
    };
  }
  if (field === 'description' || index !== undefined) return noSuchField;

  const page = listPage(record, field, offset);
  if (offset >= page.total) return pastEnd;
  const end = offset + page.shown;
  return {
    window: { field, unit: 'entries', offset, shown: page.shown, total: page.total, ...page.arm },
    continuations: [
      ...(end < page.total
        ? [
            continuation(
              record,
              { field, unit: 'entries', shown: end, total: page.total },
              page.size,
            ),
          ]
        : []),
      ...(field === 'additional_descriptions' ? additionalTextCuts(record, offset, end) : []),
    ],
    size: page.size,
  };
}

/** The continuation state `cursor` carries, or undefined when it is not one this tool issued. */
function readCursor(cursor: string, ctx: Context): CursorState | undefined {
  let decoded: unknown;
  try {
    decoded = decodeCursor(cursor, ctx);
  } catch {
    return;
  }
  const state = CursorStateSchema.safeParse(decoded);
  return state.success ? state.data : undefined;
}

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
          description: description.slice(0, cutAt(description, DESCRIPTION_CAP)),
          description_truncated: description.length > DESCRIPTION_CAP,
          description_length: description.length,
        }
      : {}),
    additional_descriptions: record.additional_descriptions
      .slice(0, ADDITIONAL_DESCRIPTIONS_CAP)
      .map(additionalDescriptionView),
    additional_description_count: record.additional_descriptions.length,
    creators: record.creators.slice(0, PEOPLE_CAP),
    creator_count: record.creators.length,
    contributors: record.contributors.slice(0, PEOPLE_CAP),
    contributor_count: record.contributors.length,
    keywords: record.keywords.slice(0, LIST_CAP),
    keyword_count: record.keywords.length,
    rights: record.rights,
    access: record.access,
    funding: record.funding.slice(0, LIST_CAP),
    funding_count: record.funding.length,
    related_identifiers: record.related_identifiers.slice(0, LIST_CAP),
    related_identifier_count: record.related_identifiers.length,
    ...(record.code_repository ? { code_repository: record.code_repository } : {}),
    communities: record.communities.slice(0, COMMUNITIES_CAP),
    community_count: record.communities.length,
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
  if (p.type) parts.push(`[${inline(p.type)}]`);
  if (p.orcid) parts.push(`ORCID ${inline(p.orcid)}`);
  if (p.role) parts.push(`role: ${inline(p.role)}`);
  const affiliations = p.affiliations
    .map((a) =>
      [a.name ? inline(a.name) : undefined, a.ror ? `ROR ${inline(a.ror)}` : undefined]
        .filter(Boolean)
        .join(' '),
    )
    .filter(Boolean);
  if (affiliations.length) parts.push(`— ${affiliations.join('; ')}`);
  return `- ${parts.join(' ')}`;
}

function renderFunding(f: z.infer<typeof FundingSchema>): string[] {
  const funder = [
    f.funder_name ? inline(f.funder_name) : undefined,
    f.funder_id ? `(${inline(f.funder_id)})` : undefined,
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
  const lines = [`- ${funder || 'Unnamed funder'}${award ? ` — ${award}` : ''}`];
  if (f.award_title) {
    lines.push(
      hasLineBreak(f.award_title)
        ? quoteBlock(f.award_title, '  Award title (untrusted):')
        : `  Award title: ${f.award_title}`,
    );
  }
  return lines;
}

function renderRelated(x: z.infer<typeof RelatedIdentifierSchema>): string {
  return `- ${inline(x.relation ?? 'related')}: ${inline(x.identifier)}${x.scheme ? ` (${inline(x.scheme)})` : ''}${x.resource_type ? ` [${inline(x.resource_type)}]` : ''}`;
}

function renderCommunities(communities: z.infer<typeof CommunitySchema>[]): string {
  return communities
    .map((c) => `${inline(c.slug)}${c.title ? ` (${inline(c.title)})` : ''}`)
    .join('; ');
}

/** One additional description at its position in the record, with its length and any cut. */
function renderAdditionalDescription(
  d: AdditionalDescriptionView,
  index: number,
  total: number,
): string[] {
  return [
    '',
    `### Additional description${d.type ? ` — ${inline(d.type)}` : ''} (index ${index} of ${total}: ${d.length} chars${d.truncated ? ', truncated to 1,000' : ''})`,
    quoteBlock(d.text),
  ];
}

/** Every continuation of one response names the same record id, so the heading names it once. */
function renderContinuations(continuations: Continuation[]): string[] {
  return [
    '',
    `### Continuations (pass a cursor with id ${continuations[0]?.id} for the next window)`,
    ...continuations.map(
      (c) =>
        `- ${c.field}${c.index === undefined ? '' : ` index ${c.index}`}: ${c.shown} of ${c.total} ${c.unit} returned so far — cursor: \`${c.cursor}\``,
    ),
  ];
}

function renderWindow(w: Window): string[] {
  const lines = [
    '',
    `### Window: ${w.field}${w.index === undefined ? '' : ` index ${w.index}`} — ${w.unit} from offset ${w.offset}, ${w.shown} shown of ${w.total}`,
  ];
  if (w.text !== undefined) lines.push(quoteBlock(w.text));
  if (w.additional_descriptions) {
    w.additional_descriptions.forEach((d, i) => {
      lines.push(...renderAdditionalDescription(d, w.offset + i, w.total));
    });
  }
  if (w.creators) lines.push(...w.creators.map(renderPerson));
  if (w.contributors) lines.push(...w.contributors.map(renderPerson));
  if (w.keywords) lines.push(`**Keywords:** ${w.keywords.map(inline).join('; ')}`);
  if (w.funding) lines.push(...w.funding.flatMap(renderFunding));
  if (w.related_identifiers) lines.push(...w.related_identifiers.map(renderRelated));
  if (w.communities) lines.push(`**Communities:** ${renderCommunities(w.communities)}`);
  return lines;
}

export const getRecord = tool('zenodo_get_record', {
  title: 'Get a Zenodo record',
  description:
    'Resolve one Zenodo deposit from a record id, a Zenodo DOI (10.5281/zenodo.N), a concept DOI or concept record id (resolves to the latest version), another DOI deposited on Zenodo, or a zenodo.org or doi.org URL, and return its full metadata: description, creators with ORCIDs and ROR affiliations, license, access and embargo, funding and grants, related identifiers, communities, version position, usage counts, and the first 25 files. Optionally includes a formatted citation. Long text and lists are cut at display caps with their totals reported; every cut except the file list (paged with zenodo_list_files) is listed in continuations with a cursor and the record id it is bound to, and passing both back returns the next window of that field (8,000 characters of text, or the next page of entries) in place of the record. A miss (an unknown id, a deleted record with its removal tombstone, restricted metadata, or a DOI not registered on Zenodo) returns found: false with guidance instead of an error.',
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
    cursor: z
      .preprocess(blankToUndefined, z.string().max(500).optional())
      .describe(
        'A continuations[].cursor from an earlier zenodo_get_record response, passed unchanged with that continuation’s id as id. Returns that field’s next window (8,000 characters of text, or the next page of entries) as window, in place of record. Omit to get the record.',
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
    record: RecordSchema.optional().describe(
      'The record. Present when found and no cursor was passed.',
    ),
    window: WindowSchema.optional().describe(
      'The next window of the field the cursor continues. Present when found and a cursor was passed, in place of record.',
    ),
    continuations: z
      .array(ContinuationSchema)
      .optional()
      .describe(
        'Every field this response cut short, each with a cursor for the rest. Absent when nothing was cut; files are paged with zenodo_list_files instead.',
      ),
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
    truncated: z
      .boolean()
      .describe(
        'Without cursor: true when anything was cut, files past the 25 shown or any field in continuations. With cursor: true when the field continues past this window.',
      ),
    shown: z
      .number()
      .describe(
        'Without cursor: file entries shown. With cursor: characters or entries in the window.',
      ),
    cap: z
      .number()
      .describe(
        'Without cursor: maximum file entries shown (25). With cursor: the window size (8,000 characters, or the field’s page of entries).',
      ),
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
      reason: 'invalid_cursor',
      code: JsonRpcErrorCode.ValidationError,
      when: 'cursor is not one this tool returned in continuations, belongs to another record, or the record was edited after the cursor was issued',
      recovery:
        'Pass the cursor with the record id the message names as id to continue that record; otherwise call zenodo_get_record with this id and no cursor for this record’s own continuations, and pass one of those cursors unchanged with the id it lists.',
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
      throw ctx.fail('invalid_identifier', ref.message);
    }
    const cursor = input.cursor === undefined ? undefined : readCursor(input.cursor, ctx);
    if (input.cursor !== undefined && !cursor) {
      throw ctx.fail(
        'invalid_cursor',
        'The cursor is not a zenodo_get_record continuation; it may be cut short or altered.',
      );
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

    const opened = cursor && openWindow(record, cursor);
    if (typeof opened === 'string') throw ctx.fail('invalid_cursor', opened);

    const [latestRecid, citation] = await Promise.all([
      !opened && record.versions.is_latest === false
        ? service.latestRecid(record.recid, ctx)
        : undefined,
      input.citation_style
        ? service.getCitation(record.recid, input.citation_style, ctx)
        : undefined,
    ]);
    const cited =
      citation !== undefined && input.citation_style
        ? { citation, citation_style: input.citation_style }
        : {};

    if (opened) {
      const { window, continuations, size } = opened;
      ctx.enrich({
        truncated: window.offset + window.shown < window.total,
        shown: window.shown,
        cap: size,
      });
      return {
        found: true,
        input_kind: inputKind,
        resolved_from: resolvedFrom,
        window,
        ...(continuations.length ? { continuations } : {}),
        ...cited,
      };
    }

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
        guidance: `Showing ${FILES_CAP} of ${fileCount.toLocaleString('en-US')} files; page the rest with zenodo_list_files.`,
      });
    }
    const continuations = recordContinuations(record);
    if (continuations.length) ctx.enrich({ truncated: true });

    return {
      found: true,
      input_kind: inputKind,
      resolved_from: resolvedFrom,
      record: view,
      ...(continuations.length ? { continuations } : {}),
      ...cited,
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
        `**Tombstone:** removed ${inline(t.removal_date ?? 'on an unrecorded date')}; reason: ${t.removal_reason ? inline(t.removal_reason) : 'not given'}`,
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
        r.doi
          ? `**DOI:** ${inline(r.doi)}${r.doi_provider ? ` (${inline(r.doi_provider)})` : ''}`
          : undefined,
        r.concept_doi ? `**Concept DOI:** ${inline(r.concept_doi)}` : undefined,
        r.oai_id ? `**OAI:** ${inline(r.oai_id)}` : undefined,
      ].filter(Boolean);
      if (ids.length) lines.push(ids.join(' | '));
      const facts = [
        r.resource_type
          ? `**Type:** ${r.resource_type.title ? `${inline(r.resource_type.title)} ` : ''}(${inline(r.resource_type.id)})`
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
        `**Access:** ${inline(a.status)}${a.record ? `, record ${inline(a.record)}` : ''}${a.files ? `, files ${inline(a.files)}` : ''}; embargo active: ${a.embargo_active}${a.embargo_until ? `, until ${inline(a.embargo_until)}` : ''}${a.embargo_reason ? `, reason: ${inline(a.embargo_reason)}` : ''}`,
      );
      if (r.rights.length) {
        lines.push(
          `**Rights:** ${r.rights
            .map(
              (x) =>
                `${inline(x.title)}${x.id ? ` (${inline(x.id)})` : ''}${x.url ? ` ${inline(x.url)}` : ''}`,
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
      if (r.keywords.length || r.keyword_count) {
        lines.push('', `**Keywords (${r.keyword_count}):** ${r.keywords.map(inline).join('; ')}`);
      }
      if (r.communities.length || r.community_count) {
        lines.push(`**Communities (${r.community_count}):** ${renderCommunities(r.communities)}`);
      }

      if (r.funding.length || r.funding_count) {
        lines.push('', `### Funding (${r.funding_count})`, ...r.funding.flatMap(renderFunding));
      }

      if (r.related_identifiers.length || r.related_identifier_count) {
        lines.push(
          '',
          `### Related identifiers (${r.related_identifier_count})`,
          ...r.related_identifiers.map(renderRelated),
        );
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
      r.additional_descriptions.forEach((d, i) => {
        lines.push(...renderAdditionalDescription(d, i, r.additional_description_count));
      });

      const files = r.files;
      lines.push(
        '',
        `### Files (enabled: ${files.enabled}, count: ${files.count ?? 'not disclosed'}, total bytes: ${files.total_bytes ?? 'not disclosed'}, shown: ${files.shown})`,
      );
      for (const f of files.entries) {
        lines.push(
          `- ${inline(f.key)} — ${f.size ?? '?'} bytes${f.mimetype ? `, ${inline(f.mimetype)}` : ''}${f.md5 ? `, md5 ${inline(f.md5)}` : ''} — ${f.download_url}`,
        );
      }
    }
    if (result.window) lines.push(...renderWindow(result.window));
    if (result.continuations) lines.push(...renderContinuations(result.continuations));

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
