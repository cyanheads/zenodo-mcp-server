/**
 * @fileoverview Tests for the static resource-type table: its shape, the
 * `<type>::<id>` search value for subtypes, lookup by id, resolving an id as a
 * caller writes it, and the strict token filter behind the resource_types vocabulary.
 * @module tests/services/zenodo/resource-types.test
 */

import { describe, expect, it } from 'vitest';
import {
  filterResourceTypes,
  getResourceType,
  RESOURCE_TYPE_IDS,
  RESOURCE_TYPES,
  resolveResourceTypeId,
} from '@/services/zenodo/resource-types.js';

describe('resolveResourceTypeId', () => {
  it.each([
    ['dataset', 'dataset'],
    [' Dataset ', 'dataset'],
    ['PUBLICATION-ARTICLE', 'publication-article'],
    ['publication::publication-article', 'publication-article'],
    ['Image::Image-Photo', 'image-photo'],
  ])('%j → %s', (raw, id) => {
    expect(resolveResourceTypeId(raw)).toBe(id);
  });

  it('resolves every search value the lookup prints back to its id', () => {
    for (const t of RESOURCE_TYPES) expect(resolveResourceTypeId(t.searchValue)).toBe(t.id);
  });

  it.each(['datasets', 'image::publication-article', 'dataset::dataset', '::dataset', ''])(
    '%j names no resource type',
    (raw) => {
      expect(resolveResourceTypeId(raw)).toBeUndefined();
    },
  );
});

describe('RESOURCE_TYPES', () => {
  it('holds the 43 unique ids of /api/vocabularies/resourcetypes', () => {
    expect(RESOURCE_TYPES).toHaveLength(43);
    expect(new Set(RESOURCE_TYPE_IDS).size).toBe(43);
    expect(RESOURCE_TYPE_IDS).toEqual(RESOURCE_TYPES.map((t) => t.id));
  });

  it('sends top-level types as-is and subtypes as <parent>::<id>', () => {
    for (const t of RESOURCE_TYPES) {
      if (t.parentType) {
        expect(t.searchValue).toBe(`${t.parentType}::${t.id}`);
        expect(t.id.startsWith(`${t.parentType}-`)).toBe(true);
        expect(getResourceType(t.parentType)?.parentType).toBeUndefined();
      } else {
        expect(t.searchValue).toBe(t.id);
      }
    }
  });

  it('resolves verified examples', () => {
    expect(getResourceType('dataset')).toEqual({
      id: 'dataset',
      label: 'Dataset',
      searchValue: 'dataset',
    });
    expect(getResourceType('image-photo')?.searchValue).toBe('image::image-photo');
    expect(getResourceType('publication-article')).toEqual({
      id: 'publication-article',
      label: 'Journal article',
      parentType: 'publication',
      searchValue: 'publication::publication-article',
    });
    expect(getResourceType('Dataset')).toBeUndefined();
    expect(getResourceType('article')).toBeUndefined();
  });
});

describe('filterResourceTypes', () => {
  const ids = (q: string | undefined) => filterResourceTypes(q).map((t) => t.id);

  it('returns the whole table for an empty or whitespace query', () => {
    expect(ids(undefined)).toHaveLength(43);
    expect(ids('')).toHaveLength(43);
    expect(ids('   ')).toHaveLength(43);
  });

  it('requires every token to match (AND), case-insensitively', () => {
    expect(ids('journal article')).toEqual(['publication-article']);
    expect(ids('JOURNAL')).toEqual(['publication-article', 'publication-journal']);
    expect(ids('software notebook')).toEqual(['software-computationalnotebook']);
  });

  it('matches against ids and labels, ignoring punctuation and diacritics', () => {
    expect(ids('photo')).toEqual(['image-photo']);
    expect(ids('image-plot')).toEqual(['image-plot']);
    expect(ids('Vídeo')).toEqual(['video']);
    expect(ids('video/audio')).toEqual(['video']);
  });

  it('returns nothing for an unmatched token', () => {
    expect(ids('spreadsheet')).toEqual([]);
    expect(ids('journal spreadsheet')).toEqual([]);
  });

  it('returns copies, not the shared table', () => {
    const all = filterResourceTypes(undefined);
    all.pop();
    expect(RESOURCE_TYPES).toHaveLength(43);
  });
});
