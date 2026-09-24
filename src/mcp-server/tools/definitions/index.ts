/**
 * @fileoverview Barrel of every tool definition this server registers.
 * @module mcp-server/tools/definitions
 */

import { getRecord } from './get-record.tool.js';
import { listFiles } from './list-files.tool.js';
import { listVersions } from './list-versions.tool.js';
import { lookupVocabulary } from './lookup-vocabulary.tool.js';
import { readFile } from './read-file.tool.js';
import { searchRecords } from './search-records.tool.js';

export { getRecord, listFiles, listVersions, lookupVocabulary, readFile, searchRecords };

/** All tool definitions, in registration order. */
export const allToolDefinitions = [
  searchRecords,
  getRecord,
  listVersions,
  listFiles,
  readFile,
  lookupVocabulary,
];
