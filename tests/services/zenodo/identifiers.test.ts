/**
 * @fileoverview Tests for the pure identifier parsers: every record-reference form
 * the design accepts or rejects, funder/award/ORCID/community parsing, and file-key
 * URL encoding.
 * @module tests/services/zenodo/identifiers.test
 */

import { describe, expect, it } from 'vitest';
import {
  downloadUrl,
  EUROPEAN_COMMISSION_ROR,
  encodeKeySegments,
  isValidOrcid,
  isWholeIdentifier,
  normalizeOrcid,
  parseAwardRef,
  parseCommunityRef,
  parseFunderRef,
  parseRecordRef,
  recordUrl,
} from '@/services/zenodo/identifiers.js';

describe('parseRecordRef — accepted forms', () => {
  it.each([
    ['22705923', '22705923', 'record_id'],
    ['  22705923  ', '22705923', 'record_id'],
    ['22705923.', '22705923', 'record_id'],
    ['22705923;', '22705923', 'record_id'],
    ['zenodo.22705923', '22705923', 'zenodo_doi'],
    ['ZENODO.22705923', '22705923', 'zenodo_doi'],
    ['10.5281/zenodo.22705923', '22705923', 'zenodo_doi'],
    ['10.5281/ZENODO.22705923', '22705923', 'zenodo_doi'],
    ['doi:10.5281/zenodo.22705923', '22705923', 'zenodo_doi'],
    ['DOI: 10.5281/zenodo.22705923', '22705923', 'zenodo_doi'],
    ['10.5281/zenodo.22705923,', '22705923', 'zenodo_doi'],
    ['<10.5281/zenodo.1>', '1', 'zenodo_doi'],
    ['"10.5281/zenodo.591564"', '591564', 'zenodo_doi'],
    ["'10.5281/zenodo.591564'", '591564', 'zenodo_doi'],
    ['“10.5281/zenodo.591564”', '591564', 'zenodo_doi'],
    ['<"22705923">', '22705923', 'record_id'],
  ] as const)('%j → recid %s (%s)', (raw, recid, inputKind) => {
    expect(parseRecordRef(raw)).toEqual({ kind: 'recid', recid, inputKind });
  });

  it.each([
    ['https://doi.org/10.5281/zenodo.591564', '591564'],
    ['http://dx.doi.org/10.5281/zenodo.591564', '591564'],
    ['https://www.doi.org/10.5281/ZENODO.591564', '591564'],
    ['doi.org/10.5281/zenodo.591564', '591564'],
    ['https://zenodo.org/records/22705923', '22705923'],
    ['https://zenodo.org/record/22705923', '22705923'],
    ['https://www.zenodo.org/records/22705923', '22705923'],
    ['zenodo.org/records/22705923', '22705923'],
    ['https://zenodo.org/records/22705923?preview=1#files', '22705923'],
    ['https://zenodo.org/records/22705923/', '22705923'],
    ['https://zenodo.org/records/22705923.', '22705923'],
    [
      'https://zenodo.org/records/22705923/files/scikit-learn/scikit-learn-1.9.1.zip?download=1',
      '22705923',
    ],
    ['https://zenodo.org/api/records/22705923', '22705923'],
    ['https://zenodo.org/api/records/22705923/versions/latest', '22705923'],
    ['https://zenodo.org/doi/10.5281/zenodo.591564', '591564'],
    ['https://zenodo.org/badge/DOI/10.5281/zenodo.591564.svg', '591564'],
    ['<https://zenodo.org/records/1>', '1'],
  ])('URL %s → recid %s', (raw, recid) => {
    expect(parseRecordRef(raw)).toEqual({ kind: 'recid', recid, inputKind: 'url' });
  });

  it('classifies another DOI as external, keeping the as-given form', () => {
    expect(parseRecordRef('10.3897/ap.e134190')).toEqual({
      kind: 'external_doi',
      doi: '10.3897/ap.e134190',
      inputKind: 'external_doi',
    });
    expect(parseRecordRef('doi:10.3897/AP.E134190')).toEqual({
      kind: 'external_doi',
      doi: '10.3897/AP.E134190',
      inputKind: 'external_doi',
    });
  });

  it('offers a stripped form for an external DOI with trailing punctuation', () => {
    expect(parseRecordRef('10.3897/ap.e134190.')).toEqual({
      kind: 'external_doi',
      doi: '10.3897/ap.e134190.',
      strippedDoi: '10.3897/ap.e134190',
      inputKind: 'external_doi',
    });
  });

  it('classifies an external DOI URL with input kind url', () => {
    expect(parseRecordRef('https://doi.org/10.3897/ap.e134190')).toEqual({
      kind: 'external_doi',
      doi: '10.3897/ap.e134190',
      inputKind: 'url',
    });
  });

  it('decodes a percent-encoded DOI path', () => {
    expect(parseRecordRef('https://doi.org/10.5281%2Fzenodo.591564')).toEqual({
      kind: 'recid',
      recid: '591564',
      inputKind: 'url',
    });
  });
});

