/**
 * @fileoverview Tests for the deterministic HTML → plain-text conversion of
 * depositor-supplied descriptions: element dropping, block breaks, `<br>` line
 * breaks, list items, table rows, link inlining, entity decoding (numeric and the
 * HTML 4 named set), whitespace normalization, and linear CPU-time growth.
 * @module tests/services/zenodo/html-to-text.test
 */

import { describe, expect, it } from 'vitest';
import { decodeEntities, htmlToText, NAMED_ENTITIES } from '@/services/zenodo/html-to-text.js';
import type { RawRecord } from '@/services/zenodo/types.js';
import { fixture, recordFixture } from '../../helpers/zenodo-fixtures.js';

/** Raw `metadata.description` of records 8696, 12666132, and 6515070. */
const descriptions = () =>
  fixture<Record<'8696' | '12666132' | '6515070', string>>(
    'descriptions-8696-12666132-6515070.json',
  );

/**
 * `name:code` pairs of the HTML 4.01 named character references as Python's
 * `html.entities.name2codepoint` lists them (252 names, sorted): an expectation
 * taken from outside the table under test.
 */
const PYTHON_HTML4_NAME2CODEPOINT =
  'AElig:198 Aacute:193 Acirc:194 Agrave:192 Alpha:913 Aring:197 Atilde:195 Auml:196 Beta:914 Ccedil:199 Chi:935 Dagger:8225 Delta:916 ETH:208 Eacute:201 Ecirc:202 Egrave:200 Epsilon:917 Eta:919 Euml:203 Gamma:915 Iacute:205 Icirc:206 Igrave:204 Iota:921 Iuml:207 Kappa:922 Lambda:923 Mu:924 Ntilde:209 Nu:925 OElig:338 Oacute:211 Ocirc:212 Ograve:210 Omega:937 Omicron:927 Oslash:216 Otilde:213 Ouml:214 Phi:934 Pi:928 Prime:8243 Psi:936 Rho:929 Scaron:352 Sigma:931 THORN:222 Tau:932 Theta:920 Uacute:218 Ucirc:219 Ugrave:217 Upsilon:933 Uuml:220 Xi:926 Yacute:221 Yuml:376 Zeta:918 aacute:225 acirc:226 acute:180 aelig:230 agrave:224 alefsym:8501 alpha:945 amp:38 and:8743 ang:8736 aring:229 asymp:8776 atilde:227 auml:228 bdquo:8222 beta:946 brvbar:166 bull:8226 cap:8745 ccedil:231 cedil:184 cent:162 chi:967 circ:710 clubs:9827 cong:8773 copy:169 crarr:8629 cup:8746 curren:164 dArr:8659 dagger:8224 darr:8595 deg:176 delta:948 diams:9830 divide:247 eacute:233 ecirc:234 egrave:232 empty:8709 emsp:8195 ensp:8194 epsilon:949 equiv:8801 eta:951 eth:240 euml:235 euro:8364 exist:8707 fnof:402 forall:8704 frac12:189 frac14:188 frac34:190 frasl:8260 gamma:947 ge:8805 gt:62 hArr:8660 harr:8596 hearts:9829 hellip:8230 iacute:237 icirc:238 iexcl:161 igrave:236 image:8465 infin:8734 int:8747 iota:953 iquest:191 isin:8712 iuml:239 kappa:954 lArr:8656 lambda:955 lang:9001 laquo:171 larr:8592 lceil:8968 ldquo:8220 le:8804 lfloor:8970 lowast:8727 loz:9674 lrm:8206 lsaquo:8249 lsquo:8216 lt:60 macr:175 mdash:8212 micro:181 middot:183 minus:8722 mu:956 nabla:8711 nbsp:160 ndash:8211 ne:8800 ni:8715 not:172 notin:8713 nsub:8836 ntilde:241 nu:957 oacute:243 ocirc:244 oelig:339 ograve:242 oline:8254 omega:969 omicron:959 oplus:8853 or:8744 ordf:170 ordm:186 oslash:248 otilde:245 otimes:8855 ouml:246 para:182 part:8706 permil:8240 perp:8869 phi:966 pi:960 piv:982 plusmn:177 pound:163 prime:8242 prod:8719 prop:8733 psi:968 quot:34 rArr:8658 radic:8730 rang:9002 raquo:187 rarr:8594 rceil:8969 rdquo:8221 real:8476 reg:174 rfloor:8971 rho:961 rlm:8207 rsaquo:8250 rsquo:8217 sbquo:8218 scaron:353 sdot:8901 sect:167 shy:173 sigma:963 sigmaf:962 sim:8764 spades:9824 sub:8834 sube:8838 sum:8721 sup:8835 sup1:185 sup2:178 sup3:179 supe:8839 szlig:223 tau:964 there4:8756 theta:952 thetasym:977 thinsp:8201 thorn:254 tilde:732 times:215 trade:8482 uArr:8657 uacute:250 uarr:8593 ucirc:251 ugrave:249 uml:168 upsih:978 upsilon:965 uuml:252 weierp:8472 xi:958 yacute:253 yen:165 yuml:255 zeta:950 zwj:8205 zwnj:8204';

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

  it('renders each table row on one line, cells joined by " | "', () => {
    expect(htmlToText('<table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>')).toBe(
      'a | b\nc',
    );
  });

  it('strips every remaining tag', () => {
    expect(htmlToText('<span style="x">in<b>line</b></span> <em>text</em>')).toBe('inline text');
  });
});

