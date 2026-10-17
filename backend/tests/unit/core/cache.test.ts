import { describe, expect, it, vi } from 'vitest';
import { MemoryLruCache, RedisCache, cachedRepository, type RedisLike } from '../../../src/core/cache/index.js';

class FakeRedis implements RedisLike {
  store = new Map<string, string>();
  sets = new Map<string, Set<string>>();
  ttl = new Map<string, number>();
  async get(k: string) { return this.store.get(k) ?? null; }
  async set(k: string, v: string, _m: 'EX', s: number) { this.store.set(k, v); this.ttl.set(k, s); return 'OK'; }
  async del(...ks: string[]) { let n = 0; for (const k of ks) { n += Number(this.store.delete(k)) + Number(this.sets.delete(k)); } return n; }
  async sadd(k: string, ...m: string[]) { const s = this.sets.get(k) ?? new Set(); m.forEach((x) => s.add(x)); this.sets.set(k, s); return m.length; }
  async smembers(k: string) { return [...(this.sets.get(k) ?? [])]; }
  async expire(k: string, s: number) { this.ttl.set(k, s); return 1; }
  async scan(_c: string, ...args: (string | number)[]) {
    const pattern = String(args[1]).replace('*', '');
    return ['0', [...this.store.keys()].filter((k) => k.startsWith(pattern))] as [string, string[]];
  }
}

const backends: [string, () => MemoryLruCache | RedisCache][] = [
  ['MemoryLruCache', () => new MemoryLruCache({ defaultTtlSeconds: 60 })],
  ['RedisCache', () => new RedisCache(new FakeRedis(), 'p:', 60)],
];

describe.each(backends)('%s', (_name, make) => {
  it('stores, reads and deletes values (including falsy ones)', async () => {
    const c = make();
    expect(await c.get('a')).toBeUndefined();
    await c.set('a', { x: 1 });
    await c.set('zero', 0);
    await c.set('nul', null);
    expect(await c.get('a')).toEqual({ x: 1 });
    expect(await c.get('zero')).toBe(0);
    expect(await c.get('nul')).toBeNull();
    await c.del('a', 'zero');
    expect(await c.get('a')).toBeUndefined();
  });

  it('invalidates by tag only', async () => {
    const c = make();
    await c.set('p1', 1, { tags: ['packs'] });
    await c.set('p2', 2, { tags: ['packs'] });
    await c.set('g1', 3, { tags: ['gifts'] });
    await c.invalidateTag('packs');
    expect(await c.get('p1')).toBeUndefined();
    expect(await c.get('p2')).toBeUndefined();
    expect(await c.get('g1')).toBe(3);
    await c.invalidateTag('never-used');
  });

  it('wrap() loads once, caches, and collapses concurrent misses (single-flight)', async () => {
    const c = make();
    const loader = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return { v: 42 };
    });
    const results = await Promise.all(Array.from({ length: 10 }, () => c.wrap('k', loader)));
    expect(results.every((r) => r.v === 42)).toBe(true);
    expect(loader).toHaveBeenCalledTimes(1);
    await c.wrap('k', loader);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('wrap() propagates loader errors and does not cache them', async () => {
    const c = make();
    await expect(c.wrap('e', async () => { throw new Error('db down'); })).rejects.toThrow('db down');
    expect(await c.wrap('e', async () => 'ok')).toBe('ok');
  });

  it('clear() empties everything', async () => {
    const c = make();
    await c.set('a', 1, { tags: ['t'] });
    await c.clear();
    expect(await c.get('a')).toBeUndefined();
  });
});

describe('MemoryLruCache specifics', () => {
  it('expires entries after the ttl', async () => {
    const c = new MemoryLruCache();
    await c.set('k', 1, { ttl: 0.05 });
    expect(await c.get('k')).toBe(1);
    await new Promise((r) => setTimeout(r, 90));
    expect(await c.get('k')).toBeUndefined();
  });

  it('returns copies so callers cannot mutate cached state', async () => {
    const c = new MemoryLruCache();
    await c.set('o', { a: [1] });
    const v = (await c.get<{ a: number[] }>('o'))!;
    v.a.push(2);
    expect(await c.get('o')).toEqual({ a: [1] });
  });
});

describe('cachedRepository decorator', () => {
  it('caches configured read methods, passes writes through, invalidates by tag', async () => {
    const db = { rows: ['a'], reads: 0 };
    const repo = {
      async list(filter: string) { db.reads++; return db.rows.filter((r) => r.includes(filter)); },
      async add(x: string) { db.rows.push(x); },
      name: 'packs-repo',
    };
    const cached = cachedRepository(repo, new MemoryLruCache(), 'packs', { list: { ttl: 60, tags: ['packs'] } });

    expect(await cached.list('a')).toEqual(['a']);
    expect(await cached.list('a')).toEqual(['a']);
    expect(db.reads).toBe(1);
    expect(await cached.list('b')).toEqual([]);          // different args → different key
    expect(db.reads).toBe(2);

    await cached.add('ab');
    expect(await cached.list('a')).toEqual(['a']);       // still stale until invalidated
    await cached.invalidate('packs');
    expect(await cached.list('a')).toEqual(['a', 'ab']);
    expect(cached.name).toBe('packs-repo');
  });
});
