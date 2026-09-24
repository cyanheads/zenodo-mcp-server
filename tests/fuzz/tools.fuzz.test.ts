/**
 * @fileoverview Property-based fuzz coverage for the six Zenodo tools: generated and
 * adversarial inputs (ids, queries, file keys, member paths) must never crash a
 * handler with a non-McpError, leak a stack or local path, or pollute prototypes.
 * The service is replaced at its accessor with an in-memory fake that resolves every
 * id to one record, so fuzzed inputs reach the key, member, and paging logic.
 * @module tests/fuzz/tools.fuzz.test
 */

import { fuzzTool } from '@cyanheads/mcp-ts-core/testing/fuzz';
import { describe, expect, it, vi } from 'vitest';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import {
  normalizeContainer,
  normalizeFacets,
  normalizeRecord,
  normalizeSearchHit,
  normalizeVersionHit,
} from '@/services/zenodo/normalize.js';
import type { RawContainer, RawSearchResponse } from '@/services/zenodo/types.js';
import type { ZenodoService } from '@/services/zenodo/zenodo-service.js';
import { containerBody, fixture, recordFixture, withEntries } from '../helpers/zenodo-fixtures.js';

const record = normalizeRecord(
  withEntries(recordFixture(), [
    { key: 'scikit-learn/scikit-learn-1.9.1.zip', size: 8_684_206, mimetype: 'application/zip' },
    { key: 'README.md', size: 70, mimetype: 'text/markdown' },
    { key: 'data/table.csv', size: 24, mimetype: 'text/csv' },
    { key: 'empty.txt', size: 0, mimetype: 'text/plain' },
  ]),
);
const search = fixture<RawSearchResponse>('search-climate.json');
const text = new TextEncoder().encode('id,value\n1,alpha\n');

/** Answers every call with a hit, so fuzzed inputs get past record resolution. */
const fakeService = {
  getRecord: async () => ({ status: 'found', record }),
  resolveDoi: async () => ({ status: 'found', record }),
  latestRecid: async () => record.recid,
  listVersions: async () => ({
    status: 'ok',
    total: 1,
    hits: [normalizeVersionHit(recordFixture())],
  }),
  getCitation: async () => 'Grisel, O. et al. (2026). scikit-learn 1.9.1. Zenodo.',
  searchRecords: async () => ({
    total: search.hits?.total ?? 0,
    hits: (search.hits?.hits ?? []).map(normalizeSearchHit),
    facets: normalizeFacets(search.aggregations),
  }),
  getContainer: async () => ({
    status: 'ok',
    listing: normalizeContainer(containerBody(3, 1) as RawContainer),
  }),
  readContent: async () => ({ status: 'ok', bytes: text, moreRemains: false }),
  readMember: async () => ({ status: 'ok', bytes: text, moreRemains: true }),
  getCommunity: async () => undefined,
  resolveFunder: async () => undefined,
  searchVocabulary: async (vocabulary: string) => ({ vocabulary, total: 0, entries: [] }),
} as unknown as ZenodoService;

vi.mock('@/services/zenodo/zenodo-service.js', () => ({ getZenodoService: () => fakeService }));

describe('Zenodo tools under fuzzed input', () => {
  it.each(allToolDefinitions.map((d) => [d.name, d] as const))(
    '%s stays safe across generated and adversarial inputs',
    async (_name, definition) => {
      const report = await fuzzTool(definition, {
        numRuns: 40,
        numAdversarial: 30,
        seed: 20_260_924,
      });
      expect(report.totalRuns).toBeGreaterThanOrEqual(70);
      expect(report.crashes).toEqual([]);
      expect(report.leaks).toEqual([]);
      expect(report.prototypePollution).toBe(false);
    },
  );
});
