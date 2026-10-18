/**
 * @fileoverview Composes the Zenodo search request from validated filters. Only
 * allowlisted query parameters are ever emitted; every other filter composes into
 * `q` as a quoted field clause. Also holds the local query pre-checks (including a
 * recognizer of the query grammar Zenodo parses `q` with) and the partial-date
 * expansion search needs.
 * @module services/zenodo/query-builder
 */

import type { AwardRef } from './identifiers.js';
import { getResourceType } from './resource-types.js';

/** Sort options Zenodo's record search accepts. */
export const SEARCH_SORTS = [
  'bestmatch',
  'newest',
  'oldest',
  'mostviewed',
  'mostdownloaded',
  'updated-desc',
  'updated-asc',
] as const;
export type SearchSort = (typeof SEARCH_SORTS)[number];

/** Access-status filter values. */
export const ACCESS_STATUSES = ['open', 'restricted', 'embargoed', 'metadata-only'] as const;
export type AccessStatus = (typeof ACCESS_STATUSES)[number];

/** Filters in their resolved, upstream-ready form. */
export interface SearchFilters {
  accessStatus?: AccessStatus;
  allVersions: boolean;
  award?: AwardRef;
  /** Canonical community UUID. */
  communityId?: string;
  creatorOrcid?: string;
  fileTypes?: string[];
  /** Funder ROR id. */
  funderRor?: string;
  license?: string;
  page: number;
  /** Expanded full date, `YYYY-MM-DD`. */
  publishedFrom?: string;
  /** Expanded full date, `YYYY-MM-DD`. */
  publishedTo?: string;
  query?: string;
  /** Resource type ids (`dataset`, `publication-article`), OR-ed. */
  resourceTypes?: string[];
  size: number;
  sort: SearchSort;
}

/** A built search request: the composed `q` (when any) and the ordered param list. */
export interface BuiltSearch {
  params: [string, string][];
  q?: string;
}

