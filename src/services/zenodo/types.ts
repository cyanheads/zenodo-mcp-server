/**
 * @fileoverview Raw Zenodo (InvenioRDM) response shapes and the normalized domain
 * types the tools consume. Raw fields are optional unless verified always present:
 * upstream omits fields rather than sending null, and old records are sparse.
 * @module services/zenodo/types
 */

// ---------------------------------------------------------------------------
// Raw upstream shapes
// ---------------------------------------------------------------------------

/** Multilingual title/description map (`{ en: '…', de: '…' }`). */
export type RawI18n = Record<string, string | undefined>;

export interface RawIdentifier {
  identifier?: string;
  scheme?: string;
}

export interface RawVocabRef {
  id?: string;
  title?: RawI18n;
}

export interface RawPersonOrOrg {
  family_name?: string;
  given_name?: string;
  identifiers?: RawIdentifier[];
  name?: string;
  type?: string;
}

export interface RawCreator {
  affiliations?: { id?: string; name?: string }[];
  person_or_org?: RawPersonOrOrg;
  role?: RawVocabRef;
}

export interface RawFileEntry {
  checksum?: string;
  key?: string;
  mimetype?: string;
  size?: number;
}

export interface RawFiles {
  count?: number;
  enabled?: boolean;
  entries?: Record<string, RawFileEntry>;
  order?: string[];
  total_bytes?: number;
}

export interface RawDoiPid {
  identifier?: string;
  provider?: string;
}

export interface RawCommunity {
  id?: string;
  metadata?: {
    organizations?: { id?: string; name?: string }[];
    title?: string;
    type?: RawVocabRef;
    website?: string;
  };
  slug?: string;
}

export interface RawFunding {
  award?: {
    acronym?: string;
    id?: string;
    identifiers?: RawIdentifier[];
    number?: string;
    program?: string;
    title?: RawI18n;
  };
  funder?: { id?: string; name?: string };
}

export interface RawStatsBlock {
  downloads?: number;
  unique_downloads?: number;
  unique_views?: number;
  views?: number;
}

export interface RawRecord {
  access?: {
    embargo?: { active?: boolean; reason?: string | null; until?: string };
    files?: string;
    record?: string;
    status?: string;
  };
  custom_fields?: Record<string, unknown>;
  files?: RawFiles;
  id: string;
  metadata?: {
    additional_descriptions?: { description?: string; type?: RawVocabRef }[];
    contributors?: RawCreator[];
    creators?: RawCreator[];
    description?: string;
    funding?: RawFunding[];
    publication_date?: string;
    publisher?: string;
    related_identifiers?: {
      identifier?: string;
      relation_type?: RawVocabRef;
      resource_type?: RawVocabRef;
      scheme?: string;
    }[];
    resource_type?: RawVocabRef;
    rights?: { id?: string; props?: { url?: string }; title?: RawI18n }[];
    subjects?: { subject?: string }[];
    title?: string;
    version?: string;
  };
  parent?: {
    communities?: { entries?: RawCommunity[] };
    id?: string;
    pids?: { doi?: RawDoiPid };
  };
  pids?: { doi?: RawDoiPid; oai?: { identifier?: string } };
  revision_id?: number;
  stats?: { all_versions?: RawStatsBlock; this_version?: RawStatsBlock };
  versions?: { index?: number; is_latest?: boolean };
}

export interface RawTombstone {
  citation_text?: string;
  is_visible?: boolean;
  note?: string;
  removal_date?: string;
  removal_reason?: { id?: string };
}

export interface RawAggregationBucket {
  doc_count?: number;
  inner?: { buckets?: RawAggregationBucket[] };
  key?: string | number;
  label?: string;
}

export interface RawSearchResponse<T = RawRecord> {
  aggregations?: Record<string, { buckets?: RawAggregationBucket[] }>;
  hits?: { hits?: T[]; total?: number };
}

export interface RawContainerEntry {
  compressed_size?: number;
  key?: string;
  mimetype?: string;
  size?: number;
}

export interface RawContainer {
  directories?: unknown[];
  entries?: RawContainerEntry[];
  total?: number;
  truncated?: boolean;
}

export interface RawFunder {
  acronym?: string | null;
  country?: string;
  country_name?: string;
  id?: string;
  identifiers?: RawIdentifier[];
  name?: string;
  title?: RawI18n;
}

export interface RawAward {
  acronym?: string;
  end_date?: string;
  funder?: { id?: string; name?: string };
  id?: string;
  identifiers?: RawIdentifier[];
  number?: string;
  program?: string;
  start_date?: string;
  title?: RawI18n;
}

export interface RawLicense {
  id?: string;
  props?: { osi_approved?: string; url?: string };
  tags?: string[];
  title?: RawI18n;
}

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/** One top-level file in a record's manifest. */
export interface FileEntry {
  download_url: string;
  key: string;
  md5?: string;
  mimetype?: string;
  size?: number;
}

export interface Affiliation {
  name?: string;
  ror?: string;
}

export interface Person {
  affiliations: Affiliation[];
  name: string;
  orcid?: string;
  role?: string;
  type?: string;
}

export interface FundingEntry {
  award_acronym?: string;
  award_doi?: string;
  award_id?: string;
  award_number?: string;
  award_program?: string;
  award_title?: string;
  award_url?: string;
  funder_id?: string;
  funder_name?: string;
}

export interface RelatedIdentifier {
  identifier: string;
  relation?: string;
  resource_type?: string;
  scheme?: string;
}

export interface RecordAccess {
  embargo_active: boolean;
  embargo_reason?: string;
  embargo_until?: string;
  files?: string;
  record?: string;
  status: string;
}

export interface UsageCounts {
  downloads?: number;
  views?: number;
}