describe('parseRecordRef — rejected forms', () => {
  it.each([
    ['https://zenodo.org/badge/latestdoi/12345678', /GitHub repository id/],
    ['https://sandbox.zenodo.org/records/1', /different Zenodo instance/],
    ['sandbox.zenodo.org/records/1', /different Zenodo instance/],
    ['https://example.org/records/22705923', /not zenodo\.org or doi\.org/],
    ['https://zenodo.org/communities/symbaproject', /does not name a record/],
    ['https://zenodo.org/search?q=climate', /does not name a record/],
    ['https://doi.org/not-a-doi', /not a well-formed DOI/],
    ['https://', /not a valid URL/],
    ['10.12/too-short-registrant', /not a well-formed DOI/],
    ['climate model', /not a Zenodo record id, DOI/],
    ['doi:22705923', /not a Zenodo record id, DOI/],
    ['', /empty/],
    ['   ', /empty/],
    ['<>', /empty/],
  ])('%j is invalid', (raw, message) => {
    const ref = parseRecordRef(raw);
    expect(ref.kind).toBe('invalid');
    expect(ref.kind === 'invalid' && ref.message).toMatch(message);
  });

  it('caps the echoed input in the failure message', () => {
    const ref = parseRecordRef(`not-an-id-${'x'.repeat(300)}`);
    expect(ref.kind === 'invalid' && ref.message.length).toBeLessThan(200);
  });
});

describe('isWholeIdentifier', () => {
  it.each([
    ['10.5281/zenodo.591564', true],
    ['  10.5281/zenodo.591564  ', true],
    ['https://doi.org/10.5281/zenodo.591564', true],
    ['https://zenodo.org/records/22705923', true],
    ['10.3897/ap.e134190', true],
    ['22705923', false],
    ['zenodo.22705923', false],
    ['doi:"10.5281/zenodo.591564"', false],
    ['doi:10.5281/zenodo.591564', false],
    ['metadata.title:"climate"', false],
    ['climate 10.5281/zenodo.591564', false],
    ['climate model', false],
  ])('%j → %s', (query, expected) => {
    expect(isWholeIdentifier(query)).toBe(expected);
  });
});

describe('parseFunderRef', () => {
  it.each([
    ['01cwqze88', { kind: 'ror', ror: '01cwqze88' }],
    ['01CWQZE88', { kind: 'ror', ror: '01cwqze88' }],
    ['https://ror.org/01cwqze88', { kind: 'ror', ror: '01cwqze88' }],
    ['ror.org/01cwqze88/', { kind: 'ror', ror: '01cwqze88' }],
    ['10.13039/100000002', { kind: 'funder_doi', doi: '10.13039/100000002' }],
    ['doi:10.13039/100000002', { kind: 'funder_doi', doi: '10.13039/100000002' }],
    ['https://doi.org/10.13039/100000002', { kind: 'funder_doi', doi: '10.13039/100000002' }],
    [
      'https://dx.doi.org/10.13039/501100000780',
      { kind: 'funder_doi', doi: '10.13039/501100000780' },
    ],
  ] as const)('%j → %j', (raw, expected) => {
    expect(parseFunderRef(raw)).toEqual(expected);
  });

  it.each([
    'national institutes of health',
    'NIH',
    '1cwqze88',
    'zzzzzzzzz',
    '10.3030/101135562',
    '',
  ])('rejects %j (names are never matched)', (raw) => {
    expect(parseFunderRef(raw)).toBeUndefined();
  });
});