/** Wraps a value in double quotes, escaping `\` and `"`. */
export function quoteValue(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/** Operator words that leave a query's first or last word with nothing on one side. */
const LEADING_OPERATORS = new Set(['AND', 'OR', '&&', '||']);
const TRAILING_OPERATORS = new Set([...LEADING_OPERATORS, 'NOT', '+', '-', '!']);

/** `query` without operator words at its start or end, spacing inside it kept. */
function trimOperators(query: string): string {
  const words = [...query.matchAll(/\S+/g)];
  let first = 0;
  let last = words.length - 1;
  while (first <= last && LEADING_OPERATORS.has(words[first]?.[0] ?? '')) first++;
  while (last >= first && TRAILING_OPERATORS.has(words[last]?.[0] ?? '')) last--;
  const head = words[first];
  const tail = words[last];
  return head && tail && first <= last ? query.slice(head.index, tail.index + tail[0].length) : '';
}

/**
 * Closes whatever a caller's query leaves open, so it stays inside the parentheses
 * it is composed in: a leading or trailing boolean operator is dropped, a dangling
 * `\` is completed as `\\`, an unterminated quote or `/…/` regex is closed, a `)`
 * with no open group is escaped as `\)`, and each group left open is closed.
 * Zenodo matches a query it cannot parse as plain text, which turns the filter
 * clauses into optional terms (an unterminated quote matched the whole corpus
 * instead of the filtered set), and a stray `)` lets the query widen them. Inside a
 * range, as Zenodo's search engine lexes it ({@link rangeSpan}), a `/` and a `"` that
 * does not close within the range are literal, so they leave nothing open
 * (`[a"b TO c]`). A well-formed query comes back unchanged.
 */
export function balanceQuery(raw: string): string {
  const query = trimOperators(raw);
  let out = '';
  let depth = 0;
  let mode: 'text' | 'quote' | 'regex' = 'text';
  /** End of the range the scan is inside; once one never closes, none after it can. */
  let rangeStop = 0;
  let rangesClose = true;
  for (let i = 0; i < query.length; i++) {
    const ch = query[i] as string;
    if (ch === '\\') {
      out += i + 1 < query.length ? query.slice(i, i + 2) : '\\\\';
      i++;
      continue;
    }
    if (mode === 'quote') {
      if (ch === '"') mode = 'text';
    } else if (mode === 'regex') {
      if (ch === '/') mode = 'text';
    } else if ((ch === '"' || ch === '/') && !boundCharacter(query, i, rangeStop)) {
      mode = ch === '"' ? 'quote' : 'regex';
    } else if ((ch === '[' || ch === '{') && i >= rangeStop && rangesClose) {
      const { end } = rangeSpan(query, i);
      if (end < 0) rangesClose = false;
      else rangeStop = end;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      if (depth === 0) {
        out += '\\)';
        continue;
      }
      depth--;
    }
    out += ch;
  }
  if (mode === 'quote') out += '"';
  if (mode === 'regex') out += '/';
  return out + ')'.repeat(depth);
}

/**
 * The caller's query as it sits in `q`: balanced ({@link balanceQuery}) when filter
 * clauses compose with it, otherwise trimmed and sent as written. `''` when nothing
 * of it remains, in which case `q` carries no query part.
 */
export function queryAsSent(query: string | undefined, withClauses: boolean): string {
  return withClauses ? balanceQuery(query ?? '') : (query?.trim() ?? '');
}

/** Where a query stops being valid search syntax, and why. */
export interface QuerySyntaxError {
  /** Offset of the offending token in the checked query (its length when `problem` is `end`). */
  readonly index: number;
  /**
   * `unexpected`: a token the grammar does not allow there; `end`: the query stops
   * where a term must follow; `quote`: a term starts with `'`; `escape`: a `\` before
   * a line break or at the end; `phrase` / `regex`: a `"` or `/` that is never closed;
   * `regex_quote`: a regex whose body opens a quoted string it never closes;
   * `word_quote`: a `"` inside a word that opens a phrase never closed;
   * `word_span`: a phrase or regex opened inside a word that takes in a bracket the
   * query needs; `range_escape`: a range bound that ends in an unpaired `\`;
   * `dangling_not`: a `!` with nothing after it ({@link engineSyntaxError} reports
   * these five); `boost` / `fuzzy` / `proximity`: a `^` or `~` value the parser
   * cannot convert ({@link converts}).
   */
  readonly problem:
    | 'unexpected'
    | 'end'
    | 'quote'
    | 'escape'
    | 'phrase'
    | 'regex'
    | 'regex_quote'
    | 'word_quote'
    | 'word_span'
    | 'range_escape'
    | 'dangling_not'
    | Conversion;
  /** The offending token as written; `''` when `problem` is `end`. */
  readonly token: string;
}

/** A `^` or `~` value luqum converts to a number while it parses. */
type Conversion = 'boost' | 'fuzzy' | 'proximity';
const CONVERSIONS = new Set<QuerySyntaxError['problem']>(['boost', 'fuzzy', 'proximity']);

/**
 * True when `error` is a value luqum cannot convert. Zenodo answers that with HTTP
 * 500 rather than its plain-text fallback, so it fails with or without filters.
 */
export const isConversionError = (error: QuerySyntaxError): boolean =>
  CONVERSIONS.has(error.problem);

type TokenKind =
  | 'TERM'
  | 'PHRASE'
  | 'REGEX'
  | 'APPROX'
  | 'BOOST'
  | 'PLUS'
  | 'MINUS'
  | 'NOT'
  | 'AND'
  | 'OR'
  | 'TO'
  | 'COLUMN'
  | 'LPAREN'
  | 'RPAREN'
  | 'LBRACKET'
  | 'RBRACKET'
  | 'CMP'
  | 'EOF';

/** A lexed token, or the spot where no token can start and why. */
type Token =
  | { end: number; kind: TokenKind; start: number }
  | {
      end: number;
      kind: 'ILLEGAL';
      problem: 'quote' | 'escape' | 'phrase' | 'regex';
      start: number;
    };

/** Characters (besides whitespace) that cannot start a term. */
const TERM_START_EXCLUDED = ':^~(){}[]/"\'+-\\<>';
/** Characters (besides whitespace) that end a term. */
const TERM_CONTINUE_EXCLUDED = ':^\\~(){}[]';
const KEYWORDS = new Map<string, TokenKind>([
  ['AND', 'AND'],
  ['OR', 'OR'],
  ['NOT', 'NOT'],
  ['TO', 'TO'],
]);
const SINGLE_CHAR = new Map<string, TokenKind>([
  ['+', 'PLUS'],
  ['-', 'MINUS'],
  [':', 'COLUMN'],
  ['(', 'LPAREN'],
  [')', 'RPAREN'],
  ['[', 'LBRACKET'],
  ['{', 'LBRACKET'],
  [']', 'RBRACKET'],
  ['}', 'RBRACKET'],
]);
/** Kinds that can open a unary expression. */
const UNARY_START = new Set<Token['kind']>([
  'PLUS',
  'MINUS',
  'NOT',
  'LPAREN',
  'LBRACKET',
  'CMP',
  'TERM',
  'PHRASE',
  'REGEX',
  'TO',
]);
/**
 * A time part inside a term (`2020-01-01T12:30:00`): a `:` right after `T` and two
 * digits, then two digits and an optional `:` with two more. Run sticky on a short
 * window around the `:` ({@link timePartEnd}), never on the whole query.
 */
const TIME_PART = /(?<=T\p{Nd}{2}):\p{Nd}{2}(?::\p{Nd}{2})?/uy;

/**
 * End of the time part whose `:` is at `j`, or -1. The window holds the five code
 * units the lookbehind can need (`T` and two astral digits) and the ten the match
 * can span.
 */
function timePartEnd(q: string, j: number): number {
  const start = Math.max(0, j - 5);
  TIME_PART.lastIndex = j - start;
  return TIME_PART.test(q.slice(start, j + 11)) ? start + TIME_PART.lastIndex : -1;
}

/** Python's `str.isspace()`, which is what Zenodo's parser skips between tokens. */
function isSpace(code: number): boolean {
  return (
    (code >= 0x09 && code <= 0x0d) ||
    (code >= 0x1c && code <= 0x20) ||
    code === 0x85 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000
  );
}

/** True when a `\` at `i` escapes the next character (anything but a line feed). */
const escapes = (q: string, i: number): boolean => i + 1 < q.length && q[i + 1] !== '\n';

/** The `"…"` or `/…/` opened at `i`, or why it never closes. */
function closeDelimited(q: string, i: number, delim: '"' | '/'): Token {
  for (let j = i + 1; j < q.length; j++) {
    if (q[j] === delim) return { kind: delim === '"' ? 'PHRASE' : 'REGEX', start: i, end: j + 1 };
    if (q[j] !== '\\' || j + 1 >= q.length) continue;
    if (q[j + 1] === '\n') return { kind: 'ILLEGAL', problem: 'escape', start: j, end: j + 1 };
    j++;
  }
  return { kind: 'ILLEGAL', problem: delim === '"' ? 'phrase' : 'regex', start: i, end: q.length };
}

/** End of the run of digits and dots starting at `i`. */
function numberEnd(q: string, i: number): number {
  let j = i;
  for (let c = q.charCodeAt(j); c === 0x2e || (c >= 0x30 && c <= 0x39); c = q.charCodeAt(j)) j++;
  return j;
}

/**
 * True when luqum converts the digits and dots after the `^` or `~` of `tok`. A
 * boost (`^2`) or a term's fuzziness (`~0.5`) becomes a `Decimal`, so it takes one
 * decimal number: at least one digit and at most one dot (`^.5`, `^1.`). A
 * phrase's proximity (`"x y"~2`) becomes an `int`, so it takes digits alone. A bare
 * `^` or `~` takes luqum's default.
 */
function converts(q: string, tok: Token, whole: boolean): boolean {
  let dots = 0;
  for (let i = tok.start + 1; i < tok.end; i++) if (q.charCodeAt(i) === 0x2e) dots++;
  const digits = tok.end - tok.start - 1 - dots;
  return digits + dots === 0 || (digits > 0 && dots <= (whole ? 0 : 1));
}

/**
 * Tokens after a `^` or `~` value on which luqum stops before converting it: its
 * lexer fails first, or its parser rejects the token without reducing the value.
 */
const CONVERSION_STOPS = new Set<Token['kind']>(['ILLEGAL', 'COLUMN', 'RBRACKET', 'APPROX']);

/** End of the term starting at `i` (its first character already accepted). */
function termEnd(q: string, i: number): number {
  let j = q[i] === '\\' ? i + 2 : i + 1;
  while (j < q.length) {
    const ch = q[j] as string;
    if (ch === '\\') {
      if (!escapes(q, j)) break;
      j += 2;
    } else if (ch === ':') {
      const end = timePartEnd(q, j);
      if (end < 0) break;
      j = end;
    } else if (isSpace(q.charCodeAt(j)) || TERM_CONTINUE_EXCLUDED.includes(ch)) {
      break;
    } else {
      j++;
    }
  }
  return j;
}

/** The token at or after `from`, whitespace skipped. Mirrors luqum 1.0.0's lexer rules in their order. */
function nextToken(q: string, from: number): Token {
  let i = from;
  while (i < q.length && isSpace(q.charCodeAt(i))) i++;
  if (i >= q.length) return { kind: 'EOF', start: q.length, end: q.length };
  const ch = q[i] as string;
  if (ch === '\\' ? escapes(q, i) : !TERM_START_EXCLUDED.includes(ch)) {
    const end = termEnd(q, i);
    return { kind: (end - i <= 3 && KEYWORDS.get(q.slice(i, end))) || 'TERM', start: i, end };
  }
  const single = SINGLE_CHAR.get(ch);
  if (single) return { kind: single, start: i, end: i + 1 };
  switch (ch) {
    case '<':
    case '>':
      return { kind: 'CMP', start: i, end: q[i + 1] === '=' ? i + 2 : i + 1 };
    case '"':
    case '/':
      return closeDelimited(q, i, ch);
    case '~':
      return { kind: 'APPROX', start: i, end: numberEnd(q, i + 1) };
    case '^':
      return { kind: 'BOOST', start: i, end: numberEnd(q, i + 1) };
    case "'":
      return { kind: 'ILLEGAL', problem: 'quote', start: i, end: i + 1 };
    default:
      return { kind: 'ILLEGAL', problem: 'escape', start: i, end: i + 1 };
  }
}

/**
 * Checks `query` against the grammar Zenodo parses `q` with (luqum 1.0.0, whose
 * failures Zenodo answers by matching the whole `q` as plain text), returning the
 * first problem in reading order, or `undefined` when it parses:
 *
 * ```text
 * query := expr EOF
 * expr  := seq ((AND | OR) seq)*
 * seq   := unary+
 * unary := (+ | - | NOT) unary  |  atom BOOST*
 * atom  := ( expr )  |  [ bound TO bound ]  |  (< | <= | > | >=) (TERM | PHRASE)
 *        | TERM : unary  |  TERM APPROX?  |  PHRASE APPROX?  |  REGEX  |  TO
 * bound := -? (TERM | PHRASE)
 * ```
 *
 * One forward pass with no recursion: prefixes and `field:` chains are tail
 * positions, and the only nesting, `( expr )`, needs nothing but a depth count, so
 * any depth the parser accepts is accepted here too.
 *
 * A boost, fuzziness, or proximity value is converted when luqum reduces it, which
 * it does on reading the next token unless that token stops it
 * ({@link CONVERSION_STOPS}); a value it cannot convert is reported there, as
 * `boost`, `fuzzy`, or `proximity`.
 */
export function querySyntaxError(query: string): QuerySyntaxError | undefined {
  let tok = nextToken(query, 0);
  const next = () => nextToken(query, tok.end);
  const fail = (): QuerySyntaxError => {
    if (tok.kind === 'ILLEGAL') {
      return { problem: tok.problem, index: tok.start, token: query.slice(tok.start, tok.end) };
    }
    if (tok.kind === 'EOF') return { problem: 'end', index: query.length, token: '' };
    return { problem: 'unexpected', index: tok.start, token: query.slice(tok.start, tok.end) };
  };
  /** Steps past the `^` or `~` value at `tok`; its conversion failure, when luqum gets that far. */
  const convert = (problem: Conversion): QuerySyntaxError | undefined => {
    const value = tok;
    tok = next();
    return CONVERSION_STOPS.has(tok.kind) || converts(query, value, problem === 'proximity')
      ? undefined
      : { problem, index: value.start, token: query.slice(value.start, value.end) };
  };
  /** `-? (TERM | PHRASE)`, a range bound; false (nothing consumed past a `-`) when absent. */
  const bound = (): boolean => {
    if (tok.kind === 'MINUS') tok = next();
    if (tok.kind !== 'TERM' && tok.kind !== 'PHRASE') return false;
    tok = next();
    return true;
  };

  let depth = 0;
  for (;;) {
    // One unary, through its prefixes and `field:` chain to the atom that ends it.
    for (;;) {
      if (tok.kind === 'PLUS' || tok.kind === 'MINUS' || tok.kind === 'NOT') {
        tok = next();
      } else if (tok.kind === 'LPAREN') {
        depth++;
        tok = next();
      } else if (tok.kind === 'TERM') {
        tok = next();
        if (tok.kind !== 'COLUMN') {
          const failed = tok.kind === 'APPROX' ? convert('fuzzy') : undefined;
          if (failed) return failed;
          break;
        }
        tok = next();
      } else if (tok.kind === 'PHRASE') {
        tok = next();
        const failed = tok.kind === 'APPROX' ? convert('proximity') : undefined;
        if (failed) return failed;
        break;
      } else if (tok.kind === 'REGEX' || tok.kind === 'TO') {
        tok = next();
        break;
      } else if (tok.kind === 'CMP') {
        tok = next();
        if (tok.kind !== 'TERM' && tok.kind !== 'PHRASE') return fail();
        tok = next();
        break;
      } else if (tok.kind === 'LBRACKET') {
        tok = next();
        if (!bound() || tok.kind !== 'TO') return fail();
        tok = next();
        if (!bound() || tok.kind !== 'RBRACKET') return fail();
        tok = next();
        break;
      } else {
        return fail();
      }
    }
    // After an atom: its boosts, then each `)` that closes a group (boosts apply to it too).
    for (;;) {
      while (tok.kind === 'BOOST') {
        const failed = convert('boost');
        if (failed) return failed;
      }
      if (tok.kind !== 'RPAREN' || depth === 0) break;
      depth--;
      tok = next();
    }
    if (tok.kind === 'AND' || tok.kind === 'OR') {
      tok = next();
    } else if (tok.kind === 'EOF' && depth === 0) {
      return undefined;
    } else if (!UNARY_START.has(tok.kind)) {
      return fail();
    }
  }
}

/** One clause, or several OR-ed inside parentheses. */
function anyOf(clauses: string[]): string {
  return clauses.length === 1 ? (clauses[0] as string) : `(${clauses.join(' OR ')})`;
}

/**
 * The `q` clause for one resource type id. A top-level type matches on
 * `props.type`, which covers its subtypes (`image` includes `image-photo`); a
 * subtype matches on its own id.
 */
function resourceTypeClause(id: string): string {
  return getResourceType(id)?.parentType
    ? `metadata.resource_type.id:${quoteValue(id)}`
    : `metadata.resource_type.props.type:${quoteValue(id)}`;
}

/**
 * Composes `q` and the allowlisted params from resolved filters. Resource type, file
 * type, and access status compose into `q` rather than riding Zenodo's
 * `resource_type` / `file_type` / `access_status` params: those params are
 * post-filters, applied after the aggregations are computed, so the facet counts
 * would ignore them and contradict `total`. As `q` clauses they narrow hits and
 * facets alike, with the same totals. The query is balanced ({@link balanceQuery})
 * before it is grouped with them, so it cannot drop or widen a filter clause.
 */
export function buildSearch(filters: SearchFilters): BuiltSearch {
  const clauses: string[] = [];
  if (filters.funderRor)
    clauses.push(`metadata.funding.funder.id:${quoteValue(filters.funderRor)}`);
  if (filters.award) {
    clauses.push(
      `metadata.funding.award.${filters.award.field}:${quoteValue(filters.award.value)}`,
    );
  }
  if (filters.creatorOrcid) {
    clauses.push(
      `metadata.creators.person_or_org.identifiers.identifier:${quoteValue(filters.creatorOrcid)}`,
    );
  }
  if (filters.license) clauses.push(`metadata.rights.id:${quoteValue(filters.license)}`);
  if (filters.resourceTypes?.length)
    clauses.push(anyOf(filters.resourceTypes.map(resourceTypeClause)));
  if (filters.fileTypes?.length) {
    clauses.push(anyOf(filters.fileTypes.map((t) => `files.types:${quoteValue(t)}`)));
  }
  if (filters.accessStatus) clauses.push(`access.status:${quoteValue(filters.accessStatus)}`);
  if (filters.publishedFrom || filters.publishedTo) {
    clauses.push(
      `metadata.publication_date:[${filters.publishedFrom ?? '*'} TO ${filters.publishedTo ?? '*'}]`,
    );
  }

  const query = queryAsSent(filters.query, clauses.length > 0);
  if (query) clauses.unshift(clauses.length > 0 ? `(${query})` : query);
  const q = clauses.length > 0 ? clauses.join(' AND ') : undefined;

  const params: [string, string][] = [];
  if (q) params.push(['q', q]);
  if (filters.communityId) params.push(['communities', filters.communityId]);
  if (filters.allVersions) params.push(['all_versions', 'true']);
  params.push(
    ['sort', filters.sort],
    ['page', String(filters.page)],
    ['size', String(filters.size)],
  );
  return q ? { q, params } : { params };
}

/**
 * Escapes the query-syntax characters that make Zenodo's vocabulary endpoints
 * answer HTTP 500 (`10.13039/100000002`, `a:b:c`), so a name, acronym, or DOI
 * typed as a vocabulary query searches as text. Quotes, `*`, `+`, and `-` keep
 * their meaning.
 */
export function escapeVocabularyQuery(query: string): string {
  return query.replace(/[\\/:[\]{}()^~!?]/g, '\\$&');
}

/**
 * Offset of the `"` in the regex body `q[from, to)` that opens a quoted string the
 * body never closes, or -1. Zenodo's search engine compiles a regex body where `\`
 * escapes the next character, `"…"` is a literal string with no escapes inside,
 * and a `"` within a `[…]` character class is literal.
 */
function unclosedRegexQuote(q: string, from: number, to: number): number {
  for (let i = from; i < to; i++) {
    const ch = q[i];
    if (ch === '\\') {
      i++;
    } else if (ch === '"') {
      const close = q.indexOf('"', i + 1);
      if (close === -1 || close >= to) return i;
      i = close;
    } else if (ch === '[') {
      // A class's first member is literal even when it is `]`.
      let j = q[i + 1] === '^' ? i + 2 : i + 1;
      j += q[j] === '\\' ? 2 : 1;
      while (j < to && q[j] !== ']') j += q[j] === '\\' ? 2 : 1;
      i = j;
    }
  }
  return -1;
}

/** What Zenodo's search engine skips between the tokens of a range. */
const isEngineSpace = (ch: string | undefined): boolean =>
  ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '　';

/** A range as Zenodo's search engine lexes it ({@link rangeSpan}). */
interface RangeSpan {
  /** Offset just past the closing `]` or `}`, or -1 when the range never closes. */
  readonly end: number;
  /** The first unquoted bound ending in an unpaired `\`, as `[start, end)`. */
  readonly escaped: readonly [start: number, end: number] | undefined;
}

/** True when `q[from, to)` ends in an odd run of `\`. */
function endsInEscape(q: string, from: number, to: number): boolean {
  let j = to;
  while (j > from && q[j - 1] === '\\') j--;
  return (to - j) % 2 === 1;
}

/**
 * The range opened by the `[` or `{` at `i`, as Zenodo's search engine lexes it. A
 * bound runs to the next space, `]`, or `}`, and a `"` opens a quoted bound only at a
 * bound's start, when that is the longer token; a `"`, `/`, bracket, or `\` inside a
 * bound is literal (`[a"b TO c/d]` runs), so a bound luqum reads past an escaped
 * space, `]`, or `}` ends there, in a `\` the engine cannot unescape
 * (`[a TO b\]]` → 500).
 */
function rangeSpan(q: string, i: number): RangeSpan {
  let escaped: RangeSpan['escaped'];
  let j = i + 1;
  for (;;) {
    while (j < q.length && isEngineSpace(q[j])) j++;
    if (j >= q.length) return { end: -1, escaped };
    if (q[j] === ']' || q[j] === '}') return { end: j + 1, escaped };
    let end = j + 1;
    while (end < q.length && q[end] !== ' ' && q[end] !== ']' && q[end] !== '}') end++;
    const quoted = q[j] === '"' ? closeDelimited(q, j, '"') : undefined;
    if (quoted?.kind === 'PHRASE' && quoted.end >= end) end = quoted.end;
    else if (!escaped && endsInEscape(q, j, end)) escaped = [j, end];
    j = end;
  }
}

/**
 * True when the `"` or `/` at `i` is a character of a range bound, inside the range
 * ending at `stop`: a `/` always, a `"` unless its phrase closes inside the range.
 */
function boundCharacter(q: string, i: number, stop: number): boolean {
  if (i >= stop) return false;
  if (q[i] === '/') return true;
  const phrase = closeDelimited(q, i, '"');
  return phrase.kind !== 'PHRASE' || phrase.end > stop;
}

/** True when only engine whitespace stands between `i` and the query's end or a `)`. */
function nothingFollows(q: string, i: number): boolean {
  let j = i;
  while (j < q.length && isEngineSpace(q[j])) j++;
  return j >= q.length || q[j] === ')';
}

/** True when luqum's lexer, reading `q` from the start, meets a phrase at `at` it never closes. */
function luqumLeavesPhraseOpenAt(q: string, at: number): boolean {
  let tok = nextToken(q, 0);
  while (tok.start < at && tok.kind !== 'EOF') tok = nextToken(q, tok.end);
  return tok.start === at && tok.kind === 'ILLEGAL' && tok.problem === 'phrase';
}

/**
 * The first query part Zenodo's search engine cannot run, read as that engine lexes
 * `q` once luqum has parsed it. The engine opens a phrase at every unescaped `"` and a
 * regex at every unescaped `/` outside a phrase, regex, or range, inside a word too,
 * where luqum reads either as part of the word; phrases and regexes are delimited as
 * luqum lexes them ({@link closeDelimited}). It reports:
 *
 * - `regex`: a regex never closed (`climate 10.5281/zenodo.591564`, HTTP 500);
 * - `regex_quote`: a regex whose body opens a quoted string it never closes (`/a"/ b`, HTTP 400);
 * - `word_quote`: a phrase never closed that luqum does not leave open itself
 *   (`climate a"b`, HTTP 500; `climate "model` is luqum's own and passes);
 * - `word_span`: when luqum parses the query but the engine's phrases and regexes
 *   leave a `(`, `)`, `[`, `]`, `{`, or `}` unmatched, the first of them luqum does not
 *   read (`(a"b) c"`, HTTP 500);
 * - `range_escape`: a range bound ending in an unpaired `\`, which the engine cannot
 *   unescape ({@link rangeSpan}; `[a TO b\]]`, `[a\ b TO c]`, HTTP 500);
 * - `dangling_not`: a `!`, which the engine reads as NOT inside a word too, with
 *   nothing after it but a `)` or the end (`climate!`, `(climate!) model`, HTTP 500).
 */
export function engineSyntaxError(query: string): QuerySyntaxError | undefined {
  const spans: [start: number, end: number][] = [];
  let depth = 0;
  let unmatched = false;
  for (let i = 0; i < query.length; i++) {
    const ch = query[i];
    if (ch === '\\') {
      i++;
    } else if (ch === '[' || ch === '{') {
      const { end, escaped } = rangeSpan(query, i);
      if (end < 0) {
        unmatched = true;
        break;
      }
      if (escaped)
        return { problem: 'range_escape', index: escaped[0], token: query.slice(...escaped) };
      i = end - 1;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')' && depth > 0) {
      depth--;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      unmatched = true;
    } else if (ch === '!' && nothingFollows(query, i + 1)) {
      return { problem: 'dangling_not', index: i, token: '!' };
    } else if (ch === '"' || ch === '/') {
      const span = closeDelimited(query, i, ch);
      if (span.kind === 'ILLEGAL') {
        if (span.problem === 'regex') return { problem: 'regex', index: i, token: query.slice(i) };
        return span.problem === 'phrase' && !luqumLeavesPhraseOpenAt(query, i)
          ? { problem: 'word_quote', index: i, token: query.slice(i) }
          : undefined;
      }
      if (ch === '/' && unclosedRegexQuote(query, i + 1, span.end - 1) !== -1) {
        return { problem: 'regex_quote', index: i, token: query.slice(i, span.end) };
      }
      spans.push([i, span.end]);
      i = span.end - 1;
    }
  }
  if ((!unmatched && depth === 0) || querySyntaxError(query)) return undefined;
  const luqumStarts = new Set<number>();
  for (let tok = nextToken(query, 0); tok.kind !== 'EOF'; tok = nextToken(query, tok.end)) {
    if (tok.kind === 'PHRASE' || tok.kind === 'REGEX') luqumStarts.add(tok.start);
  }
  const moved = spans.find(([start]) => !luqumStarts.has(start));
  return moved && { problem: 'word_span', index: moved[0], token: query.slice(...moved) };
}

const PARTIAL_DATE = /^(\d{4})(?:-(0[1-9]|1[0-2])(?:-(0[1-9]|[12]\d|3[01]))?)?$/;

/**
 * Days in a month (1-based), leap years included. `setUTCFullYear` takes the year
 * literally; `Date.UTC` would map years 0–99 to 1900–1999.
 */
function daysInMonth(year: number, month: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month, 0);
  return date.getUTCDate();
}

/** True when `value` is `YYYY`, `YYYY-MM`, or a real calendar date `YYYY-MM-DD`. */
export function isValidPartialDate(value: string): boolean {
  const m = PARTIAL_DATE.exec(value);
  if (!m) return false;
  if (!m[3]) return true;
  return Number(m[3]) <= daysInMonth(Number(m[1]), Number(m[2]));
}

/**
 * Expands a partial date to a full day: `from` takes the first day of the year or
 * month, `to` the last. Upstream compares partial dates as instants, so
 * `[2020 TO 2020]` would match only records dated exactly `2020`.
 */
export function expandPartialDate(value: string, side: 'from' | 'to'): string {
  const m = PARTIAL_DATE.exec(value);
  if (!m?.[1]) return value;
  const year = m[1];
  if (m[3] && m[2]) return value;
  if (m[2]) {
    const day = side === 'from' ? 1 : daysInMonth(Number(year), Number(m[2]));
    return `${year}-${m[2]}-${String(day).padStart(2, '0')}`;
  }
  return side === 'from' ? `${year}-01-01` : `${year}-12-31`;
}
