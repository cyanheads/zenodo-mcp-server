/**
 * @fileoverview Deterministic HTML → plain-text conversion for depositor-supplied
 * record descriptions. The one documented transformation of upstream text: drop
 * script/style, turn block ends and line breaks into newlines, put each table row on
 * one line (a one-cell row keeps its line breaks), inline link targets, strip tags,
 * decode entities, normalize whitespace.
 * @module services/zenodo/html-to-text
 */

/**
 * `name:code` pairs of the HTML 4.01 character entity sets, transcribed in DTD order
 * from https://www.w3.org/TR/html401/HTMLlat1.ent (96 names, U+00A0–U+00FF),
 * HTMLsymbol.ent (124: Greek, math, arrows), and HTMLspecial.ent (32: markup-significant
 * characters, Latin Extended-A, spacing and punctuation).
 */
const HTML4_ENTITY_SETS = [
  'nbsp:160 iexcl:161 cent:162 pound:163 curren:164 yen:165 brvbar:166 sect:167 uml:168 copy:169 ordf:170 laquo:171 not:172 shy:173 reg:174 macr:175 deg:176 plusmn:177 sup2:178 sup3:179 acute:180 micro:181 para:182 middot:183 cedil:184 sup1:185 ordm:186 raquo:187 frac14:188 frac12:189 frac34:190 iquest:191 Agrave:192 Aacute:193 Acirc:194 Atilde:195 Auml:196 Aring:197 AElig:198 Ccedil:199 Egrave:200 Eacute:201 Ecirc:202 Euml:203 Igrave:204 Iacute:205 Icirc:206 Iuml:207 ETH:208 Ntilde:209 Ograve:210 Oacute:211 Ocirc:212 Otilde:213 Ouml:214 times:215 Oslash:216 Ugrave:217 Uacute:218 Ucirc:219 Uuml:220 Yacute:221 THORN:222 szlig:223 agrave:224 aacute:225 acirc:226 atilde:227 auml:228 aring:229 aelig:230 ccedil:231 egrave:232 eacute:233 ecirc:234 euml:235 igrave:236 iacute:237 icirc:238 iuml:239 eth:240 ntilde:241 ograve:242 oacute:243 ocirc:244 otilde:245 ouml:246 divide:247 oslash:248 ugrave:249 uacute:250 ucirc:251 uuml:252 yacute:253 thorn:254 yuml:255',
  'fnof:402 Alpha:913 Beta:914 Gamma:915 Delta:916 Epsilon:917 Zeta:918 Eta:919 Theta:920 Iota:921 Kappa:922 Lambda:923 Mu:924 Nu:925 Xi:926 Omicron:927 Pi:928 Rho:929 Sigma:931 Tau:932 Upsilon:933 Phi:934 Chi:935 Psi:936 Omega:937 alpha:945 beta:946 gamma:947 delta:948 epsilon:949 zeta:950 eta:951 theta:952 iota:953 kappa:954 lambda:955 mu:956 nu:957 xi:958 omicron:959 pi:960 rho:961 sigmaf:962 sigma:963 tau:964 upsilon:965 phi:966 chi:967 psi:968 omega:969 thetasym:977 upsih:978 piv:982 bull:8226 hellip:8230 prime:8242 Prime:8243 oline:8254 frasl:8260 weierp:8472 image:8465 real:8476 trade:8482 alefsym:8501 larr:8592 uarr:8593 rarr:8594 darr:8595 harr:8596 crarr:8629 lArr:8656 uArr:8657 rArr:8658 dArr:8659 hArr:8660 forall:8704 part:8706 exist:8707 empty:8709 nabla:8711 isin:8712 notin:8713 ni:8715 prod:8719 sum:8721 minus:8722 lowast:8727 radic:8730 prop:8733 infin:8734 ang:8736 and:8743 or:8744 cap:8745 cup:8746 int:8747 there4:8756 sim:8764 cong:8773 asymp:8776 ne:8800 equiv:8801 le:8804 ge:8805 sub:8834 sup:8835 nsub:8836 sube:8838 supe:8839 oplus:8853 otimes:8855 perp:8869 sdot:8901 lceil:8968 rceil:8969 lfloor:8970 rfloor:8971 lang:9001 rang:9002 loz:9674 spades:9824 clubs:9827 hearts:9829 diams:9830',
  'quot:34 amp:38 lt:60 gt:62 OElig:338 oelig:339 Scaron:352 scaron:353 Yuml:376 circ:710 tilde:732 ensp:8194 emsp:8195 thinsp:8201 zwnj:8204 zwj:8205 lrm:8206 rlm:8207 ndash:8211 mdash:8212 lsquo:8216 rsquo:8217 sbquo:8218 ldquo:8220 rdquo:8221 bdquo:8222 dagger:8224 Dagger:8225 permil:8240 lsaquo:8249 rsaquo:8250 euro:8364',
];

