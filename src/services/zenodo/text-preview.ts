/**
 * @fileoverview Text-preview rules for file reads: which files are previewable,
 * the fence language hint, and the byte cut that keeps continuation windows on
 * line or character boundaries.
 * @module services/zenodo/text-preview
 */

const PREVIEWABLE_MIMETYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/geo+json',
  'application/xml',
  'application/x-yaml',
  'application/yaml',
  'application/x-ipynb+json',
  'application/x-tex',
  'application/x-sh',
  'application/javascript',
]);

const PREVIEWABLE_EXTENSIONS = new Set(
  'md markdown txt text csv tsv tab json jsonl ndjson geojson yaml yml xml cff bib ris rst tex py r rmd ipynb jl m sh sql toml ini cfg conf log html htm js ts c h cpp java go rs do sas'.split(
    ' ',
  ),
);

/** Lowercased extension of the last path segment, without the dot; `''` when none. */
export function extensionOf(key: string): string {
  const name = key.slice(key.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * True when a file is worth previewing as text: a `text/*` mimetype, one of the
 * listed structured-text mimetypes, or a known text extension (CITATION.cff
 * arrives as `application/octet-stream`, so the extension list is needed).
 */
export function isPreviewable(key: string, mimetype: string | undefined): boolean {
  const mime = (mimetype ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return (
    mime.startsWith('text/') ||
    PREVIEWABLE_MIMETYPES.has(mime) ||
    PREVIEWABLE_EXTENSIONS.has(extensionOf(key))
  );
}

/** True when the key names a ZIP archive by extension or mimetype. */
export function isZip(key: string, mimetype: string | undefined): boolean {
  return extensionOf(key) === 'zip' || (mimetype ?? '').toLowerCase() === 'application/zip';
}

const LANGUAGE_HINTS: Record<string, string> = {
  md: 'markdown',
  markdown: 'markdown',
  json: 'json',
  jsonl: 'json',
  ndjson: 'json',
  geojson: 'json',
  ipynb: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  cff: 'yaml',
  xml: 'xml',
  html: 'html',
  htm: 'html',
  csv: 'csv',
  tsv: 'tsv',
  py: 'python',
  r: 'r',
  rmd: 'markdown',
  jl: 'julia',
  sh: 'bash',
  sql: 'sql',
  toml: 'toml',
  ini: 'ini',
  js: 'javascript',
  ts: 'typescript',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  java: 'java',
  go: 'go',
  rs: 'rust',
  tex: 'latex',
  bib: 'bibtex',
  rst: 'rst',
};

/** Code-fence language hint for a file key; `''` when none applies. */
export function languageHint(key: string): string {
  return LANGUAGE_HINTS[extensionOf(key)] ?? '';
}

/** Result of cutting a byte window into previewable text. */
export interface PreviewCut {
  /** True when the buffer holds a NUL byte — the file is binary, not text. */
  binary: boolean;
  /** Exact number of bytes kept (BOM included when one was dropped from the text). */
  bytesKept: number;
  /** Count of U+FFFD characters in the decoded text. */
  replacementChars: number;
  text: string;
}

/** Index just past the last complete UTF-8 sequence in `bytes`. */
function lastCompleteUtf8Boundary(bytes: Uint8Array): number {
  const end = bytes.length;
  // Walk back over at most 3 continuation bytes to the lead byte.
  for (let i = end - 1; i >= 0 && i >= end - 4; i--) {
    const b = bytes[i] as number;
    if ((b & 0xc0) === 0x80) continue;
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    return i + need <= end ? end : i;
  }
  return end;
}

/**
 * Cuts a window of bytes for display. When more bytes remain past the window, the
 * cut lands after the last `\n`, or — with no newline — after the last complete
 * UTF-8 sequence. A NUL byte marks the buffer binary. A leading UTF-8 BOM is
 * dropped from the text when the window starts at offset 0.
 */
export function cutPreview(
  bytes: Uint8Array,
  options: { atStart: boolean; moreRemains: boolean },
): PreviewCut {
  if (bytes.includes(0)) return { binary: true, bytesKept: 0, replacementChars: 0, text: '' };

  let keep = bytes.length;
  if (options.moreRemains) {
    const newline = bytes.lastIndexOf(0x0a);
    keep = newline >= 0 ? newline + 1 : lastCompleteUtf8Boundary(bytes);
  }
  const kept = bytes.subarray(0, keep);
  let text = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(kept);
  if (options.atStart && text.startsWith('\uFEFF')) text = text.slice(1);
  const replacementChars = text.match(/\uFFFD/g)?.length ?? 0;
  return { binary: false, bytesKept: keep, replacementChars, text };
}