describe('htmlToText — a newline after <br>', () => {
  it('is part of that break, not a second one', () => {
    expect(htmlToText('Line one<br />\nLine two<br>\nLine three')).toBe(
      'Line one\nLine two\nLine three',
    );
  });

  it('absorbs CRLF, CR, and the spaces and tabs around the newline, for every <br> form', () => {
    expect(htmlToText('a<br>\r\nb<br/>  \nc<BR />\t \r\nd<br>\re<br>\n\t f')).toBe(
      'a\nb\nc\nd\ne\nf',
    );
  });

  it('keeps a blank line for two <br> in a row', () => {
    expect(htmlToText('a<br><br>\nb')).toBe('a\n\nb');
    expect(htmlToText('a<br>\n<br>\nb')).toBe('a\n\nb');
  });

  it('leaves spaces after <br> that no newline follows, and newlines not right after <br>', () => {
    expect(htmlToText('a<br>  b')).toBe('a\n  b');
    expect(htmlToText('a<br>b\nc')).toBe('a\nb\nc');
  });

  it('changes no other whitespace (paragraph spacing, indented list items)', () => {
    expect(htmlToText('<p>one</p>\n  two\n\n\n\nthree')).toBe('one\n\n  two\n\nthree');
    expect(htmlToText('<ul>\n  <li>a</li>\n  <li>b</li>\n</ul>')).toBe('- a\n\n  - b');
  });
});

