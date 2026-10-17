import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryLruCache } from '../../src/core/cache/index.js';
import { generateApiKey } from '../../src/core/security/api-key.js';
import { MongoApiKeyVerifier } from '../../src/infra/db/api-key-verifier.js';
import { MongoIdempotencyStore } from '../../src/infra/db/idempotency-store.js';
import { MongoUserStatus } from '../../src/infra/db/user-status.js';
import { ApiKeyModel, UserModel, syncIndexes } from '../../src/infra/db/models/index.js';
import { CachedUserStatus } from '../../src/middleware/authenticate.js';
import { MemoryRateStore, RedisRateStore } from '../../src/middleware/rate-limit.js';
import { clearTestDb, startTestDb, stopTestDb } from '../helpers/mongo.js';

describe('mongo-backed gateway stores', () => {
  beforeAll(async () => {
    await startTestDb();
    await syncIndexes();
  });
  afterAll(stopTestDb);
  beforeEach(clearTestDb);

  it('idempotency store: first claim wins, atomically, under contention', async () => {
    const store = new MongoIdempotencyStore();
    const rec = { scope: 'u1', key: 'k1', route: 'POST /pay', requestHash: 'h', expiresAt: new Date(Date.now() + 1e6) };
    const results = await Promise.all(Array.from({ length: 10 }, () => store.claim(rec)));
    expect(results.filter((r) => r === null)).toHaveLength(1);
    expect(results.filter((r) => r?.status === 'in_progress')).toHaveLength(9);

    await store.complete('u1', 'k1', 'POST /pay', 201, { data: 1 });
    expect(await store.claim(rec)).toMatchObject({ status: 'completed', responseStatus: 201, responseBody: { data: 1 } });
  });

  it('idempotency store: release only removes unfinished claims', async () => {
    const store = new MongoIdempotencyStore();
    const rec = { scope: 'u', key: 'abcdefgh', route: 'r', requestHash: 'h', expiresAt: new Date(Date.now() + 1e6) };
    await store.claim(rec);
    await store.release('u', 'abcdefgh', 'r');
    expect(await store.claim(rec)).toBeNull(); // claimable again
    await store.complete('u', 'abcdefgh', 'r', 200, {});
    await store.release('u', 'abcdefgh', 'r');
    expect((await store.claim(rec))?.status).toBe('completed');
  });

  it('user status reflects role/ban and is cached then invalidated', async () => {
    await UserModel.create({ id: 'u1', username: 'a', usernameLower: 'a', role: 'admin' });
    const cache = new MemoryLruCache();
    const spy = vi.spyOn(MongoUserStatus.prototype, 'get');
    const status = new CachedUserStatus(new MongoUserStatus(), cache);
    expect(await status.get('u1')).toMatchObject({ role: 'admin', isBanned: false, username: 'a' });
    await status.get('u1');
    expect(spy).toHaveBeenCalledTimes(1);
    await UserModel.updateOne({ id: 'u1' }, { isBanned: true });
    expect((await status.get('u1'))?.isBanned).toBe(false); // stale until invalidated
    await status.invalidate('u1');
    expect((await status.get('u1'))?.isBanned).toBe(true);
    expect(await status.get('missing')).toBeNull();
    spy.mockRestore();
  });

  it('api key verifier honours revocation and expiry', async () => {
    const mk = async (extra = {}) => {
      const k = generateApiKey('mobile');
      await ApiKeyModel.create({ name: 'k', prefix: k.prefix, keyHash: k.hash, level: 'mobile', scopes: ['a'], ...extra });
      return k;
    };
    const good = await mk();
    const revoked = await mk({ revokedAt: new Date() });
    const expired = await mk({ expiresAt: new Date(Date.now() - 1000) });
    const v = new MongoApiKeyVerifier(new MemoryLruCache());
    expect(await v.verify(good.hash)).toMatchObject({ level: 'mobile', scopes: ['a'] });
    expect(await v.verify(revoked.hash)).toBeNull();
    expect(await v.verify(expired.hash)).toBeNull();
    expect(await v.verify('0'.repeat(64))).toBeNull();
    await new Promise((r) => setTimeout(r, 50));
    expect((await ApiKeyModel.findOne({ keyHash: good.hash }).lean())?.lastUsedAt).toBeInstanceOf(Date);
  });
});

describe('rate limit stores', () => {
  it('memory store counts per key and resets after the window', async () => {
    let now = 1000;
    const s = new MemoryRateStore(() => now);
    expect((await s.hit('a', 1000)).count).toBe(1);
    expect((await s.hit('a', 1000)).count).toBe(2);
    expect((await s.hit('b', 1000)).count).toBe(1);
    now += 1001;
    expect(await s.hit('a', 1000)).toEqual({ count: 1, resetMs: 1000 });
    s.close();
  });

  it('redis store runs the atomic script and parses its reply', async () => {
    const evalFn = vi.fn().mockResolvedValue([3, 41_000]);
    const s = new RedisRateStore({ eval: evalFn }, 'p:');
    expect(await s.hit('k', 60_000)).toEqual({ count: 3, resetMs: 41_000 });
    expect(evalFn.mock.calls[0]!.slice(1)).toEqual([1, 'p:k', 60_000]);
  });
});
