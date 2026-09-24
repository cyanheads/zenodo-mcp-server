/**
 * @fileoverview Raw InvenioRDM JSON → domain types. Strips embedded file manifests
 * from search and version hits, converts HTML descriptions to plain text, and keeps
 * absent upstream fields absent instead of coercing them to `0`, `''`, or `false`.
 * @module services/zenodo/normalize
 */

import { htmlToText } from './html-to-text.js';
import { downloadUrl, recordUrl } from './identifiers.js';
import type {
  AwardEntry,
  CommunityEntry,
  ContainerListing,
  FacetBucket,
  FileEntry,
  FunderEntry,
  LicenseEntry,
  Person,
  RawAggregationBucket,
  RawAward,
  RawCommunity,
  RawContainer,
  RawCreator,
  RawFiles,
  RawFunder,
  RawI18n,
  RawIdentifier,
  RawLicense,
  RawRecord,
  RawSearchResponse,
  RawStatsBlock,
  RawTombstone,
  RecordSummary,
  SearchFacets,
  Tombstone,
  UsageCounts,
  VersionSummary,
  ZenodoRecord,
} from './types.js';

/**
 * `{ [key]: value }` when the value is present, `{}` otherwise — for building
 * objects under `exactOptionalPropertyTypes`. `null` and `''` count as absent.
 */
export function opt<K extends string, V>(
  key: K,
  value: V | null | undefined,
): Partial<Record<K, V>> {
  return value === undefined || value === null || value === ''
    ? {}
    : ({ [key]: value } as Partial<Record<K, V>>);
}

/** English value of a multilingual map, else the first non-empty value. */
function i18n(map: RawI18n | undefined): string | undefined {
  if (!map) return;
  return map.en || Object.values(map).find((v) => v) || undefined;
}

function identifierOf(ids: RawIdentifier[] | undefined, scheme: string): string | undefined {
  return ids?.find((i) => i.scheme?.toLowerCase() === scheme)?.identifier || undefined;
}

function counts(block: RawStatsBlock | undefined): UsageCounts {
  return { ...opt('views', block?.unique_views), ...opt('downloads', block?.unique_downloads) };
}

function stripMd5(checksum: string | undefined): string | undefined {
  if (!checksum) return;
  return checksum.startsWith('md5:') ? checksum.slice(4) : undefined;
}

function normalizePerson(raw: RawCreator): Person {
  const p = raw.person_or_org ?? {};
  const name =
    p.name || [p.given_name, p.family_name].filter(Boolean).join(' ') || p.family_name || '';
  return {
    name,
    ...opt('type', p.type),
    ...opt('orcid', identifierOf(p.identifiers, 'orcid')),
    ...opt('role', raw.role ? (i18n(raw.role.title) ?? raw.role.id) : undefined),
    affiliations: (raw.affiliations ?? [])
      .filter((a) => a.name || a.id)
      .map((a) => ({ ...opt('name', a.name), ...opt('ror', a.id) })),
  };
}

/** The complete manifest in upstream order (`files.order` when non-empty, else object order). */
function normalizeManifest(recid: string, files: RawFiles | undefined): FileEntry[] {
  const entries = files?.entries ?? {};
  const keys = files?.order?.length
    ? files.order.filter((k) => k in entries)
    : Object.keys(entries);
  return keys.map((mapKey) => {
    const e = entries[mapKey] ?? {};
    const key = e.key ?? mapKey;
    return {
      key,
      ...opt('size', e.size),
      ...opt('mimetype', e.mimetype),
      ...opt('md5', stripMd5(e.checksum)),
      download_url: downloadUrl(recid, key),
    };
  });
}

function embargoUntil(raw: RawRecord): string | undefined {
  const embargo = raw.access?.embargo;
  return embargo?.active ? embargo.until : undefined;
}

