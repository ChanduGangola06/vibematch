import { LRUCache } from 'lru-cache';
import { BaseCache, type SetOptions } from './cache.js';

export interface MemoryCacheOptions {
  max?: number;
  defaultTtlSeconds?: number;
}

/** In-process LRU with TTL. Default backend; correct for a single instance. */
export class MemoryLruCache extends BaseCache {
  private readonly lru: LRUCache<string, { v: unknown }>;
  private readonly tags = new Map<string, Set<string>>();
  private readonly defaultTtl: number;

  constructor(opts: MemoryCacheOptions = {}) {
    super();
    this.defaultTtl = opts.defaultTtlSeconds ?? 60;
    this.lru = new LRUCache({
      max: opts.max ?? 5000,
      ttl: this.defaultTtl * 1000,
      ttlAutopurge: false,
      updateAgeOnGet: false,
    });
  }

  async get<T>(key: string): Promise<T | undefined> {
    const entry = this.lru.get(key);
    return entry === undefined ? undefined : (structuredClone(entry.v) as T);
  }

  async set<T>(key: string, value: T, opts: SetOptions = {}): Promise<void> {
    this.lru.set(key, { v: structuredClone(value) }, { ttl: (opts.ttl ?? this.defaultTtl) * 1000 });
    for (const tag of opts.tags ?? []) {
      let keys = this.tags.get(tag);
      if (!keys) this.tags.set(tag, (keys = new Set()));
      keys.add(key);
    }
  }

  async del(...keys: string[]): Promise<void> {
    for (const k of keys) this.lru.delete(k);
  }

  async invalidateTag(tag: string): Promise<void> {
    const keys = this.tags.get(tag);
    if (!keys) return;
    for (const k of keys) this.lru.delete(k);
    this.tags.delete(tag);
  }

  async clear(): Promise<void> {
    this.lru.clear();
    this.tags.clear();
  }
}