describe('parseAwardRef', () => {
  it('keeps a <ror>::<number> award id, lowercasing the ROR part', () => {
    expect(parseAwardRef('00k4n6c32::101135562')).toEqual({
      field: 'id',
      value: '00k4n6c32::101135562',
    });
    expect(parseAwardRef('00K4N6C32::101135562')).toEqual({
      field: 'id',
      value: '00k4n6c32::101135562',
    });
  });

  it.each(['10.3030/101135562', 'doi:10.3030/101135562', 'https://doi.org/10.3030/101135562'])(
    'maps the CORDIS DOI %j to the European Commission award id',
    (raw) => {
      expect(parseAwardRef(raw)).toEqual({
        field: 'id',
        value: `${EUROPEAN_COMMISSION_ROR}::101135562`,
      });
    },
  );

  it('treats anything else as a bare grant number', () => {
    expect(parseAwardRef(' 101135562 ')).toEqual({ field: 'number', value: '101135562' });
    expect(parseAwardRef('R01-GM123456')).toEqual({ field: 'number', value: 'R01-GM123456' });
  });
});

describe('ORCID normalization and checksum', () => {
  it.each([
    ['https://orcid.org/0000-0002-1825-0097', '0000-0002-1825-0097'],
    ['orcid.org/0000-0002-1825-0097/', '0000-0002-1825-0097'],
    ['0000-0002-1694-233x', '0000-0002-1694-233X'],
    [' 0000-0002-1694-233X ', '0000-0002-1694-233X'],
  ])('normalizes %j → %s', (raw, expected) => {
    expect(normalizeOrcid(raw)).toBe(expected);
  });

  it.each(['0000-0002-1825-0097', '0000-0001-5109-3700', '0000-0002-1694-233X'])(
    'accepts the valid ORCID %s (ISO 7064 mod 11-2)',
    (orcid) => {
      expect(isValidOrcid(orcid)).toBe(true);
    },
  );

  it.each([
    ['0000-0002-1825-0098', 'wrong check digit'],
    ['0000-0002-1694-2330', 'X expected, 0 given'],
    ['0000-0002-1694-233x', 'lowercase check character (normalize first)'],
    ['0000000218250097', 'no hyphens'],
    ['0000-0002-1825-009', 'too short'],
    ['https://orcid.org/0000-0002-1825-0097', 'URL form (normalize first)'],
  ])('rejects %s (%s)', (orcid) => {
    expect(isValidOrcid(orcid)).toBe(false);
  });
});

describe('parseCommunityRef', () => {
  it.each([
    ['symbaproject', 'symbaproject'],
    ['SYMBAPROJECT', 'SYMBAPROJECT'],
    ['9649d306-cf94-49cc-a14d-934ca8fcb515', '9649d306-cf94-49cc-a14d-934ca8fcb515'],
    ['https://zenodo.org/communities/sochias', 'sochias'],
    ['zenodo.org/communities/sochias/records?q=x', 'sochias'],
    ['https://zenodo.org/communities/sochias/', 'sochias'],
  ])('%j → %s', (raw, expected) => {
    expect(parseCommunityRef(raw)).toBe(expected);
  });

  it.each(['../records', 'a b', 'foo/bar', '-leading-dash', '', 'x'.repeat(201)])(
    'rejects %j so it never reaches a request path',
    (raw) => {
      expect(parseCommunityRef(raw)).toBeUndefined();
    },
  );
});

describe('file-key encoding', () => {
  it('percent-encodes each /-separated segment and keeps the slashes', () => {
    expect(encodeKeySegments('scikit-learn/scikit-learn-1.9.1.zip')).toBe(
      'scikit-learn/scikit-learn-1.9.1.zip',
    );
    expect(encodeKeySegments('D6.1 (versione sottomessa).pdf')).toBe(
      'D6.1%20(versione%20sottomessa).pdf',
    );
    expect(encodeKeySegments('data/a#b?c%.csv')).toBe('data/a%23b%3Fc%25.csv');
  });

  it('builds download and landing URLs', () => {
    expect(downloadUrl('22705923', 'scikit-learn/scikit-learn-1.9.1.zip')).toBe(
      'https://zenodo.org/api/records/22705923/files/scikit-learn/scikit-learn-1.9.1.zip/content',
    );
    expect(downloadUrl('1', 'a b.txt')).toBe(
      'https://zenodo.org/api/records/1/files/a%20b.txt/content',
    );
    expect(recordUrl('22705923')).toBe('https://zenodo.org/records/22705923');
  });
});