/**
 * Every named entity the converter decodes, keyed by exact name: the 252 HTML 4.01
 * entities plus `apos`. `nbsp` decodes to a plain space (the later entry wins).
 */
export const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ...HTML4_ENTITY_SETS.flatMap((set) => set.split(' ')).map((pair) => {
    const [name = '', code] = pair.split(':');
    return [name, String.fromCodePoint(Number(code))] as const;
  }),
  ['apos', "'"],
  ['nbsp', ' '],
]);

/** The common names, also matched in any letter case (`&AMP;`, `&Nbsp;`). */
const ANY_CASE = new Set(
  'amp lt gt quot apos nbsp ndash mdash hellip lsquo rsquo ldquo rdquo copy reg deg'.split(' '),
);

function codePointToString(codePoint: number): string {
  return Number.isInteger(codePoint) &&
    codePoint > 0 &&
    codePoint <= 0x10ffff &&
    (codePoint < 0xd800 || codePoint > 0xdfff)
    ? String.fromCodePoint(codePoint)
    : String.fromCodePoint(0xfffd);
}

/**
 * Decodes numeric (decimal and hex) references and `NAMED_ENTITIES` in one
 * left-to-right pass, so decoded text is never read again. Names match by exact case,
 * except the `ANY_CASE` names; every other name stays as written.
 */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, body: string) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      return codePointToString(Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10));
    }
    const lower = body.toLowerCase();
    return NAMED_ENTITIES.get(ANY_CASE.has(lower) ? lower : body) ?? match;
  });
}

/** Re-escapes the characters entity decoding would otherwise read twice. */
function escapeForDecode(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * Every pattern and scan below stays linear on hostile input: descriptions are
 * depositor-supplied and converted for every search hit, so a pattern that rescans
 * to the end of the text from each `<` (or each space) would let one deposit stall
 * the server. Tag patterns stop at the next `<` or `>` instead of scanning past it.
 */

/** Drops every `<…>` tag: each `<` through the next `>`, as `/<[^>]*>/g` would, in one pass. */
function stripTags(html: string): string {
  let out = '';
  let from = 0;
  for (;;) {
    const open = html.indexOf('<', from);
    const close = open === -1 ? -1 : html.indexOf('>', open);
    if (close === -1) return out + html.slice(from);
    out += html.slice(from, open);
    from = close + 1;
  }
}

const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

/**
 * `<a href="X">T</a>` → `T (X)` when X is http(s) and differs from T, else `T`.
 * Each closing tag is searched for once, from its opening tag; with none left, the
 * remaining links stay as they are.
 */
function inlineLinks(html: string): string {
  const openTag = /<a\b([^<>]*)>/gi;
  const closeTag = /<\/a\s*>/gi;
  let out = '';
  let from = 0;
  for (let open = openTag.exec(html); open; open = openTag.exec(html)) {
    const attr = HREF.exec(open[1] ?? '');
    if (!attr) continue;
    closeTag.lastIndex = openTag.lastIndex;
    const close = closeTag.exec(html);
    if (!close) break;
    const inner = html.slice(openTag.lastIndex, close.index);
    const href = decodeEntities(attr[1] ?? attr[2] ?? attr[3] ?? '').trim();
    const text = decodeEntities(stripTags(inner)).trim();
    out +=
      html.slice(from, open.index) +
      (/^https?:\/\//i.test(href) && href !== text ? `${inner} (${escapeForDecode(href)})` : inner);
    from = close.index + close[0].length;
    openTag.lastIndex = from;
  }
  return out + html.slice(from);
}

/** `<br>` with the line break directly after it, and the spaces and tabs around that break. */
const BR = /<br\s*\/?>(?:[ \t]*(?:\r\n?|\n)[ \t]*)?/gi;

/** Line breaks, block ends, list items, links, tag stripping, and entity decoding. */
function flowToText(html: string): string {
  const s = html
    .replace(BR, '\n')
    .replace(/<\/(?:p|div|h[1-6]|li|tr|blockquote|pre|ul|ol|table)\s*>/gi, '\n')
    .replace(/<li\b[^<>]*>/gi, '- ');
  return decodeEntities(stripTags(inlineLinks(s)));
}

/** `text` with each whitespace run collapsed to one space, trimmed. */
function collapseSpace(text: string): string {
  return text.replace(/[\s\u0085]+/g, ' ').trim();
}

/** A table cell, or text inside a table but outside its cells, as one line. */
function cellToText(html: string): string {
  return collapseSpace(flowToText(html));
}

/**
 * The cell of a one-cell row as blocks: its line breaks kept, whitespace inside each
 * line collapsed as in a cell (so a pretty-printed layout table leaves no indentation),
 * and blank lines at either end dropped.
 */
function blockToText(html: string): string {
  const lines = flowToText(html)
    .split(/\r\n?|\n/)
    .map(collapseSpace);
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start] === '') start++;
  while (end > start && lines[end - 1] === '') end--;
  return lines.slice(start, end).join('\n');
}

