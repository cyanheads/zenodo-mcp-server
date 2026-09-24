/**
 * @fileoverview Tests for the deterministic HTML → plain-text conversion of
 * depositor-supplied descriptions: element dropping, block breaks, list items, link
 * inlining, entity decoding (numeric, the fixed named table, Latin-1), and
 * whitespace normalization.
 * @module tests/services/zenodo/html-to-text.test
 */

import { describe, expect, it } from 'vitest';
import { decodeEntities, htmlToText } from '@/services/zenodo/html-to-text.js';
import type { RawRecord } from '@/services/zenodo/types.js';
import { fixture, recordFixture } from '../../helpers/zenodo-fixtures.js';

describe('htmlToText — structure', () => {
  it('drops script and style elements with their content, and comments', () => {
    expect(
      htmlToText(
        '<p>keep</p><script type="text/javascript">alert("x")</script><style>p{}</style><!-- hidden -->after',
      ),
    ).toBe('keep\nafter');
  });

  it('drops an unterminated script and comment through the end of the input', () => {
    expect(htmlToText('before<script>never closed')).toBe('before');
    expect(htmlToText('before<!-- never closed')).toBe('before');
  });

  it('turns <br> and closing block tags into newlines', () => {
    expect(htmlToText('a<br>b<br/>c<BR />d')).toBe('a\nb\nc\nd');
    expect(htmlToText('<h1>Title</h1><div>one</div><blockquote>two</blockquote>three')).toBe(
      'Title\none\ntwo\nthree',
    );
  });

  it('renders list items with a dash marker', () => {
    expect(htmlToText('<ul><li>alpha</li><li class="x">beta</li></ul>')).toBe('- alpha\n- beta');
  });

  it('renders table rows on separate lines', () => {
    expect(htmlToText('<table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>')).toBe(
      'ab\nc',
    );
  });

  it('strips every remaining tag', () => {
    expect(htmlToText('<span style="x">in<b>line</b></span> <em>text</em>')).toBe('inline text');
  });
});

describe('htmlToText — links', () => {
  it('appends an http(s) href that differs from the link text', () => {
    expect(htmlToText('See <a href="https://example.org/docs">the docs</a>.')).toBe(
      'See the docs (https://example.org/docs).',
    );
  });

  it('does not repeat an href that equals the link text', () => {
    expect(htmlToText('<a href="https://example.org">https://example.org</a>')).toBe(
      'https://example.org',
    );
  });

  it('ignores non-http hrefs', () => {
    expect(htmlToText('<a href="mailto:someone">Contact</a> <a href="/rel">Rel</a>')).toBe(
      'Contact Rel',
    );
  });

  it('accepts single-quoted and bare hrefs and tags inside the link text', () => {
    expect(htmlToText("<a href='https://a.test'><b>A</b></a>")).toBe('A (https://a.test)');
    expect(htmlToText('<a href=https://b.test target=_blank>B</a>')).toBe('B (https://b.test)');
  });

  it('converts every closed link and leaves text after an unclosed one', () => {
    expect(
      htmlToText(
        '<a href="https://a.test">A</a> and <a href="https://b.test">B</a> <a href="https://c.test">C',
      ),
    ).toBe('A (https://a.test) and B (https://b.test) C');
    expect(htmlToText('<a name="x">anchor</a> <a href="https://d.test">D</a>')).toBe(
      'anchor D (https://d.test)',
    );
  });

  it('decodes entities in the href exactly once', () => {
    expect(htmlToText('<a href="https://x.test/?a=1&amp;b=%3C">Q</a>')).toBe(
      'Q (https://x.test/?a=1&b=%3C)',
    );
    expect(htmlToText('<a href="https://x.test/?q=&amp;lt;">Q</a>')).toBe(
      'Q (https://x.test/?q=&lt;)',
    );
  });
});

