/**
 * @fileoverview Tests for file-preview rules: the previewable predicate, ZIP
 * detection, fence language hints, and the byte cut (newline boundary, UTF-8
 * boundary, BOM at offset 0, NUL → binary, replacement-character counting).
 * @module tests/services/zenodo/text-preview.test
 */

import { describe, expect, it } from 'vitest';
import {
  cutPreview,
  extensionOf,
  isPreviewable,
  isZip,
  languageHint,
} from '@/services/zenodo/text-preview.js';

const utf8 = (s: string) => new TextEncoder().encode(s);
const bytes = (...parts: (string | number[])[]) =>
  Uint8Array.from(parts.flatMap((p) => (typeof p === 'string' ? [...utf8(p)] : p)));

describe('extensionOf', () => {
  it.each([
    ['data/table.CSV', 'csv'],
    ['CITATION.cff', 'cff'],
    ['archive.tar.gz', 'gz'],
    ['README', ''],
    ['.bashrc', ''],
    ['dir.v1/Makefile', ''],
    ['dir/.hidden', ''],
  ])('%s → %j', (key, ext) => {
    expect(extensionOf(key)).toBe(ext);
  });
});

describe('isPreviewable', () => {
  it.each([
    ['notes.bin', 'text/plain; charset=utf-8'],
    ['x', 'TEXT/CSV'],
    ['x', 'application/json'],
    ['x', 'application/x-ipynb+json'],
    ['x', 'application/geo+json'],
    ['x', 'application/x-yaml'],
    ['CITATION.cff', 'application/octet-stream'],
    ['analysis/model.PY', 'application/octet-stream'],
    ['README.md', undefined],
    ['data.jsonl', ''],
    ['script.do', 'application/octet-stream'],
  ])('%s (%s) is previewable', (key, mime) => {
    expect(isPreviewable(key, mime)).toBe(true);
  });

  it.each([
    ['figure.png', 'image/png'],
    ['archive.zip', 'application/zip'],
    ['paper.pdf', 'application/pdf'],
    ['README', 'application/octet-stream'],
    ['data.parquet', undefined],
  ])('%s (%s) is not previewable', (key, mime) => {
    expect(isPreviewable(key, mime)).toBe(false);
  });
});

describe('isZip', () => {
  it.each([
    ['scikit-learn/scikit-learn-1.9.1.zip', 'application/zip', true],
    ['BUNDLE.ZIP', 'application/octet-stream', true],
    ['bundle', 'application/zip', true],
    ['bundle', 'APPLICATION/ZIP', true],
    ['hxtorch.tar.gz', 'application/gzip', false],
    ['data.7z', undefined, false],
  ])('%s (%s) → %s', (key, mime, expected) => {
    expect(isZip(key, mime)).toBe(expected);
  });
});

describe('languageHint', () => {
  it.each([
    ['README.md', 'markdown'],
    ['CITATION.cff', 'yaml'],
    ['analysis.ipynb', 'json'],
    ['run.sh', 'bash'],
    ['refs.bib', 'bibtex'],
    ['table.csv', 'csv'],
    ['notes.txt', ''],
    ['README', ''],
  ])('%s → %j', (key, hint) => {
    expect(languageHint(key)).toBe(hint);
  });
});

describe('cutPreview', () => {
  it('keeps the whole buffer when nothing remains past it', () => {
    const buf = utf8('id,value\n1,2');
    expect(cutPreview(buf, { atStart: true, moreRemains: false })).toEqual({
      binary: false,
      bytesKept: buf.length,
      replacementChars: 0,
      text: 'id,value\n1,2',
    });
  });

  it('cuts after the last LF when more bytes remain', () => {
    const buf = utf8('line one\nline two\npartial li');
    const cut = cutPreview(buf, { atStart: true, moreRemains: true });
    expect(cut.text).toBe('line one\nline two\n');
    expect(cut.bytesKept).toBe(18);
  });

  it('keeps a CRLF pair together at the cut', () => {
    const cut = cutPreview(utf8('a,b\r\nc,d\r\ne,'), { atStart: true, moreRemains: true });
    expect(cut.text).toBe('a,b\r\nc,d\r\n');
    expect(cut.bytesKept).toBe(10);
  });

  it('cuts at the last complete UTF-8 sequence when there is no newline', () => {
    // "ab€" is 61 62 E2 82 AC; the window ends two bytes into the euro sign.
    const buf = bytes('ab', [0xe2, 0x82]);
    const cut = cutPreview(buf, { atStart: true, moreRemains: true });
    expect(cut).toMatchObject({ text: 'ab', bytesKept: 2, replacementChars: 0 });
  });

  it('cuts before a 4-byte sequence missing its last byte', () => {
    const buf = bytes('x', [0xf0, 0x9f, 0x98]);
    expect(cutPreview(buf, { atStart: true, moreRemains: true })).toMatchObject({
      text: 'x',
      bytesKept: 1,
    });
  });

  it('keeps a buffer that ends on a complete multi-byte sequence', () => {
    const buf = utf8('naïve 😀');
    expect(cutPreview(buf, { atStart: true, moreRemains: true })).toMatchObject({
      text: 'naïve 😀',
      bytesKept: buf.length,
    });
  });

  it('drops a leading BOM from the text at offset 0 but counts its bytes', () => {
    const buf = bytes([0xef, 0xbb, 0xbf], 'id,value\r\n1,2\r\n');
    const cut = cutPreview(buf, { atStart: true, moreRemains: false });
    expect(cut.text).toBe('id,value\r\n1,2\r\n');
    expect(cut.bytesKept).toBe(buf.length);
  });

  it('keeps a BOM that is not at offset 0', () => {
    const cut = cutPreview(bytes([0xef, 0xbb, 0xbf], 'x'), { atStart: false, moreRemains: false });
    expect(cut.text).toBe('\uFEFFx');
  });

  it('marks a buffer holding a NUL byte as binary', () => {
    expect(
      cutPreview(bytes('PK', [0x03, 0x04, 0x00, 0x00]), { atStart: true, moreRemains: true }),
    ).toEqual({
      binary: true,
      bytesKept: 0,
      replacementChars: 0,
      text: '',
    });
  });

  it('counts U+FFFD from a window that starts mid-character', () => {
    // Offset landed on the two continuation bytes of "€".
    const cut = cutPreview(bytes([0x82, 0xac], 'ok'), { atStart: false, moreRemains: false });
    expect(cut.text).toBe('\uFFFD\uFFFDok');
    expect(cut.replacementChars).toBe(2);
  });

  it('returns empty text for an empty buffer', () => {
    expect(cutPreview(new Uint8Array(0), { atStart: true, moreRemains: false })).toEqual({
      binary: false,
      bytesKept: 0,
      replacementChars: 0,
      text: '',
    });
  });
});
