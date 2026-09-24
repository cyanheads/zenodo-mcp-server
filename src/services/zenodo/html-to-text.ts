/**
 * @fileoverview Deterministic HTML → plain-text conversion for depositor-supplied
 * record descriptions. The one documented transformation of upstream text: drop
 * script/style, turn block ends and line breaks into newlines, inline link targets,
 * strip tags, decode entities, normalize whitespace.
 * @module services/zenodo/html-to-text
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  copy: '©',
  reg: '®',
  deg: '°',
};

/**
 * The HTML 4 Latin-1 entities (U+00A0–U+00FF), case-sensitive. Zenodo's
 * description editor stores accented letters as named entities (`n&uacute;meros`),
 * so non-English descriptions stay unreadable without them.
 */
const LATIN1_ENTITIES: Record<string, number> = Object.fromEntries(
  'AElig:198 Aacute:193 Acirc:194 Agrave:192 Aring:197 Atilde:195 Auml:196 Ccedil:199 ETH:208 Eacute:201 Ecirc:202 Egrave:200 Euml:203 Iacute:205 Icirc:206 Igrave:204 Iuml:207 Ntilde:209 Oacute:211 Ocirc:212 Ograve:210 Oslash:216 Otilde:213 Ouml:214 THORN:222 Uacute:218 Ucirc:219 Ugrave:217 Uuml:220 Yacute:221 aacute:225 acirc:226 acute:180 aelig:230 agrave:224 aring:229 atilde:227 auml:228 brvbar:166 ccedil:231 cedil:184 cent:162 curren:164 divide:247 eacute:233 ecirc:234 egrave:232 eth:240 euml:235 frac12:189 frac14:188 frac34:190 iacute:237 icirc:238 iexcl:161 igrave:236 iquest:191 iuml:239 laquo:171 macr:175 micro:181 middot:183 not:172 ntilde:241 oacute:243 ocirc:244 ograve:242 ordf:170 ordm:186 oslash:248 otilde:245 ouml:246 para:182 plusmn:177 pound:163 raquo:187 sect:167 shy:173 sup1:185 sup2:178 sup3:179 szlig:223 thorn:254 times:215 uacute:250 ucirc:251 ugrave:249 uml:168 uuml:252 yacute:253 yen:165 yuml:255'
    .split(' ')
    .map((pair) => {
      const [name, code] = pair.split(':');
      return [name, Number(code)];
    }),
);

function codePointToString(codePoint: number): string {
  return Number.isInteger(codePoint) &&
    codePoint > 0 &&
    codePoint <= 0x10ffff &&
    (codePoint < 0xd800 || codePoint > 0xdfff)
    ? String.fromCodePoint(codePoint)
    : '\uFFFD';
}

/**
 * Decodes numeric (decimal and hex) entities, the fixed named table (any case), and
 * the Latin-1 named entities (exact case). Unknown names stay as written.
 */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, body: string) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      return codePointToString(Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10));
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    if (named !== undefined) return named;
    const latin1 = LATIN1_ENTITIES[body];
    return latin1 === undefined ? match : String.fromCodePoint(latin1);
  });
}

/** Re-escapes the characters entity decoding would otherwise read twice. */
function escapeForDecode(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

const stripTags = (html: string) => html.replace(/<[^>]*>/g, '');

/**
 * Converts an HTML fragment to plain text:
 * 1. drops `<script>`/`<style>` elements with their content (and comments);
 * 2. `<br>` → newline, closing block tags → newline, `<li>` → `- `;
 * 3. `<a href="X">T</a>` → `T (X)` when X is http(s) and differs from T;
 * 4. strips remaining tags; 5. decodes entities;
 * 6. normalizes CRLF/CR to LF, trims trailing spaces per line, collapses 3+
 *    newlines to 2, and trims the result.
 */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '');

  s = s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|h[1-6]|li|tr|blockquote|pre|ul|ol|table)\s*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ');

  s = s.replace(
    /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi,
    (
      _match,
      dq: string | undefined,
      sq: string | undefined,
      bare: string | undefined,
      inner: string,
    ) => {
      const href = decodeEntities(dq ?? sq ?? bare ?? '').trim();
      const text = decodeEntities(stripTags(inner)).trim();
      return /^https?:\/\//i.test(href) && href !== text
        ? `${inner} (${escapeForDecode(href)})`
        : inner;
    },
  );

  s = decodeEntities(stripTags(s));

  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
