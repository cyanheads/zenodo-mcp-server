/**
 * @fileoverview Pure parsers for the identifier forms Zenodo tools accept: record
 * references (record ids, Zenodo and external DOIs, zenodo.org and doi.org URLs),
 * funder, award, ORCID, and community references, plus file-key path encoding.
 * Nothing here touches the network; URLs are parsed locally and never fetched.
 * @module services/zenodo/identifiers
 */

/** How an `id` input was written. */
export type InputKind = 'record_id' | 'zenodo_doi' | 'external_doi' | 'url';

/** A record reference resolved to a Zenodo record id without any upstream call. */
export interface RecidRef {
  inputKind: InputKind;
  kind: 'recid';
  recid: string;
}

/**
 * A DOI minted outside Zenodo's `10.5281/zenodo.N` scheme. `doi` is the form as
 * given; `strippedDoi` is the form with trailing `.`/`,`/`;` removed, tried only
 * when the as-given form misses.
 */
export interface ExternalDoiRef {
  doi: string;
  inputKind: InputKind;
  kind: 'external_doi';
  strippedDoi?: string;
}

/** An input that matches no accepted form. `message` says why. */
export interface ParseFailure {
  kind: 'invalid';
  message: string;
}

export type RecordRef = RecidRef | ExternalDoiRef;

const ZENODO_HOSTS = new Set(['zenodo.org', 'www.zenodo.org']);
const DOI_HOSTS = new Set(['doi.org', 'dx.doi.org', 'www.doi.org']);
const DOI_PATTERN = /^10\.\d{4,9}\/\S+$/;
const ZENODO_DOI_PATTERN = /^10\.5281\/zenodo\.(\d+)$/i;
const ZENODO_SUFFIX_PATTERN = /^zenodo\.(\d+)$/i;
const TRAILING_PUNCTUATION = /[.,;]+$/;