/** Normalizes a full RDM record (from a record GET or a search hit). */
export function normalizeRecord(raw: RawRecord): ZenodoRecord {
  const m = raw.metadata ?? {};
  const recid = String(raw.id);
  const description = m.description ? htmlToText(m.description) : undefined;
  const embargo = raw.access?.embargo;
  const codeRepository = raw.custom_fields?.['code:codeRepository'];

  return {
    recid,
    ...opt('concept_recid', raw.parent?.id),
    ...opt('doi', raw.pids?.doi?.identifier),
    ...opt('doi_provider', raw.pids?.doi?.provider),
    ...opt('concept_doi', raw.parent?.pids?.doi?.identifier),
    ...opt('oai_id', raw.pids?.oai?.identifier),
    title: m.title ?? '',
    ...opt('publication_date', m.publication_date),
    ...opt('version', m.version),
    ...opt('publisher', m.publisher),
    ...(m.resource_type?.id
      ? { resource_type: { id: m.resource_type.id, ...opt('title', i18n(m.resource_type.title)) } }
      : {}),
    ...opt('description', description),
    additional_descriptions: (m.additional_descriptions ?? [])
      .filter((d) => d.description)
      .map((d) => ({
        ...opt('type', d.type ? (i18n(d.type.title) ?? d.type.id) : undefined),
        text: htmlToText(d.description ?? ''),
      })),
    creators: (m.creators ?? []).map(normalizePerson),
    contributors: (m.contributors ?? []).map(normalizePerson),
    keywords: (m.subjects ?? []).map((s) => s.subject).filter((s): s is string => !!s),
    rights: (m.rights ?? []).map((r) => ({
      ...opt('id', r.id),
      title: i18n(r.title) ?? r.id ?? '',
      ...opt('url', r.props?.url),
    })),
    access: {
      status: raw.access?.status ?? 'unknown',
      ...opt('record', raw.access?.record),
      ...opt('files', raw.access?.files),
      embargo_active: embargo?.active === true,
      ...opt('embargo_until', embargoUntil(raw)),
      ...opt('embargo_reason', embargo?.active ? embargo.reason : undefined),
    },
    funding: (m.funding ?? []).map((f) => ({
      ...opt('funder_id', f.funder?.id),
      ...opt('funder_name', f.funder?.name),
      ...opt('award_id', f.award?.id),
      ...opt('award_number', f.award?.number),
      ...opt('award_acronym', f.award?.acronym),
      ...opt('award_title', i18n(f.award?.title)),
      ...opt('award_program', f.award?.program),
      ...opt('award_doi', identifierOf(f.award?.identifiers, 'doi')),
      ...opt('award_url', identifierOf(f.award?.identifiers, 'url')),
    })),
    related_identifiers: (m.related_identifiers ?? [])
      .filter((r) => r.identifier)
      .map((r) => ({
        identifier: r.identifier ?? '',
        ...opt('scheme', r.scheme),
        ...opt('relation', r.relation_type?.id),
        ...opt('resource_type', r.resource_type?.id),
      })),
    ...opt('code_repository', typeof codeRepository === 'string' ? codeRepository : undefined),
    communities: (raw.parent?.communities?.entries ?? [])
      .filter((c) => c.slug)
      .map((c) => ({ slug: c.slug ?? '', ...opt('title', c.metadata?.title) })),
    versions: {
      ...opt('index', raw.versions?.index),
      ...opt('is_latest', raw.versions?.is_latest),
    },
    ...(raw.stats
      ? {
          stats: {
            this_version: counts(raw.stats.this_version),
            all_versions: counts(raw.stats.all_versions),
          },
        }
      : {}),
    files: {
      enabled: raw.files?.enabled === true,
      ...opt('count', raw.files?.count),
      ...opt('total_bytes', raw.files?.total_bytes),
      entries: normalizeManifest(recid, raw.files),
    },
    ...opt('revision', raw.revision_id),
  };
}

/** Normalizes a 410 tombstone body. */
export function normalizeTombstone(raw: RawTombstone | undefined): Tombstone {
  return {
    ...opt('removal_date', raw?.removal_date),
    ...opt('removal_reason', raw?.removal_reason?.id),
    ...opt('note', raw?.note),
    ...opt('citation_text', raw?.citation_text),
  };
}