describe('htmlToText — tables', () => {
  it('joins header and data cells, and keeps text after the table as before', () => {
    expect(
      htmlToText(
        '<table><tr><th>Station</th><th>Flow</th></tr><tr><td>A</td><td>12</td></tr></table>\n<p>&alpha; &beta; &le; &ge; &rarr; &euro;</p>',
      ),
    ).toBe('Station | Flow\nA | 12\n\nα β ≤ ≥ → €');
  });

  it('drops the indentation and line breaks of a pretty-printed table', () => {
    expect(
      htmlToText(
        '<table>\n\t<tbody>\n\t\t<tr>\n\t\t\t<td>x</td>\n\t\t\t<td>y</td>\n\t\t</tr>\n\t\t<tr>\n\t\t\t<td>1</td>\n\t\t\t<td>2</td>\n\t\t</tr>\n\t</tbody>\n</table>',
      ),
    ).toBe('x | y\n1 | 2');
  });

  it('collapses whitespace and block breaks inside a cell to single spaces', () => {
    expect(
      htmlToText(
        '<table><tr><td><p>one</p>\n<p>two<br>three</p></td><td>  x\t\n y  </td><td><ul><li>a</li><li>b</li></ul></td></tr></table>',
      ),
    ).toBe('one two three | x y | - a - b');
    expect(htmlToText('<table><tr><td>a&#10;b&#x85;c&#x2028;d</td><td>e</td></tr></table>')).toBe(
      'a b c d | e',
    );
  });

  it('keeps empty cells as empty slots and drops rows with no text', () => {
    expect(
      htmlToText(
        '<table><tr><td>a</td><td></td><td>c</td><td> </td></tr><tr><td></td><td>&nbsp;</td></tr><tr><td>d</td></tr></table>',
      ),
    ).toBe('a |  | c |\nd');
  });

  it('closes cells and rows a new cell, row, or the table end implies, in any tag case', () => {
    expect(htmlToText('<TABLE><TR><TD>a<TD>b<TR><TH>c</TABLE>')).toBe('a | b\nc');
    expect(htmlToText('<p>x</p><table><tr><td>a</td><td>b')).toBe('x\na | b');
  });

  it('inlines links and decodes entities inside cells exactly once', () => {
    expect(
      htmlToText(
        '<table><tr><td><a href="https://x.test/?a=1&amp;b=2">X</a></td><td>25 &mu;M &amp;lt;b&amp;gt; &lt;id&gt;</td></tr></table>',
      ),
    ).toBe('X (https://x.test/?a=1&b=2) | 25 μM &lt;b&gt; <id>');
  });

  it('starts a table on its own line and keeps the text around it', () => {
    expect(htmlToText('before<table><tr><td>a</td><td>b</td></tr></table>after')).toBe(
      'before\na | b\n\nafter',
    );
    expect(htmlToText('<p>before</p><table><tr><td>a</td></tr></table><p>after</p>')).toBe(
      'before\na\n\nafter',
    );
  });

  it('puts text inside a table but outside its cells on its own line', () => {
    expect(
      htmlToText(
        '<table><caption>Results</caption><tr><td>a</td></tr>loose<tr><td>b</td></tr></table>',
      ),
    ).toBe('Results\na\nloose\nb');
  });

  it('folds a nested table into the cell that holds it', () => {
    expect(
      htmlToText(
        '<table><tr><td>outer<table><tr><td>i1</td><td>i2</td></tr></table>rest</td><td>z</td></tr></table>',
      ),
    ).toBe('outer i1 i2 rest | z');
    expect(
      htmlToText(
        '<table><tr><td>outer<table><tr><td>i1</td></tr><tr><td>i2</td></tr></table>rest</td><td>z</td></tr></table>',
      ),
    ).toBe('outer i1 i2 rest | z');
  });

  it('converts row and cell tags outside any table as before', () => {
    expect(htmlToText('a</td><td>b</tr>c</table>d')).toBe('ab\nc\nd');
  });
});