/** A row from its cells' HTML: one cell as blocks, several as one line joined by ` | `; `''` when no cell has text. */
function rowToText(cells: string[]): string {
  if (cells.length === 1) return blockToText(cells[0] ?? '');
  const texts = cells.map(cellToText);
  return texts.some((text) => text !== '') ? texts.join(' | ') : '';
}

/** A `table`, `tr`, `td`, or `th` tag, opening or closing, that closes before the next `<`. */
const TABLE_TAG = /<(\/?)(table|tr|t[dh])(?=[\s/>])[^<>]*>/gi;

/** True when `text` is empty or ends with a line break, ignoring trailing spaces and tabs. */
function atLineStart(text: string): boolean {
  let end = text.length;
  while (end > 0 && (text[end - 1] === ' ' || text[end - 1] === '\t')) end--;
  return end === 0 || text[end - 1] === '\n' || text[end - 1] === '\r';
}

/**
 * Converts `html` in one forward scan over its table tags. Text outside tables goes
 * through `flowToText`. Each table becomes one line per row, cells joined by ` | `,
 * on its own line and followed by a blank line; a row with exactly one cell keeps that
 * cell's line breaks instead (a layout table). A cell or row without its closing tag
 * ends where the next cell, row, or the table does. A table nested in a cell becomes
 * part of that cell's text, its row and table ends kept as line breaks and its other
 * tags as spaces, and text inside a table but outside its cells gets a line of its own.
 */
function convertBlocks(html: string): string {
  let out = '';
  let from = 0; // start of the input not yet converted
  let depth = 0; // table nesting at the scan position
  let lines: string[] = [];
  let row: string[] | undefined; // HTML of each closed cell of the open row
  let cell: string | undefined; // HTML of the open cell

  const take = (end: number) => {
    const chunk = html.slice(from, end);
    if (cell !== undefined) {
      cell += chunk;
      return;
    }
    const text = cellToText(chunk);
    if (text) lines.push(text);
  };
  const closeCell = () => {
    if (cell === undefined) return;
    row ??= [];
    row.push(cell);
    cell = undefined;
  };
  const closeRow = () => {
    closeCell();
    const text = row ? rowToText(row) : '';
    if (text) lines.push(text);
    row = undefined;
  };
  const closeTable = () => {
    closeRow();
    if (lines.length > 0) out += `${atLineStart(out) ? '' : '\n'}${lines.join('\n')}\n`;
    out += '\n';
    lines = [];
  };

  for (const tag of html.matchAll(TABLE_TAG)) {
    const closing = tag[1] === '/';
    const name = tag[2]?.toLowerCase();
    if (depth === 0) {
      if (name !== 'table' || closing) continue;
      out += flowToText(html.slice(from, tag.index));
    } else {
      take(tag.index);
    }
    from = tag.index + tag[0].length;

    const nested = depth > 1 || (depth === 1 && name === 'table' && !closing);
    if (name === 'table') depth += closing ? -1 : 1;
    if (depth === 0) closeTable();
    else if (nested) {
      if (cell !== undefined) cell += closing && (name === 'tr' || name === 'table') ? '\n' : ' ';
    } else if (name === 'tr') closeRow();
    else if (name !== 'table') {
      closeCell();
      if (!closing) cell = '';
    }
  }

  if (depth === 0) return out + flowToText(html.slice(from));
  take(html.length);
  closeTable();
  return out;
}

/** `line` without trailing spaces and tabs. */
function trimTrailingBlanks(line: string): string {
  let end = line.length;
  while (end > 0 && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--;
  return line.slice(0, end);
}

/**
 * Converts an HTML fragment to plain text:
 * 1. drops `<script>`/`<style>` elements with their content (and comments);
 * 2. `<br>` → newline, together with a line break directly after it; closing block
 *    tags → newline; `<li>` → `- `;
 * 3. each table row → one line, cells joined by ` | `, whitespace and block breaks
 *    inside a cell collapsed to single spaces; a row with one cell keeps the cell's
 *    line breaks, each line collapsed and trimmed the same way;
 * 4. `<a href="X">T</a>` → `T (X)` when X is http(s) and differs from T;
 * 5. strips remaining tags; 6. decodes entities (numeric and the HTML 4 named set);
 * 7. normalizes CRLF/CR to LF, trims trailing spaces per line, collapses 3+
 *    newlines to 2, and trims the result.
 */
export function htmlToText(html: string): string {
  const s = html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/<(script|style)\b[^<>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '');

  return convertBlocks(s)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(trimTrailingBlanks)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