/** First `max` characters at a word boundary, with `…` when cut. */
function snippet(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Normalizes a search hit to a summary, dropping its embedded file manifest. */
export function normalizeSearchHit(raw: RawRecord): RecordSummary {
  const m = raw.metadata ?? {};
  const recid = String(raw.id);
  const creators = m.creators ?? [];
  const description = m.description ? htmlToText(m.description) : undefined;
  return {
    recid,
    ...opt('doi', raw.pids?.doi?.identifier),
    ...opt('doi_provider', raw.pids?.doi?.provider),
    ...opt('concept_recid', raw.parent?.id),
    ...opt('concept_doi', raw.parent?.pids?.doi?.identifier),
    title: m.title ?? '',
    ...opt('publication_date', m.publication_date),
    ...(m.resource_type?.id
      ? { resource_type: { id: m.resource_type.id, ...opt('title', i18n(m.resource_type.title)) } }
      : {}),
    ...opt('version', m.version),
    ...opt('is_latest', raw.versions?.is_latest),
    ...opt('version_index', raw.versions?.index),
    creators: creators.slice(0, 5).map((c) => {
      const p = normalizePerson(c);
      return { name: p.name, ...opt('orcid', p.orcid) };
    }),
    creator_count: creators.length,
    license_ids: (m.rights ?? []).map((r) => r.id).filter((id): id is string => !!id),
    access: {
      status: raw.access?.status ?? 'unknown',
      ...opt('files', raw.access?.files),
      ...opt('embargo_until', embargoUntil(raw)),
    },
    communities: (raw.parent?.communities?.entries ?? [])
      .map((c) => c.slug)
      .filter((s): s is string => !!s)
      .slice(0, 5),
    ...opt('file_count', raw.files?.count),
    ...opt('total_bytes', raw.files?.total_bytes),
    ...opt('views', raw.stats?.all_versions?.unique_views),
    ...opt('downloads', raw.stats?.all_versions?.unique_downloads),
    ...opt('description_snippet', description ? snippet(description, 280) : undefined),
    zenodo_url: recordUrl(recid),
  };
}

function bucket(b: RawAggregationBucket): FacetBucket {
  const id = String(b.key ?? '');
  return { id, label: b.label ?? id, count: b.doc_count ?? 0 };
}

/** Facet counts from search aggregations. */
export function normalizeFacets(aggs: RawSearchResponse['aggregations']): SearchFacets {
  const buckets = (name: string) => aggs?.[name]?.buckets ?? [];
  return {
    resource_type: buckets('resource_type')
      .slice(0, 10)
      .map((b) => {
        const subtypes = (b.inner?.buckets ?? []).slice(0, 5).map(bucket);
        return { ...bucket(b), ...(subtypes.length ? { subtypes } : {}) };
      }),
    access_status: buckets('access_status').map(bucket),
    file_type: buckets('file_type').slice(0, 10).map(bucket),
    subject: buckets('subject')
      .slice(0, 10)
      .map((b) => ({ label: b.label ?? String(b.key ?? ''), count: b.doc_count ?? 0 })),
    publication_year: buckets('publication_date')
      .map((b) => ({ year: String(b.key ?? ''), count: b.doc_count ?? 0 }))
      .sort((a, b) => b.year.localeCompare(a.year))
      .slice(0, 10),
  };
}

/** Normalizes a version hit (manifest stripped; this-version usage counts). */
export function normalizeVersionHit(raw: RawRecord): VersionSummary {
  const m = raw.metadata ?? {};
  return {
    recid: String(raw.id),
    ...opt('doi', raw.pids?.doi?.identifier),
    ...opt('version', m.version),
    title: m.title ?? '',
    ...opt('publication_date', m.publication_date),
    ...opt('index', raw.versions?.index),
    ...opt('is_latest', raw.versions?.is_latest),
    ...opt('file_count', raw.files?.count),
    ...opt('total_bytes', raw.files?.total_bytes),
    ...opt('views', raw.stats?.this_version?.unique_views),
    ...opt('downloads', raw.stats?.this_version?.unique_downloads),
  };
}

/** Normalizes a `/container` listing. */
export function normalizeContainer(raw: RawContainer): ContainerListing {
  return {
    members: (raw.entries ?? [])
      .filter((e) => e.key)
      .map((e) => ({
        path: e.key ?? '',
        ...opt('size', e.size),
        ...opt('compressed_size', e.compressed_size),
        ...opt('mimetype', e.mimetype),
      })),
    ...opt('total', raw.total),
    upstream_truncated: raw.truncated === true,
    directory_count: raw.directories?.length ?? 0,
  };
}

export function normalizeCommunity(raw: RawCommunity): CommunityEntry {
  const m = raw.metadata ?? {};
  return {
    slug: raw.slug ?? '',
    uuid: raw.id ?? '',
    ...opt('title', m.title),
    ...opt('community_type', m.type ? (i18n(m.type.title) ?? m.type.id) : undefined),
    ...opt('website', m.website),
    organizations: (m.organizations ?? [])
      .map((o) => o.name || (o.id ? `ROR ${o.id}` : ''))
      .filter(Boolean),
  };
}

export function normalizeFunder(raw: RawFunder): FunderEntry {
  return {
    ror_id: raw.id ?? '',
    ...opt('name', raw.name ?? i18n(raw.title)),
    ...opt('funder_doi', identifierOf(raw.identifiers, 'doi')),
    ...opt('acronym', raw.acronym),
    ...opt('country', raw.country),
    ...opt('country_name', raw.country_name),
  };
}

export function normalizeAward(raw: RawAward): AwardEntry {
  return {
    id: raw.id ?? '',
    ...opt('number', raw.number),
    ...opt('acronym', raw.acronym),
    ...opt('title', i18n(raw.title)),
    ...opt('program', raw.program),
    ...opt('funder_id', raw.funder?.id),
    ...opt('funder_name', raw.funder?.name),
    ...opt('award_doi', identifierOf(raw.identifiers, 'doi')),
    ...opt('award_url', identifierOf(raw.identifiers, 'url')),
    ...opt('start_date', raw.start_date),
    ...opt('end_date', raw.end_date),
  };
}

export function normalizeLicense(raw: RawLicense): LicenseEntry {
  const osi = raw.props?.osi_approved;
  return {
    id: raw.id ?? '',
    ...opt('title', i18n(raw.title)),
    ...opt('url', raw.props?.url),
    ...(osi === 'y' || osi === 'n' ? { osi_approved: osi === 'y' } : {}),
    tags: raw.tags ?? [],
  };
}
