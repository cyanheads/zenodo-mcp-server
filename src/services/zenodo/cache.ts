/**
 * @fileoverview Process-local TTL LRU cache with an approximate byte budget. Zenodo
 * data is public, so one cache is shared across tenants; hits save the shared
 * egress IP's rate budget.
 * @module services/zenodo/cache
 */

interface Entry {
  bytes: number;
  expiresAt: number;
  value: unknown;
}

/** Budget options for {@link TtlLruCache}. */
export interface CacheOptions {
  /** Approximate total budget across all entries. */
  maxBytes: number;
  /** Entries estimated above this size are not stored. */
  maxEntryBytes: number;
}

/** Approximate size of a JSON-shaped value: its serialized length. */
function estimateBytes(value: unknown): number {
  return value === undefined ? 0 : (JSON.stringify(value)?.length ?? 0);
}

/** In-memory TTL cache, least-recently-used eviction by approximate byte size. */
export class TtlLruCache {
  readonly #entries = new Map<string, Entry>();
  readonly #options: CacheOptions;
  #bytes = 0;

  constructor(options: CacheOptions) {
    this.#options = options;
  }

  /** Returns the live value for `key` (refreshing its recency), or `undefined`. */
  get<T>(key: string): T | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return;
    if (entry.expiresAt <= Date.now()) {
      this.#delete(key, entry);
      return;
    }
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value as T;
  }

  /** Stores `value` for `ttlMs`. Oversized values are skipped; older entries are evicted to fit. */
  set(key: string, value: unknown, ttlMs: number): void {
    const bytes = estimateBytes(value);
    const existing = this.#entries.get(key);
    if (existing) this.#delete(key, existing);
    if (bytes > this.#options.maxEntryBytes) return;
    this.#entries.set(key, { bytes, expiresAt: Date.now() + ttlMs, value });
    this.#bytes += bytes;
    for (const [oldKey, oldEntry] of this.#entries) {
      if (this.#bytes <= this.#options.maxBytes) break;
      this.#delete(oldKey, oldEntry);
    }
  }

  /** Drops every entry. */
  clear(): void {
    this.#entries.clear();
    this.#bytes = 0;
  }

  #delete(key: string, entry: Entry): void {
    this.#entries.delete(key);
    this.#bytes -= entry.bytes;
  }
}
