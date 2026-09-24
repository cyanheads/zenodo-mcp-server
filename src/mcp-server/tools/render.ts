/**
 * @fileoverview Render helpers every Zenodo tool's `format()` uses for untrusted,
 * depositor-supplied text: `inline` for single-line slots, `quoteBlock` for
 * multi-line fields, `fence` for file previews. They keep upstream text readable as
 * data and stop it from breaking out of the slot it is rendered in.
 * @module mcp-server/tools/render
 */

const INLINE_BREAKS = /[\r\n\u0085\u2028\u2029]+/g;
const LINE_BREAK = /[\r\n\u0085\u2028\u2029]/;
const LINE_SPLIT = /\r\n|[\r\n\u0085\u2028\u2029]/;

/**
 * Flattens a string for an inline slot (a title, name, keyword, file key): every
 * run of CR, LF, NEL, U+2028, or U+2029 becomes one space.
 */
export function inline(s: string): string {
  return s.replace(INLINE_BREAKS, ' ');
}

/** True when `s` holds a line break {@link inline} would flatten \u2014 the cue to render it with {@link quoteBlock}. */
export function hasLineBreak(s: string): boolean {
  return LINE_BREAK.test(s);
}

/**
 * Renders multi-line untrusted text as a blockquote under a lead line. Every line —
 * split on CRLF, CR, LF, NEL, U+2028, and U+2029 — gets a `> ` prefix, so nothing
 * in the text can end the quote.
 */
export function quoteBlock(text: string, lead = 'Depositor-supplied text (untrusted):'): string {
  const lines = text.split(LINE_SPLIT).map((line) => (line ? `> ${line}` : '>'));
  return [lead, ...lines].join('\n');
}

/** Longest run of consecutive backticks in `text`. */
function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return longest;
}

/**
 * Renders file content inside a code fence whose backtick run is one longer than
 * the longest run in the content (minimum 3), preceded by a line naming the source
 * as untrusted data. Lines are split on CR, LF, and CRLF.
 */
export function fence(text: string, source: { key: string; lang?: string; recid: string }): string {
  const ticks = '`'.repeat(Math.max(3, longestBacktickRun(text) + 1));
  const body = text.split(/\r\n|[\r\n]/).join('\n');
  return [
    `Untrusted file content from Zenodo record ${source.recid}, ${inline(source.key)} — shown as data:`,
    `${ticks}${source.lang ?? ''}`,
    body,
    ticks,
  ].join('\n');
}