describe('htmlToText — one-cell rows render as blocks', () => {
  const oneCell = (html: string) => `<table><tr><td>${html}</td></tr></table>`;

  it('keeps the paragraph and <br> breaks of a layout table', () => {
    expect(htmlToText(oneCell('<p>a</p><p>b</p>'))).toBe('a\nb');
    expect(htmlToText(oneCell('a<br>b<br><br>c'))).toBe('a\nb\n\nc');
    expect(htmlToText(oneCell('a<br />\r\nb'))).toBe('a\nb');
  });

  it('converts the cell as the same HTML outside a table converts', () => {
    for (const html of [
      '<p>one</p>\n<p>two<br>three</p><ul><li>x</li><li>y</li></ul>',
      'See <a href="https://x.test/">the docs</a>.<br>25 &mu;M &amp;lt;b&amp;gt; &lt;id&gt;',
      '<h2>Title</h2><div>body</div>',
    ]) {
      expect(htmlToText(oneCell(html))).toBe(htmlToText(html));
    }
  });

  it('drops the indentation and edge blank lines of a pretty-printed layout table', () => {
    const text = htmlToText(
      '<table>\n\t<tbody>\n\t\t<tr>\n\t\t\t<td>\n\t\t\t<p>First paragraph,\n\t\t\twrapped.</p>\n\n\t\t\t<p>Second \t paragraph.</p>\n\t\t\t</td>\n\t\t</tr>\n\t</tbody>\n</table>\n<p>after</p>',
    );
    expect(text).toBe('First paragraph,\nwrapped.\n\nSecond paragraph.\n\nafter');
    expect(text).not.toMatch(/^[ \t]/m);
  });

  it('keeps a one-cell row on its own lines among multi-cell rows', () => {
    expect(
      htmlToText(
        '<table><tr><td colspan="2">Table 1<br>Flow by station</td></tr><tr><th>Station</th><th>Flow</th></tr><tr><td>A</td><td>12</td></tr><tr><td>Source: <i>survey</i></td></tr></table>',
      ),
    ).toBe('Table 1\nFlow by station\nStation | Flow\nA | 12\nSource: survey');
  });

  it('applies to each one-cell row, implied row and cell ends included', () => {
    expect(htmlToText('<table><tr><td>a<br>b<tr><td><p>c</p>d</table>')).toBe('a\nb\nc\nd');
    expect(htmlToText('<table><td>x<br>y</table>')).toBe('x\ny');
  });

  it('drops a one-cell row with no text and keeps empty lines out of the edges', () => {
    expect(htmlToText(oneCell('<p>&nbsp;</p><br>\n\t'))).toBe('');
    expect(htmlToText(`<p>x</p>${oneCell('<br><br>a<br><br>')}<p>y</p>`)).toBe('x\na\n\ny');
  });

  it('renders a nested table one row per line, its cells joined by spaces', () => {
    expect(
      htmlToText(
        oneCell(
          '<p>intro</p><table><tr><td>x</td><td>y</td></tr><tr><td>1</td><td>2</td></tr></table><p>outro</p>',
        ),
      ),
    ).toBe('intro\nx y\n1 2\n\noutro');
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

  it('leaves names outside the HTML 4 set as written', () => {
    expect(decodeEntities('&bogus; &euro; &caron; & plain')).toBe('&bogus; € &caron; & plain');
  });

  it('decodes the HTML 4 Greek, math, arrow, and punctuation names', () => {
    expect(htmlToText('<p>&alpha; &beta; &le; &ge; &rarr; &euro;</p>')).toBe('α β ≤ ≥ → €');
    expect(decodeEntities('&Dagger;&dagger;&Xi;&xi;&scaron;')).toBe('‡†Ξξš');
    expect(decodeEntities('[&minus;0.247] 25 &mu;M &bdquo;x&ldquo; &trade; &infin;')).toBe(
      '[−0.247] 25 μM „x“ ™ ∞',
    );
  });

  it('holds the 252 HTML 4.01 names plus apos, each decoding to the code point Python lists (nbsp to a space)', () => {
    const html4 = PYTHON_HTML4_NAME2CODEPOINT.split(' ').map((pair) => pair.split(':'));
    expect(html4).toHaveLength(252);
    expect(NAMED_ENTITIES.size).toBe(253);
    expect([...NAMED_ENTITIES.keys()].sort()).toEqual(
      [...html4.map(([name]) => name), 'apos'].sort(),
    );
    for (const [name = '', code] of html4) {
      expect(decodeEntities(`&${name};`), name).toBe(
        name === 'nbsp' ? ' ' : String.fromCodePoint(Number(code)),
      );
    }
    expect(decodeEntities('&apos;')).toBe("'");
  });

  it('matches HTML 4 names by exact case', () => {
    expect(decodeEntities('&Alpha;&ALPHA;&Scaron;&SCARON;&Euro;&rArr;&RARR;')).toBe(
      'Α&ALPHA;Š&SCARON;&Euro;⇒&RARR;',
    );
  });

  it('leaves names the table never declared as written', () => {
    const undeclared = '&constructor; &toString; &valueOf; &hasOwnProperty; &__proto__;';
    expect(decodeEntities(undeclared)).toBe(undeclared);
    expect(htmlToText(`<p>${undeclared}</p>`)).toBe(undeclared);
  });

  it('never decodes twice (a literal &lt; in text stays literal)', () => {
    expect(htmlToText('&amp;lt;script&amp;gt;')).toBe('&lt;script&gt;');
    expect(htmlToText('&lt;b&gt;not a tag&lt;/b&gt;')).toBe('<b>not a tag</b>');
    expect(htmlToText('&amp;lt; &lt;sample_id&gt; &amp;alpha; &amp;amp;')).toBe(
      '&lt; <sample_id> &alpha; &amp;',
    );
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

/**
 * Fastest per-call CPU time (ms) of `run` over several samples, each repeated until it
 * has used about 20 ms of this thread's CPU. A first call already over `ceiling`
 * returns its time at once.
 */
function cpuMs(run: () => void, ceiling: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (let sample = 0; sample < 3; sample++) {
    const start = process.threadCpuUsage();
    let calls = 0;
    let used = 0;
    do {
      run();
      calls++;
      const { user, system } = process.threadCpuUsage(start);
      used = (user + system) / 1_000;
      if (calls === 1 && used > ceiling) return used;
    } while (used < 20);
    best = Math.min(best, used / calls);
  }
  return best;
}

describe('htmlToText — CPU time grows linearly with the input', () => {
  const CEILING_MS = 250;
  const fill = (unit: string, n: number) => unit.repeat(Math.ceil(n / unit.length));

  it.each<[string, (n: number) => string, number]>([
    ['unclosed <table> openers', (n) => fill('<table>', n), 320_000],
    ['<table openers with no >', (n) => fill('<table ', n), 320_000],
    ['unclosed <tr> openers', (n) => `<table>${fill('<tr>', n)}`, 320_000],
    ['unclosed <td> openers', (n) => `<table>${fill('<td>x', n)}`, 320_000],
    ['nested table openers', (n) => fill('<table><tr><td>', n), 320_000],
    ['& before a long letter run', (n) => `&${'a'.repeat(n)}`, 320_000],
    ['& before a long letter run and a ;', (n) => `&${'a'.repeat(n)};`, 320_000],
    ['a run of <br> and newline', (n) => fill('<br>\n', n), 320_000],
    ['<br> before a long run of spaces', (n) => `<br>${' '.repeat(n)}x`, 320_000],
    ['a table cell of many lines', (n) => `<table><td>${fill(' x\n', n)}`, 320_000],
    [
      'a one-cell row of <p> and <br> lines',
      (n) => `<table><tr><td>${fill('<p>\t x<br> y</p>\n', n)}`,
      320_000,
    ],
    ['many one-cell rows with breaks', (n) => `<table>${fill('<tr><td>a<br>b', n)}`, 320_000],
    ['interleaved line breaks', (n) => `${fill('§1 x', n)}\ny`, 320_000],
  ])(
    '%s',
    (_label, build, largest) => {
      let first = 0;
      let last = 0;
      for (let n = largest / 64; n <= largest; n *= 2) {
        const html = build(n);
        last = cpuMs(() => htmlToText(html), CEILING_MS);
        expect(last, `${n} characters`).toBeLessThan(CEILING_MS);
        first ||= last;
      }
      expect(last / first).toBeLessThan(256);
    },
    60_000,
  );
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

  it('decodes record 8696 and keeps one newline per <br /> line end', () => {
    const lines = htmlToText(descriptions()['8696']).split('\n');
    expect(lines).toHaveLength(27);
    expect(lines.slice(0, 2)).toEqual([
      'Aim: Objective of this study was to examine farnesol sensitivity of yeast to hyphae',
      'dimorphism in clinical isolates of Candida albicans.',
    ]);
    expect(lines).toContain(
      'the range 25 to 400 μM. Inhibition of ≥ 50% hyphae was considered as significant reduction',
    );
    expect(lines).not.toContain('');
    expect(lines.join('\n')).not.toMatch(/&[a-z]+;/i);
  });

  it('decodes the HTML 4 entities of record 12666132', () => {
    const text = htmlToText(descriptions()['12666132']);
    expect(text).toContain('- Resolution: 1520×2704');
    expect(text).toContain('- k1,k2, p1, p2 = [−0.247, 0.0869, −0.006, 0.001]');
    expect(text).toContain('20 “ping”');
    expect(text).not.toMatch(/&[a-z]+;/i);
  });

  it('renders the pretty-printed table of record 6515070 one row per line', () => {
    expect(htmlToText(descriptions()['6515070'])).toBe(
      [
        'Supplementary data for Fenton et al. 2022.',
        '',
        'Supplementary Table | ID | Table Description',
        'supplementary table 1 | S1 | Transcript Start Site (TSS) metrics',
        'supplementary table 2 | S2 | Polyadenylation Site (PAS) metrics',
        'supplementary table 3 | S3 | NTE candidates',
        'supplementary table 4 | S4 | MTS candidates',
        'supplementary table 5 | S5 | iORFs candidates',
        'supplementary table 6 | S6 | uORFs candidates',
        'supplementary table 7 | S7 | ouORFs candidates',
        'supplementary table 8 | S8 | aORFs candidates',
        'supplementary table 9 | S9 | tRNA copy numbers',
        'supplementary table 10 | S10 | novel gene periodicity scores',
        'supplementary table 11 | S11 | description of novel genes',
        'supplementary table 12 | S12 | comparison of published genomes',
        'supplementary table 13 | S13 | table corrections',
        'supplementary table 14 | S14 | start codon corrections',
        'supplementary table 15 | S15 | Genes with splicing (at least one intron)',
      ].join('\n'),
    );
  });
});
