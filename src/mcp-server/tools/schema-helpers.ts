/**
 * @fileoverview Input preprocessors shared by the Zenodo tools. Form clients submit
 * every optional field, blank ones as `''`; these make a blank value read as unset
 * so no optional field needs `.min(1)`.
 * @module mcp-server/tools/schema-helpers
 */

/** Trims a string; `''` or whitespace-only → `undefined`, so a blank form field reads as "not set". */
export const blankToUndefined = (v: unknown): unknown => {
  if (typeof v !== 'string') return v;
  const trimmed = v.trim();
  return trimmed === '' ? undefined : trimmed;
};

/** A lone string becomes a one-element array; blank elements are dropped, and an array left empty reads as unset. */
export const toOptionalArray = (v: unknown): unknown => {
  const b = blankToUndefined(v);
  const arr = typeof b === 'string' ? [b] : b;
  if (!Array.isArray(arr)) return arr;
  const kept = arr.map(blankToUndefined).filter((x) => x !== undefined);
  return kept.length ? kept : undefined;
};
