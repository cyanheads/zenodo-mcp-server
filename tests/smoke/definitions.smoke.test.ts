/**
 * @fileoverview Smoke coverage for every shipped tool definition: each handler
 * runs once on a path that needs no network, and each format() renders.
 * @module tests/smoke/definitions.smoke.test
 */

import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { getRecord } from '@/mcp-server/tools/definitions/get-record.tool.js';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import { listFiles } from '@/mcp-server/tools/definitions/list-files.tool.js';
import { listVersions } from '@/mcp-server/tools/definitions/list-versions.tool.js';
import { lookupVocabulary } from '@/mcp-server/tools/definitions/lookup-vocabulary.tool.js';
import { readFile } from '@/mcp-server/tools/definitions/read-file.tool.js';
import { searchRecords } from '@/mcp-server/tools/definitions/search-records.tool.js';

describe('tool definition smoke test', () => {
  it('registers every tool', () => {
    expect(allToolDefinitions.map((d) => d.name)).toEqual([
      'zenodo_search_records',
      'zenodo_get_record',
      'zenodo_list_versions',
      'zenodo_list_files',
      'zenodo_read_file',
      'zenodo_lookup_vocabulary',
    ]);
  });

  it('runs zenodo_lookup_vocabulary on the static resource-type table', async () => {
    const ctx = createMockContext({ errors: lookupVocabulary.errors });
    const result = await lookupVocabulary.handler(
      lookupVocabulary.input.parse({ vocabulary: 'resource_types', query: 'journal article' }),
      ctx,
    );

    expect(result).toEqual(expect.schemaMatching(lookupVocabulary.output));
    expect(result.entries[0]).toMatchObject({
      filter_param: 'resource_type',
      filter_value: 'publication-article',
      search_value: 'publication::publication-article',
    });
    expect(getEnrichment(ctx)).toMatchObject({ truncated: false, totalCount: 1 });
    expect(lookupVocabulary.format?.(result)[0]).toMatchObject({ type: 'text' });
  });

  it('rejects an unparseable zenodo_get_record id before any upstream call', async () => {
    const ctx = createMockContext({ errors: getRecord.errors });
    const call = getRecord.handler(
      getRecord.input.parse({ id: 'https://sandbox.zenodo.org/records/1' }),
      ctx,
    );

    await expect(call).rejects.toBeInstanceOf(McpError);
    await expect(call).rejects.toMatchObject({ data: { reason: 'invalid_identifier' } });
  });

  it('rejects a zenodo_search_records page past the 10,000-result window locally', async () => {
    const ctx = createMockContext({ errors: searchRecords.errors });
    const call = searchRecords.handler(
      searchRecords.input.parse({ query: 'climate', page: 401, size: 25 }),
      ctx,
    );

    await expect(call).rejects.toMatchObject({ data: { reason: 'result_window_exceeded' } });
    expect(getEnrichment(ctx)).toMatchObject({ appliedSort: 'bestmatch', allVersions: false });
  });

  it('rejects an unparseable id on the drill-down tools before any upstream call', async () => {
    const id = 'https://zenodo.org/badge/latestdoi/12345';
    await expect(
      listVersions.handler(
        listVersions.input.parse({ id }),
        createMockContext({ errors: listVersions.errors }),
      ),
    ).rejects.toMatchObject({ data: { reason: 'invalid_identifier' } });
    await expect(
      listFiles.handler(
        listFiles.input.parse({ id }),
        createMockContext({ errors: listFiles.errors }),
      ),
    ).rejects.toMatchObject({ data: { reason: 'invalid_identifier' } });
    await expect(
      readFile.handler(
        readFile.input.parse({ id, key: 'README.md' }),
        createMockContext({ errors: readFile.errors }),
      ),
    ).rejects.toMatchObject({ data: { reason: 'invalid_identifier' } });
  });
});