describe('htmlToText — entities', () => {
  it('decodes numeric decimal and hex references', () => {
    expect(htmlToText('&#65;&#x42;&#X43;&#8364;&#x1F600;')).toBe('ABC€😀');
  });

  it('maps invalid code points to U+FFFD', () => {
    expect(decodeEntities('&#0;|&#xD800;|&#x110000;')).toBe('\uFFFD|\uFFFD|\uFFFD');
  });

  it('decodes the fixed named table case-insensitively, nbsp as a space', () => {
    expect(
      decodeEntities(
        '&amp;&lt;&gt;&quot;&apos;&nbsp;&ndash;&mdash;&hellip;&lsquo;&rsquo;&ldquo;&rdquo;&copy;&reg;&deg;',
      ),
    ).toBe('&<>"\' –—…‘’“”©®°');
    expect(decodeEntities('&AMP;&Lt;&NBSP;')).toBe('&< ');
  });

  it('decodes the Latin-1 named entities, case-sensitively', () => {
    expect(decodeEntities('n&uacute;meros descomposici&oacute;n &Aacute;&aacute; &szlig;')).toBe(
      'números descomposición Áá ß',
    );
    expect(decodeEntities('&AElig;&aelig;&THORN;&thorn;&yuml;&iexcl;&iquest;&times;&divide;')).toBe(
      'ÆæÞþÿ¡¿×÷',
    );
    expect(decodeEntities('&UACUTE;')).toBe('&UACUTE;');
  });

  it('leaves unknown named entities as written', () => {
    expect(decodeEntities('&bogus; &euro; & plain')).toBe('&bogus; &euro; & plain');
  });

  it('never decodes twice (a literal &lt; in text stays literal)', () => {
    expect(htmlToText('&amp;lt;script&amp;gt;')).toBe('&lt;script&gt;');
    expect(htmlToText('&lt;b&gt;not a tag&lt;/b&gt;')).toBe('<b>not a tag</b>');
  });
});

describe('htmlToText — whitespace', () => {
  it('normalizes CRLF and CR, trims trailing spaces, collapses 3+ newlines, and trims', () => {
    expect(htmlToText('  a  \r\nb\t\rc\n\n\n\n\nd  ')).toBe('a\nb\nc\n\nd');
  });

  it('returns an empty string for markup with no text', () => {
    expect(htmlToText('<p></p><br><script>x</script>')).toBe('');
  });

  it('keeps a < with no > after it as text, and strips a < through the next >', () => {
    expect(htmlToText('a < b and c')).toBe('a < b and c');
    expect(htmlToText('a < b and <i>c</i>')).toBe('a c');
  });
});

describe('htmlToText — adversarial descriptions stay linear', () => {
  const N = 200_000;
  it.each([
    ['a run of <', '<'.repeat(N)],
    ['unclosed <a tags', '<a '.repeat(N / 3)],
    ['linked <a> tags with no </a>', '<a href=https://x.test>'.repeat(N / 22)],
    ['an href with no closing quote', `<a href="${'a'.repeat(N)}`],
    ['a </a with no >', `<a href=https://x.test>t</a${' '.repeat(N)}`],
    ['unclosed <li tags', '<li'.repeat(N / 3)],
    ['unclosed <script tags', '<script'.repeat(N / 7)],
    ['a long run of spaces before text', `a${' '.repeat(N)}x`],
    ['a long run of spaces inside a tag name', `</p${' '.repeat(N)}x`],
  ])('%s', (_label, html) => {
    const started = performance.now();
    htmlToText(html);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe('htmlToText — real Zenodo descriptions', () => {
  it('converts record 22705923 (paragraphs and <pre><code> blocks)', () => {
    const html = recordFixture().metadata?.description ?? '';
    expect(htmlToText(html)).toBe(
      [
        "We're happy to announce the 1.9.1 release.",
        '',
        'This release contains a few bug fixes and is the first version supporting Python 3.15.',
        '',
        'You can see the changelog here: https://scikit-learn.org/stable/whats_new/v1.9.html#version-1-9-1',
        '',
        'You can upgrade with pip as usual:',
        '',
        'pip install -U scikit-learn',
        '',
        'The conda-forge builds can be installed using:',
        '',
        'conda install -c conda-forge scikit-learn',
        '',
        'Thanks to everyone who contributed to this release !',
      ].join('\n'),
    );
  });

  it('decodes the Latin-1 entities of record 22931068 (a Spanish description)', () => {
    const html = fixture<RawRecord>('record-22931068-restricted.json').metadata?.description ?? '';
    const text = htmlToText(html);
    expect(text).toContain('descomposición exacta del conteo de los\nnúmeros primos');
    expect(text).toContain('—una componente de densidad');
    expect(text).toContain('autoría');
    expect(text).not.toMatch(/&[a-z]+;/i);
  });
});
