/**
 * @fileoverview The `found: false` outcome zenodo_get_record and zenodo_list_versions
 * share: the removal-tombstone schema and the `miss_kind` + guidance for each way an
 * id can fail to resolve, so both tools describe a miss identically.
 * @module mcp-server/tools/record-miss
 */

import { z } from '@cyanheads/mcp-ts-core';
import type { RecordLookup } from '@/services/zenodo/types.js';

/** Output schema of a deleted record's removal tombstone. */
export const TombstoneSchema = z
  .object({
    removal_date: z.string().optional().describe('When the record was removed (ISO 8601).'),
    removal_reason: z.string().optional().describe('Removal reason id, e.g. spam or retracted.'),
    note: z.string().optional().describe('Removal note, when non-empty.'),
    citation_text: z
      .string()
      .optional()
      .describe(
        'The citation the tombstone still serves — the only bibliographic data a deleted record keeps.',
      ),
  })
  .describe('Removal tombstone of a deleted record.');

/** `miss_kind`, guidance, and (for a deleted record) the tombstone of a record GET that found nothing. */
export function recordMiss(recid: string, lookup: Exclude<RecordLookup, { status: 'found' }>) {
  switch (lookup.status) {
    case 'not_found':
      return {
        miss_kind: 'not_found' as const,
        guidance: `No Zenodo record has id ${recid}; it may never have existed. Search by title with zenodo_search_records, or by query doi:"10.5281/zenodo.${recid}" with all_versions true.`,
      };
    case 'deleted': {
      const { tombstone } = lookup;
      const date = tombstone.removal_date?.slice(0, 10) ?? 'an unrecorded date';
      return {
        miss_kind: 'deleted' as const,
        guidance: `Record ${recid} was removed from Zenodo on ${date} (reason: ${tombstone.removal_reason ?? 'not given'}); only its tombstone citation remains. Find a replacement or another version by title with zenodo_search_records.`,
        tombstone,
      };
    }
    case 'restricted':
      return {
        miss_kind: 'restricted' as const,
        guidance: `Record ${recid} exists but its metadata is restricted to authorized users and cannot be read anonymously.`,
      };
  }
}

/** `miss_kind` and guidance for a non-Zenodo DOI that no Zenodo record carries. */
export function notOnZenodoMiss(doi: string) {
  return {
    miss_kind: 'not_on_zenodo' as const,
    guidance: `DOI ${doi} is not registered to a Zenodo record. It resolves elsewhere at https://doi.org/${doi}; to find a related deposit, search by title with zenodo_search_records.`,
  };
}
