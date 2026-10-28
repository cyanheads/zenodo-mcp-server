/**
 * @fileoverview Keeps runtime skill modules in desktop bundles while removing dependency agent docs.
 * @module tests/scripts/bundle-content
 */
import { describe, expect, it } from 'vitest';
import { filterAgentDocEntries } from '../../scripts/clean-mcpb.js';

const {
  checkBundleEntries,
}: { checkBundleEntries: (entries: string[], label: string) => string[] } = await import(
  new URL('../../scripts/lint-packaging.ts', import.meta.url).href
);

describe('desktop bundle agent documentation', () => {
  it.each([
    'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
    'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
    'node_modules/parent/node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
    'node_modules/@scope/parent/node_modules/child/dist/skills/index.js',
    'node_modules/child/dist/framework-skills/index.js',
    'skills/zenodo-guide/SKILL.md',
  ])('preserves runtime or published content: %s', (entry) => {
    expect(filterAgentDocEntries([entry])).toEqual([]);
    expect(checkBundleEntries([entry], 'test.mcpb')).toEqual([]);
  });

  it.each([
    'node_modules/child/skills/guide/SKILL.md',
    'node_modules/@scope/child/skills/guide/reference.md',
    'node_modules/parent/node_modules/child/framework-skills/guide/SKILL.md',
    'node_modules/@scope/parent/node_modules/@scope/child/.claude/settings.json',
    'node_modules/child/.agents/skills/guide.md',
    'node_modules/child/SKILL.md',
    'node_modules/child/docs/SKILL.md',
  ])('removes dependency agent documentation: %s', (entry) => {
    expect(filterAgentDocEntries([entry])).toEqual([entry]);
    expect(checkBundleEntries([entry], 'test.mcpb')).toHaveLength(1);
    expect(checkBundleEntries([entry], 'test.mcpb')[0]).toContain(entry);
  });
});
