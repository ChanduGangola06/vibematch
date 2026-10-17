import { BaseCache, type SetOptions } from './cache.js';

/** The subset of ioredis we use — keeps the adapter testable with a fake. */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  sadd(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  expire(key: string, seconds: number): Promise<number>;
  scan(cursor: string, ...args: (string | number)[]): Promise<[string, string[]]>;
}

/** Shared cache for multi-instance deployments (Adapter over Redis). */
export class RedisCache extends BaseCache {
  constructor(
    private readonly redis: RedisLike,
    private readonly prefix = 'vm:cache:',
    private readonly defaultTtl = 60,
  ) {
    super();
  }

  private k(key: string) {
    return `${this.prefix}${key}`;
  }
  private t(tag: string) {
    return `${this.prefix}tag:${tag}`;
  }

  async get<T>(key: string): Promise<T | undefined> {
    const raw = await this.redis.get(this.k(key));
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  async set<T>(key: string, value: T, opts: SetOptions = {}): Promise<void> {
    const ttl = opts.ttl ?? this.defaultTtl;
    await this.redis.set(this.k(key), JSON.stringify(value), 'EX', ttl);
    for (const tag of opts.tags ?? []) {
      await this.redis.sadd(this.t(tag), this.k(key));
      // tag sets live a little longer than their members, then vanish on their own
      await this.redis.expire(this.t(tag), ttl * 2);
    }
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length) await this.redis.del(...keys.map((k) => this.k(k)));
  }

  async invalidateTag(tag: string): Promise<void> {
    const members = await this.redis.smembers(this.t(tag));
    if (members.length) await this.redis.del(...members);
    await this.redis.del(this.t(tag));
  }

  async clear(): Promise<void> {
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', `${this.prefix}*`, 'COUNT', 500);
      if (keys.length) await this.redis.del(...keys);
      cursor = next;
    } while (cursor !== '0');
  }
}