/**
 * A fully normalized record: complete lists and the complete file manifest, with
 * descriptions converted to plain text. Tools apply their own display caps.
 */
export interface ZenodoRecord {
  access: RecordAccess;
  additional_descriptions: { text: string; type?: string }[];
  code_repository?: string;
  communities: { slug: string; title?: string }[];
  concept_doi?: string;
  concept_recid?: string;
  contributors: Person[];
  creators: Person[];
  description?: string;
  doi?: string;
  doi_provider?: string;
  files: {
    count?: number;
    enabled: boolean;
    entries: FileEntry[];
    total_bytes?: number;
  };
  funding: FundingEntry[];
  keywords: string[];
  oai_id?: string;
  publication_date?: string;
  publisher?: string;
  recid: string;
  related_identifiers: RelatedIdentifier[];
  resource_type?: { id: string; title?: string };
  revision?: number;
  rights: { id?: string; title: string; url?: string }[];
  stats?: { all_versions: UsageCounts; this_version: UsageCounts };
  title: string;
  version?: string;
  versions: { index?: number; is_latest?: boolean };
}

/** A deleted record's tombstone — the only data a removed record still serves. */
export interface Tombstone {
  citation_text?: string;
  note?: string;
  removal_date?: string;
  removal_reason?: string;
}

/** Outcome of a record GET. A miss is a result, not an error. */
export type RecordLookup =
  | { record: ZenodoRecord; status: 'found' }
  | { status: 'not_found' }
  | { status: 'restricted' }
  | { status: 'deleted'; tombstone: Tombstone };

/** One search hit, file manifest stripped. */
export interface RecordSummary {
  access: { embargo_until?: string; files?: string; status: string };
  communities: string[];
  concept_doi?: string;
  concept_recid?: string;
  creator_count: number;
  creators: { name: string; orcid?: string }[];
  description_snippet?: string;
  doi?: string;
  doi_provider?: string;
  downloads?: number;
  file_count?: number;
  is_latest?: boolean;
  license_ids: string[];
  publication_date?: string;
  recid: string;
  resource_type?: { id: string; title?: string };
  title: string;
  total_bytes?: number;
  version?: string;
  version_index?: number;
  views?: number;
  zenodo_url: string;
}

export interface FacetBucket {
  count: number;
  id: string;
  label: string;
}

export interface SearchFacets {
  access_status: FacetBucket[];
  file_type: FacetBucket[];
  publication_year: { count: number; year: string }[];
  resource_type: (FacetBucket & { subtypes?: FacetBucket[] })[];
  subject: { count: number; label: string }[];
}

export interface SearchPage {
  facets: SearchFacets;
  hits: RecordSummary[];
  total: number;
}

/** One version in a version series. */
export interface VersionSummary {
  doi?: string;
  downloads?: number;
  file_count?: number;
  index?: number;
  is_latest?: boolean;
  publication_date?: string;
  recid: string;
  title: string;
  total_bytes?: number;
  version?: string;
  views?: number;
}

export type VersionsLookup =
  | {
      /** Concept record id of the series, from the first hit's `parent`. */
      concept_recid?: string;
      /** Concept DOI of the series, from the first hit's `parent`. */
      concept_doi?: string;
      hits: VersionSummary[];
      status: 'ok';
      total: number;
    }
  /** `/versions` answered 404, 403, or 410: the id names no listable series. */
  | { status: 'not_found' };

export interface ContainerMember {
  compressed_size?: number;
  mimetype?: string;
  path: string;
  size?: number;
}

/** A ZIP listing as Zenodo serves it (capped at 1,000 nodes upstream). */
export interface ContainerListing {
  directory_count: number;
  members: ContainerMember[];
  total?: number;
  upstream_truncated: boolean;
}

export type ContainerLookup = { listing: ContainerListing; status: 'ok' } | { status: 'not_found' };

/** Result of a byte-capped content read. */
export interface ContentRead {
  bytes: Uint8Array;
  /** Total file size from `Content-Range`, when upstream sent one. */
  fileSize?: number;
  /** True when bytes remain past the returned window. */
  moreRemains: boolean;
  status: 'ok' | 'forbidden' | 'not_found' | 'range_not_satisfiable';
}

export interface CommunityEntry {
  community_type?: string;
  organizations: string[];
  slug: string;
  title?: string;
  uuid: string;
  website?: string;
}

export interface FunderEntry {
  acronym?: string;
  country?: string;
  country_name?: string;
  funder_doi?: string;
  name?: string;
  ror_id: string;
}

export interface AwardEntry {
  acronym?: string;
  award_doi?: string;
  award_url?: string;
  end_date?: string;
  funder_id?: string;
  funder_name?: string;
  id: string;
  number?: string;
  program?: string;
  start_date?: string;
  title?: string;
}

export interface LicenseEntry {
  id: string;
  osi_approved?: boolean;
  tags: string[];
  title?: string;
  url?: string;
}

/** Vocabularies served by the upstream API (resource types are a static table). */
export type RemoteVocabulary = 'communities' | 'funders' | 'awards' | 'licenses';

export type VocabularyPage =
  | { entries: CommunityEntry[]; total: number; vocabulary: 'communities' }
  | { entries: FunderEntry[]; total: number; vocabulary: 'funders' }
  | { entries: AwardEntry[]; total: number; vocabulary: 'awards' }
  | { entries: LicenseEntry[]; total: number; vocabulary: 'licenses' };

/** Citation formats the export endpoint serves. */
export type CitationStyle =
  | 'bibtex'
  | 'csl-json'
  | 'apa'
  | 'chicago-author-date'
  | 'harvard-cite-them-right'
  | 'ieee'
  | 'modern-language-association'
  | 'nature';
