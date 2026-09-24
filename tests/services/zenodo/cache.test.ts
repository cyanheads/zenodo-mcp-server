/**
 * @fileoverview Tests for the process-local TTL LRU cache: expiry, recency on read,
 * eviction under the byte budget, the per-entry size cap, and cached misses.
 * @module tests/services/zenodo/cache.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TtlLruCache } from '@/services/zenodo/cache.js';

/** A string value whose JSON size is exactly `bytes` (two quote characters included). */
const sized = (bytes: number, fill = 'x') => fill.repeat(bytes - 2);

describe('TtlLruCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns a stored value until its TTL elapses', () => {
    const cache = new TtlLruCache({ maxBytes: 1_000, maxEntryBytes: 1_000 });
    cache.set('record/1', { title: 'x' }, 5_000);
    vi.advanceTimersByTime(4_999);
    expect(cache.get('record/1')).toEqual({ title: 'x' });
    vi.advanceTimersByTime(1);
    expect(cache.get('record/1')).toBeUndefined();
  });

  it('returns undefined for a key never stored', () => {
    expect(new TtlLruCache({ maxBytes: 10, maxEntryBytes: 10 }).get('nope')).toBeUndefined();
  });

  it('keeps a cached miss (null) distinct from an absent key', () => {
    const cache = new TtlLruCache({ maxBytes: 1_000, maxEntryBytes: 1_000 });
    cache.set('funder/zzz', null, 600_000);
    expect(cache.get('funder/zzz')).toBeNull();
  });

  it('evicts the least recently used entry once the byte budget is exceeded', () => {
    const cache = new TtlLruCache({ maxBytes: 30, maxEntryBytes: 30 });
    cache.set('a', sized(10), 60_000);
    cache.set('b', sized(10), 60_000);
    cache.set('c', sized(10), 60_000);
    cache.set('d', sized(10), 60_000);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
    expect(cache.get('d')).toBeDefined();
  });

  it('refreshes recency on read, so a read entry survives eviction', () => {
    const cache = new TtlLruCache({ maxBytes: 30, maxEntryBytes: 30 });
    cache.set('a', sized(10), 60_000);
    cache.set('b', sized(10), 60_000);
    cache.set('c', sized(10), 60_000);
    cache.get('a');
    cache.set('d', sized(10), 60_000);
    expect(cache.get('a')).toBeDefined();
    expect(cache.get('b')).toBeUndefined();
  });

  it('does not double-count bytes when a key is overwritten', () => {
    const cache = new TtlLruCache({ maxBytes: 30, maxEntryBytes: 30 });
    cache.set('a', sized(10), 60_000);
    cache.set('b', sized(10), 60_000);
    cache.set('a', sized(10, 'y'), 60_000);
    cache.set('a', sized(10, 'z'), 60_000);
    cache.set('c', sized(10), 60_000);
    expect(cache.get('a')).toBe(sized(10, 'z'));
    expect(cache.get('b')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
  });

  it('skips a value larger than the per-entry cap, dropping any older value under the key', () => {
    const cache = new TtlLruCache({ maxBytes: 1_000, maxEntryBytes: 20 });
    cache.set('record/1', sized(10), 60_000);
    cache.set('record/1', sized(21), 60_000);
    expect(cache.get('record/1')).toBeUndefined();
    cache.set('record/2', sized(20), 60_000);
    expect(cache.get('record/2')).toBe(sized(20));
  });

  it('frees an expired entry’s bytes when it is read', () => {
    const cache = new TtlLruCache({ maxBytes: 20, maxEntryBytes: 20 });
    cache.set('old', sized(10), 1_000);
    cache.set('keep', sized(10), 60_000);
    vi.advanceTimersByTime(1_000);
    expect(cache.get('old')).toBeUndefined();
    cache.set('new', sized(10), 60_000);
    expect(cache.get('keep')).toBeDefined();
    expect(cache.get('new')).toBeDefined();
  });

  it('clear() drops every entry and resets the budget', () => {
    const cache = new TtlLruCache({ maxBytes: 20, maxEntryBytes: 20 });
    cache.set('a', sized(20), 60_000);
    cache.clear();
    expect(cache.get('a')).toBeUndefined();
    cache.set('b', sized(20), 60_000);
    expect(cache.get('b')).toBeDefined();
  });
});
