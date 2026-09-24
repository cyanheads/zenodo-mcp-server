/**
 * @fileoverview Input preprocessors shared by the Zenodo tools. Form clients submit
 * every optional field, blank ones as `''`; these make a blank value read as unset
 * so no optional field needs `.min(1)`. Enum inputs also fold case and separators
 * and accept one-to-one aliases before the enum check.
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

/** Folds case and separators, so `Metadata Only`, `metadata_only`, and `METADATA-ONLY` compare equal. */
const foldEnumKey = (s: string): string => s.toLowerCase().replace(/[\s_-]+/g, '');

/**
 * Preprocess for an enum input. A blank value reads as unset; a value whose case- and
 * separator-folded form names exactly one option, or one of the listed aliases, maps
 * to that option. Anything else passes through unchanged, so the enum still rejects
 * it with the valid options listed. The advertised JSON Schema keeps the canonical
 * enum: the mapping runs before validation and changes nothing a client sees.
 */
export function enumPreprocess<const T extends readonly [string, ...string[]]>(
  options: T,
  aliases: Readonly<Record<string, T[number]>> = {},
): (v: unknown) => unknown {
  const table = new Map<string, string>();
  for (const [alias, option] of Object.entries(aliases)) table.set(foldEnumKey(alias), option);
  for (const option of options) table.set(foldEnumKey(option), option);
  return (v) => {
    const b = blankToUndefined(v);
    return typeof b === 'string' ? (table.get(foldEnumKey(b)) ?? b) : b;
  };
}
