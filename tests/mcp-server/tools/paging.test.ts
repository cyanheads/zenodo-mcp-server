/**
 * @fileoverview Tests for the shared paging rules: Zenodo's 10,000-hit window
 * (a page is rejected only when it starts past the window, the straddling page is
 * served short, and has_more counts reachable hits) and the per-call cap that
 * serves a larger budget input at the cap instead of rejecting it.
 * @module tests/mcp-server/tools/paging.test
 */

import { describe, expect, it } from 'vitest';
import {
  applyCap,
  hasMorePages,
  PAGE_SIZE_CAP,
  RESULT_WINDOW,
  reachableHits,
  windowRejection,
} from '@/mcp-server/tools/paging.js';

describe('the 10,000-hit result window', () => {
  it('pins the window and the page-size cap', () => {
    expect(RESULT_WINDOW).toBe(10_000);
    expect(PAGE_SIZE_CAP).toBe(25);
  });

  it.each([
    [0, 0],
    [9_999, 9_999],
    [10_000, 10_000],
    [10_001, 10_000],
    [129_001, 10_000],
  ])('reachable hits of a %i total is %i', (total, reachable) => {
    expect(reachableHits(total)).toBe(reachable);
  });

  /** [size, the straddling last page] — sizes that do and do not divide 10,000. */
  it.each([
    [1, 10_000],
    [3, 3_334],
    [7, 1_429],
    [23, 435],
    [25, 400],
  ])('size %i: page %i starts inside the window, the next page does not', (size, last) => {
    expect((last - 1) * size).toBeLessThan(RESULT_WINDOW);
    expect(windowRejection(last, size, 'matches')).toBeUndefined();
    expect(windowRejection(last + 1, size, 'matches')).toBe(
      `Page ${last + 1} at size ${size} starts past the first 10,000 matches; the last reachable page at size ${size} is ${last}.`,
    );
  });

  it('accepts page 1 at every size and names the noun it is given', () => {
    expect(windowRejection(1, 25, 'entries')).toBeUndefined();
    expect(windowRejection(1, 1, 'versions')).toBeUndefined();
    expect(windowRejection(10_001, 1, 'versions')).toBe(
      'Page 10001 at size 1 starts past the first 10,000 versions; the last reachable page at size 1 is 10000.',
    );
  });

  it('names the cap when one lowered size', () => {
    const size = applyCap('size', 100, PAGE_SIZE_CAP);
    expect(windowRejection(401, size.applied, 'matches', size.capNote)).toBe(
      'Page 401 at size 25 starts past the first 10,000 matches (size 100 is capped at 25 per call); the last reachable page at size 25 is 400.',
    );
  });

  it.each([
    // [page, size, total, has_more]
    [3_333, 3, 129_001, true],
    [3_334, 3, 129_001, false],
    [1_428, 7, 45_426, true],
    [1_429, 7, 45_426, false],
    [434, 23, 10_001, true],
    [435, 23, 10_001, false],
    [399, 25, 25_000, true],
    [400, 25, 25_000, false],
    [1, 10, 10, false],
    [1, 10, 11, true],
    [2, 10, 11, false],
    [5, 10, 0, false],
  ])('page %i at size %i of %i: has_more %s', (page, size, total, more) => {
    expect(hasMorePages(page, size, total)).toBe(more);
  });
});

describe('applyCap', () => {
  it('passes a value at or under the cap through with no note', () => {
    expect(applyCap('size', 1, 25)).toEqual({ applied: 1 });
    expect(applyCap('size', 25, 25)).toEqual({ applied: 25 });
  });

  it('serves a value over the cap at the cap and names both values', () => {
    expect(applyCap('size', 26, 25)).toEqual({
      applied: 25,
      capNote: 'size 26 is capped at 25 per call',
    });
    expect(applyCap('limit', 10_000, 200)).toEqual({
      applied: 200,
      capNote: 'limit 10000 is capped at 200 per call',
    });
    expect(applyCap('max_bytes', 65_537, 65_536)).toEqual({
      applied: 65_536,
      capNote: 'max_bytes 65537 is capped at 65536 per call',
    });
  });
});