/** True when `s` is enclosed in `<…>` or a pair of quote characters. */
function isWrapped(s: string): boolean {
  return (
    s.length >= 2 &&
    ((s.startsWith('<') && s.endsWith('>')) || (/^["'“”‘’]/.test(s) && /["'“”‘’]$/.test(s)))
  );
}

/**
 * Removes wrapping `<…>`, `"…"`, `'…'`, and surrounding whitespace, repeatedly, in
 * any nesting order. Trailing `.`/`,`/`;` after a closing wrapper — an id copied
 * out of a sentence such as `…available at <https://doi.org/…>.` — sits outside the
 * value and is dropped with it; punctuation inside the wrapper is left to the
 * per-form rules.
 */
function stripWrapping(raw: string): string {
  let s = raw.trim();
  for (;;) {
    const unpunctuated = s.replace(TRAILING_PUNCTUATION, '').trimEnd();
    if (!isWrapped(unpunctuated)) return s;
    s = unpunctuated.slice(1, -1).trim();
  }
}

/** Classifies a bare DOI string (no `doi:` prefix, no URL). */
function classifyDoi(doi: string, inputKind: InputKind): RecordRef | ParseFailure {
  const stripped = doi.replace(TRAILING_PUNCTUATION, '');
  const zenodo = ZENODO_DOI_PATTERN.exec(stripped);
  if (zenodo?.[1]) {
    return {
      kind: 'recid',
      recid: zenodo[1],
      inputKind: inputKind === 'url' ? 'url' : 'zenodo_doi',
    };
  }
  if (!DOI_PATTERN.test(doi)) {
    return {
      kind: 'invalid',
      message: `"${doi}" is not a well-formed DOI (expected 10.NNNN/suffix).`,
    };
  }
  return {
    kind: 'external_doi',
    doi,
    inputKind: inputKind === 'url' ? 'url' : 'external_doi',
    ...(stripped !== doi && DOI_PATTERN.test(stripped) ? { strippedDoi: stripped } : {}),
  };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Parses a zenodo.org or doi.org URL. Other hosts are rejected. */
function parseUrl(raw: string): RecordRef | ParseFailure {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { kind: 'invalid', message: `"${raw}" is not a valid URL.` };
  }
  const host = url.hostname.toLowerCase();

  if (DOI_HOSTS.has(host)) {
    const doi = safeDecode(url.pathname.replace(/^\/+/, ''));
    return classifyDoi(doi, 'url');
  }

  if (!ZENODO_HOSTS.has(host)) {
    const note = host.endsWith('zenodo.org')
      ? `${host} is a different Zenodo instance; only zenodo.org records are served.`
      : `${host} is not zenodo.org or doi.org.`;
    return { kind: 'invalid', message: note };
  }

  const path = url.pathname.replace(TRAILING_PUNCTUATION, '');
  if (/^\/badge\/latestdoi\//i.test(path)) {
    return {
      kind: 'invalid',
      message:
        'A zenodo.org/badge/latestdoi URL carries a GitHub repository id, not a Zenodo record id.',
    };
  }
  const record = /^\/(?:api\/)?records?\/(\d+)(?:\/|$)/i.exec(path);
  if (record?.[1]) return { kind: 'recid', recid: record[1], inputKind: 'url' };

  const doiPath = /^\/doi\/(.+)$/i.exec(path);
  if (doiPath?.[1]) return classifyDoi(safeDecode(doiPath[1]), 'url');

  const badge = /^\/badge\/doi\/(.+?)(?:\.svg)?$/i.exec(path);
  if (badge?.[1]) return classifyDoi(safeDecode(badge[1]), 'url');

  return {
    kind: 'invalid',
    message: `The zenodo.org path ${url.pathname} does not name a record.`,
  };
}

/**
 * Classifies a record reference. Accepts a record id, `zenodo.N`, a Zenodo DOI
 * (any case, optionally `doi:`-prefixed), another DOI, a doi.org URL, or a
 * zenodo.org record/DOI/badge URL. Wrapping `<>` / quotes (with any punctuation
 * after them) and trailing punctuation after a record id or Zenodo DOI are
 * stripped, in whichever order they were combined. Query strings and
 * fragments are ignored. Never fetches anything.
 */
export function parseRecordRef(raw: string): RecordRef | ParseFailure {
  const s = stripWrapping(raw);
  if (!s) return { kind: 'invalid', message: 'The id is empty.' };

  const withScheme = /^(?:www\.)?(?:zenodo|doi|dx\.doi|sandbox\.zenodo)\.org\//i.test(s)
    ? `https://${s}`
    : s;
  if (/^https?:\/\//i.test(withScheme)) return parseUrl(withScheme);

  const bare = s.replace(/^doi:\s*/i, '');
  const stripped = bare.replace(TRAILING_PUNCTUATION, '');

  if (bare === s && /^\d+$/.test(stripped)) {
    return { kind: 'recid', recid: stripped, inputKind: 'record_id' };
  }
  const suffix = ZENODO_SUFFIX_PATTERN.exec(stripped);
  if (suffix?.[1]) return { kind: 'recid', recid: suffix[1], inputKind: 'zenodo_doi' };

  if (/^10\./.test(bare)) return classifyDoi(bare, 'external_doi');

  return {
    kind: 'invalid',
    message: `"${raw.trim().slice(0, 120)}" is not a Zenodo record id, DOI, or zenodo.org/doi.org URL.`,
  };
}

/** True when `raw` parses as a single DOI or URL record reference (not a bare number). */
export function isWholeIdentifier(raw: string): boolean {
  const s = raw.trim();
  if (/^[a-z_.]+:/i.test(s) && !/^https?:/i.test(s)) return false;
  const ref = parseRecordRef(s);
  return ref.kind !== 'invalid' && ref.inputKind !== 'record_id' && !ZENODO_SUFFIX_PATTERN.test(s);
}

/** A funder reference as the service resolves it. */
export type FunderRef = { kind: 'ror'; ror: string } | { kind: 'funder_doi'; doi: string };

const ROR_ID = /^0[a-z0-9]{6}\d{2}$/;

/**
 * Parses a funder reference: a ROR id (`01cwqze88`), a ROR URL, or a Crossref
 * Funder DOI (`10.13039/100000002`, bare, `doi:`-prefixed, or as a doi.org URL).
 * Returns `undefined` for anything else — funder names are never matched.
 */
export function parseFunderRef(raw: string): FunderRef | undefined {
  const s = stripWrapping(raw).replace(/\/+$/, '');
  const ror = /^(?:https?:\/\/)?(?:www\.)?ror\.org\/(.+)$/i.exec(s)?.[1] ?? s;
  if (ROR_ID.test(ror.toLowerCase())) return { kind: 'ror', ror: ror.toLowerCase() };
  const doi = s.replace(/^(?:https?:\/\/)?(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '');
  if (/^10\.13039\/\S+$/i.test(doi)) return { kind: 'funder_doi', doi: doi.toLowerCase() };
  return;
}

/** European Commission ROR id — the funder behind CORDIS award DOIs (`10.3030/N`). */
export const EUROPEAN_COMMISSION_ROR = '00k4n6c32';

/** How an award reference filters: by full award id, or by grant number alone. */
export type AwardRef = { field: 'id'; value: string } | { field: 'number'; value: string };

/**
 * Parses an award reference: `<funder-ror>::<number>`, a CORDIS award DOI
 * (`10.3030/<n>` → European Commission), or a bare grant number.
 */
export function parseAwardRef(raw: string): AwardRef {
  const s = stripWrapping(raw);
  const id = /^(0[a-z0-9]{6}\d{2})::(.+)$/i.exec(s);
  if (id?.[1] && id[2]) return { field: 'id', value: `${id[1].toLowerCase()}::${id[2]}` };
  const cordis = /^(?:(?:https?:\/\/)?(?:dx\.)?doi\.org\/|doi:\s*)?10\.3030\/(\S+)$/i.exec(s);
  if (cordis?.[1]) return { field: 'id', value: `${EUROPEAN_COMMISSION_ROR}::${cordis[1]}` };
  return { field: 'number', value: s };
}

/**
 * Normalizes an ORCID input: strips an `orcid.org/` URL prefix and uppercases a
 * trailing check character `x`. Validation is separate ({@link isValidOrcid}).
 */
export function normalizeOrcid(raw: string): string {
  return stripWrapping(raw)
    .replace(/^(?:https?:\/\/)?(?:www\.)?orcid\.org\//i, '')
    .replace(/\/+$/, '')
    .replace(/x$/, 'X');
}

/** The `0000-0000-0000-000X` shape of an ORCID iD. */
export const ORCID_PATTERN = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/;

/** True when `orcid` has the {@link ORCID_PATTERN} shape and a valid ISO 7064 mod 11-2 check digit. */
export function isValidOrcid(orcid: string): boolean {
  if (!ORCID_PATTERN.test(orcid)) return false;
  const digits = orcid.replaceAll('-', '');
  let total = 0;
  for (const ch of digits.slice(0, 15)) total = (total + Number(ch)) * 2;
  const result = (12 - (total % 11)) % 11;
  return digits.at(-1) === (result === 10 ? 'X' : String(result));
}

/**
 * Parses a community reference: a slug, a UUID, or a `zenodo.org/communities/<slug>`
 * URL (scheme optional). Returns `undefined` when the value cannot be a
 * community identifier, so it is never interpolated into a request path.
 */
export function parseCommunityRef(raw: string): string | undefined {
  const s = stripWrapping(raw);
  const fromUrl =
    /^(?:https?:\/\/)?(?:www\.)?zenodo\.org\/communities\/([^/?#]+)/i.exec(s)?.[1] ?? s;
  const value = safeDecode(fromUrl).replace(/\/+$/, '');
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(value) ? value : undefined;
}

/** Encodes a file key (or ZIP member path) for a URL path: each `/`-separated segment is percent-encoded. */
export function encodeKeySegments(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

/** The public download URL for a top-level file. */
export function downloadUrl(recid: string, key: string): string {
  return `https://zenodo.org/api/records/${recid}/files/${encodeKeySegments(key)}/content`;
}

/** The public landing page for a record. */
export function recordUrl(recid: string): string {
  return `https://zenodo.org/records/${recid}`;
}
