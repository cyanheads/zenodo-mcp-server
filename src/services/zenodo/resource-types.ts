/**
 * @fileoverview Static table of Zenodo's 43 resource types (the entries of
 * `/api/vocabularies/resourcetypes`, verified 2026-09-23). Source of the search
 * `resource_type` enum, of the parent type a subtype's search clause needs, and of
 * the `resource_types` vocabulary lookup.
 * @module services/zenodo/resource-types
 */

/** One resource type. `searchValue` is Zenodo's own spelling of it (`<type>::<id>` for a subtype). */
export interface ResourceType {
  id: string;
  label: string;
  /** Parent type id for a subtype; absent for a top-level type. */
  parentType?: string;
  searchValue: string;
}

/** `[id, label]` for top-level types, `[id, label, parent]` for subtypes. */
const ENTRIES: readonly (readonly [string, string] | readonly [string, string, string])[] = [
  ['dataset', 'Dataset'],
  ['event', 'Event'],
  ['image', 'Image'],
  ['image-diagram', 'Diagram', 'image'],
  ['image-drawing', 'Drawing', 'image'],
  ['image-figure', 'Figure', 'image'],
  ['image-other', 'Other', 'image'],
  ['image-photo', 'Photo', 'image'],
  ['image-plot', 'Plot', 'image'],
  ['lesson', 'Lesson'],
  ['model', 'Model'],
  ['other', 'Other'],
  ['physicalobject', 'Physical object'],
  ['poster', 'Poster'],
  ['presentation', 'Presentation'],
  ['publication', 'Publication'],
  ['publication-annotationcollection', 'Annotation collection', 'publication'],
  ['publication-article', 'Journal article', 'publication'],
  ['publication-book', 'Book', 'publication'],
  ['publication-conferencepaper', 'Conference paper', 'publication'],
  ['publication-conferenceproceeding', 'Conference proceeding', 'publication'],
  ['publication-datamanagementplan', 'Output management plan', 'publication'],
  ['publication-datapaper', 'Data paper', 'publication'],
  ['publication-deliverable', 'Project deliverable', 'publication'],
  ['publication-dissertation', 'Thesis', 'publication'],
  ['publication-journal', 'Journal', 'publication'],
  ['publication-milestone', 'Project milestone', 'publication'],
  ['publication-other', 'Other', 'publication'],
  ['publication-patent', 'Patent', 'publication'],
  ['publication-peerreview', 'Peer review', 'publication'],
  ['publication-preprint', 'Preprint', 'publication'],
  ['publication-proposal', 'Proposal', 'publication'],
  ['publication-report', 'Report', 'publication'],
  ['publication-section', 'Book chapter', 'publication'],
  ['publication-softwaredocumentation', 'Software documentation', 'publication'],
  ['publication-standard', 'Standard', 'publication'],
  ['publication-taxonomictreatment', 'Taxonomic treatment', 'publication'],
  ['publication-technicalnote', 'Technical note', 'publication'],
  ['publication-workingpaper', 'Working paper', 'publication'],
  ['software', 'Software'],
  ['software-computationalnotebook', 'Computational notebook', 'software'],
  ['video', 'Video/Audio'],
  ['workflow', 'Workflow'],
];

/** All 43 resource types, in id order. */
export const RESOURCE_TYPES: readonly ResourceType[] = ENTRIES.map(([id, label, parentType]) =>
  parentType
    ? { id, label, parentType, searchValue: `${parentType}::${id}` }
    : { id, label, searchValue: id },
);

/** The 43 ids as a non-empty tuple, for `z.enum`. */
export const RESOURCE_TYPE_IDS = RESOURCE_TYPES.map((t) => t.id) as [string, ...string[]];

const BY_ID = new Map(RESOURCE_TYPES.map((t) => [t.id, t]));

/** Looks a resource type up by id. */
export function getResourceType(id: string): ResourceType | undefined {
  return BY_ID.get(id);
}

/**
 * Resolves a resource type as a caller may write it to its id: any case, and the
 * `<type>::<id>` form Zenodo spells a subtype with (`publication::publication-article`
 * → `publication-article`) when the prefix is that subtype's parent. Returns
 * `undefined` when the value names no resource type.
 */
export function resolveResourceTypeId(raw: string): string | undefined {
  const value = raw.trim().toLowerCase();
  const sep = value.indexOf('::');
  if (sep === -1) return BY_ID.has(value) ? value : undefined;
  const type = BY_ID.get(value.slice(sep + 2));
  return type?.parentType === value.slice(0, sep) ? type.id : undefined;
}

const normalize = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ');

/**
 * Filters the table by strict token match over id and label: every query token
 * must appear. An empty query returns the whole table.
 */
export function filterResourceTypes(query: string | undefined): ResourceType[] {
  const tokens = query ? normalize(query).split(/\s+/).filter(Boolean) : [];
  if (tokens.length === 0) return [...RESOURCE_TYPES];
  return RESOURCE_TYPES.filter((t) => {
    const hay = normalize(`${t.id} ${t.label}`);
    return tokens.every((tok) => hay.includes(tok));
  });
}
