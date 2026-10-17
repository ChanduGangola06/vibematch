import type { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RedisCache } from '../../src/core/cache/index.js';
import { syncIndexes } from '../../src/infra/db/models/index.js';
import { RedisRateStore, createRateLimiter } from '../../src/middleware/rate-limit.js';
import { PresenceService } from '../../src/modules/matching/presence.service.js';
import { RedisMatchQueue, defaultRules, type QueueEntry } from '../../src/modules/matching/queue.js';
import { RedisSessionStore } from '../../src/modules/matching/session-store.js';
import { registerUser } from '../helpers/full-app.js';
import { clearTestDb, startTestDb, stopTestDb } from '../helpers/mongo.js';
import { newRedis, startTestRedis, stopTestRedis } from '../helpers/redis.js';
import { call, nextEvent, startSocketApp, type SocketApp } from '../helpers/socket-app.js';

/**
 * These run against a REAL Redis. They exist because the Redis code paths (Lua script, SCAN, sorted-set
 * queue, pub/sub adapter) cannot be proven with in-memory fakes.
 */
describe('Redis-backed building blocks (real server)', () => {
  let redis: Redis;
  beforeAll(async () => {
    redis = await startTestRedis();
  });
  afterAll(stopTestRedis);
  beforeEach(async () => {
    await redis.flushall();
  });

  it('RedisCache: TTL, tag invalidation, SCAN-based clear, single-flight across callers', async () => {
    const c = new RedisCache(redis as never, 'c:', 60);
    await c.set('a', { n: 1 }, { ttl: 1, tags: ['t'] });
    await c.set('b', 2, { tags: ['t'] });
    await c.set('keep', 3);
    expect(await c.get('a')).toEqual({ n: 1 });
    expect(await redis.ttl('c:a')).toBeLessThanOrEqual(1);
    await c.invalidateTag('t');
    expect(await c.get('a')).toBeUndefined();
    expect(await c.get('b')).toBeUndefined();
    expect(await c.get('keep')).toBe(3);

    let loads = 0;
    const loader = async () => { loads++; await new Promise((r) => setTimeout(r, 20)); return 'v'; };
    await Promise.all(Array.from({ length: 8 }, () => c.wrap('w', loader)));
    expect(loads).toBe(1);

    for (let i = 0; i < 700; i++) await redis.set(`c:bulk${i}`, '1'); // more than one SCAN page
    await c.clear();
    expect(await redis.keys('c:*')).toEqual([]);
    await c.set('x', 1, { ttl: 1 });
    await new Promise((r) => setTimeout(r, 1100));
    expect(await c.get('x')).toBeUndefined();
  });

  it('RedisRateStore: atomic Lua counter, window expiry, and it is shared by two stores', async () => {
    const a = new RedisRateStore(redis as never, 'rl:');
    const b = new RedisRateStore((await newRedis()) as never, 'rl:'); // "another instance"
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => (i % 2 ? a : b).hit('ip1', 60_000)));
    expect(results.map((r) => r.count).sort((x, y) => x - y)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(results[0]!.resetMs).toBeGreaterThan(55_000);
    expect(await redis.pttl('rl:ip1')).toBeGreaterThan(0);

    expect((await a.hit('short', 200)).count).toBe(1);
    await new Promise((r) => setTimeout(r, 250));
    expect((await a.hit('short', 200)).count).toBe(1); // window reset
  });

  it('rate limiter middleware over Redis: two instances share one budget', async () => {
    const mk = (r: Redis) => {
      const express = (req: any, res: any, next: any) => { req.log = { error() {} }; next(); };
      const lim = createRateLimiter({ name: 't', max: 5, windowMs: 60_000, by: 'ip', store: new RedisRateStore(r as never, 'rl2:') });
      return async () => {
        let status = 200;
        await new Promise<void>((resolve) => {
          const res = { setHeader() {}, getHeader() { return undefined; } };
          express({ ip: '1.2.3.4' }, res, () => lim({ ip: '1.2.3.4', log: { error() {} } } as never, res as never, (err?: unknown) => { if (err) status = 429; resolve(); }));
        });
        return status;
      };
    };
    const i1 = mk(redis);
    const i2 = mk(await newRedis());
    const statuses = [await i1(), await i2(), await i1(), await i2(), await i1(), await i2(), await i1()];
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429, 429]);
  });

  const entry = (id: string, over: Partial<QueueEntry> = {}): QueueEntry => ({
    socketId: `s-${id}`, userId: `u-${id}`, gender: 'female', country: 'France', countryCode: 'FR', prefGender: 'both', prefCountry: '', superMatch: false, joinedAt: Date.now(), ...over,
  });

  it('RedisMatchQueue: FIFO pairing, preferences, removal and purge', async () => {
    const q = new RedisMatchQueue(redis as never);
    expect(await q.matchOrEnqueue(entry('1', { joinedAt: 1 }), defaultRules)).toBeNull();
    expect(await q.matchOrEnqueue(entry('2', { joinedAt: 2, gender: 'male', prefGender: 'male' }), defaultRules)).toBeNull(); // wants a man, only a woman waits
    expect(await q.size()).toBe(2);
    expect(await q.matchOrEnqueue(entry('3', { joinedAt: 3, gender: 'male' }), defaultRules)).toMatchObject({ socketId: 's-1' }); // 1 wants anyone
    expect(await q.remove('s-2')).toBe(true);
    expect(await q.remove('s-2')).toBe(false);
    await q.matchOrEnqueue(entry('old', { joinedAt: 1, prefGender: 'male' }), defaultRules);
    expect(await q.purge(1000, 5000)).toBe(1);
  });

  it('RedisMatchQueue: 200 concurrent arrivals from two connections form exactly 100 pairs (distributed lock)', async () => {
    const q1 = new RedisMatchQueue(redis as never);
    const q2 = new RedisMatchQueue((await newRedis()) as never);
    const matched = new Set<string>();
    let pairs = 0;
    await Promise.all(
      Array.from({ length: 200 }, async (_, i) => {
        const me = entry(String(i), { joinedAt: i });
        const partner = await (i % 2 ? q1 : q2).matchOrEnqueue(me, defaultRules);
        if (partner) {
          pairs++;
          for (const id of [me.socketId, partner.socketId]) {
            expect(matched.has(id), `${id} matched twice`).toBe(false);
            matched.add(id);
          }
        }
      }),
    );
    expect(pairs).toBe(100);
    expect(await q1.size()).toBe(0);
    expect(await redis.exists('vm:mq:lock')).toBe(0); // lock always released
  });

  it('RedisSessionStore round-trips through Redis; PresenceService sums instances via SCAN/MGET', async () => {
    const store = new RedisSessionStore(redis as never);
    const s = { socketId: 'a', userId: 'u1', partnerSocketId: 'b', partnerUserId: 'u2', isDemo: false, startedAt: 1 };
    await store.set(s);
    expect(await store.get('a')).toEqual(s);
    expect(await redis.ttl('vm:sess:a')).toBeGreaterThan(3600);
    expect(await store.delete('a')).toEqual(s);
    expect(await store.get('a')).toBeUndefined();

    const p1 = new PresenceService(() => 10, undefined, redis as never, 'i1');
    const p2 = new PresenceService(() => 7, undefined, (await newRedis()) as never, 'i2');
    await p2.realCount();
    expect(await p1.realCount()).toBe(17);
  });
});

describe('two API instances sharing Redis (cluster behaviour)', () => {
  let redis: Redis;
  let a: SocketApp;
  let b: SocketApp;

  beforeAll(async () => {
    redis = await startTestRedis();
    await startTestDb();
    await syncIndexes();
    // Two independent app instances (own caches/limiters/socket servers) on one Mongo + one Redis.
    a = await startSocketApp({}, {}, { redis });
    b = await startSocketApp({}, {}, { redis: await newRedis() });
  });
  afterAll(async () => {
    await a.stop();
    await b.stop();
    await stopTestDb();
    await stopTestRedis();
  });
  beforeEach(async () => {
    await clearTestDb();
    await redis.flushall();
    for (const app of [a, b]) {
      for (const c of app.clients) c.disconnect();
      app.clients.length = 0;
    }
  });

  it('matches users connected to DIFFERENT instances and relays signalling and chat between them', async () => {
    const ua = await registerUser(a, 'alice');
    const ub = await registerUser(b, 'bobby'); // registered through instance B; same database
    const sa = await a.connect(ua.accessToken);
    const sb = await b.connect(ub.accessToken);

    const foundA = nextEvent(sa, 'match_found');
    const foundB = nextEvent(sb, 'match_found');
    expect((await call(sa, 'join_queue', {})).status).toBe('waiting');
    expect((await call(sb, 'join_queue', {})).status).toBe('matched');
    expect(await foundA).toMatchObject({ initiator: false, partner: { id: ub.id } });
    expect(await foundB).toMatchObject({ initiator: true, partner: { id: ua.id } });

    const offer = nextEvent(sa, 'signal');
    expect(await call(sb, 'signal', { signal: { type: 'offer', sdp: 'v=0' } })).toEqual({ ok: true, delivered: true });
    expect(await offer).toMatchObject({ signal: { type: 'offer' } });

    const incoming = nextEvent(sa, 'receive_message');
    const sent = await call(sb, 'send_message', { text: 'across instances' });
    expect(sent.ok).toBe(true);
    expect(await incoming).toMatchObject({ from: ub.id, text: 'across instances' });

    const skipped = nextEvent(sb, 'partner_skipped');
    await call(sa, 'skip_match');
    expect(await skipped).toEqual({ reason: 'skipped' });
    expect(await a.services.matching.session(sa.id!)).toBeUndefined();
  });

  it('a REST action on one instance reaches a socket on the other (room broadcast via the Redis adapter)', async () => {
    const ua = await registerUser(a, 'carol');
    const ub = await registerUser(b, 'dave');
    await request(a.app).put(`/api/v1/users/${ub.id}/follow`).set('Authorization', ua.bearer);
    await request(b.app).put(`/api/v1/users/${ua.id}/follow`).set('Authorization', ub.bearer);
    const sb = await b.connect(ub.accessToken); // the socket lives on B; every action below happens on A

    const liked = nextEvent(sb, 'partner_liked');
    await request(a.app).put(`/api/v1/users/${ub.id}/like`).set('Authorization', ua.bearer);
    expect(await liked).toEqual({ newLikesCount: 1 });

    const note = nextEvent(sb, 'new_message_notification');
    await request(a.app).post(`/api/v1/conversations/${ub.id}/messages`).set('Authorization', ua.bearer).send({ text: 'hello from A' });
    expect(await note).toMatchObject({ senderId: ua.id, text: 'hello from A' });
  });

  it('banning on one instance disconnects the user\'s sockets on the other; logout does the same', async () => {
    const victim = await registerUser(b, 'mallory');
    const sv = await b.connect(victim.accessToken);
    const dropped = new Promise<string>((r) => sv.once('disconnect', r));
    await a.deps.events.emitAndWait('user.banned', { userId: victim.id, banned: true }); // admin acts on instance A
    expect(await dropped).toBe('io server disconnect');

    const other = await registerUser(b, 'olivia');
    const so = await b.connect(other.accessToken);
    const dropped2 = new Promise<string>((r) => so.once('disconnect', r));
    await request(a.app).post('/api/v1/auth/logout').set('Authorization', other.bearer).send({});
    expect(await dropped2).toBe('io server disconnect');
  });

  it('a rate-limit budget is shared by all instances', async () => {
    const x = await startSocketApp({ RATE_LIMIT_GLOBAL: '6' }, {}, { redis, prefix: 'shared' });
    const y = await startSocketApp({ RATE_LIMIT_GLOBAL: '6' }, {}, { redis: await newRedis(), prefix: 'shared' });
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) codes.push((await request(x.app).get('/health/live')).status);
    for (let i = 0; i < 3; i++) codes.push((await request(y.app).get('/health/live')).status);
    codes.push((await request(x.app).get('/health/live')).status, (await request(y.app).get('/health/live')).status);
    await x.stop();
    await y.stop();
    expect(codes).toEqual([200, 200, 200, 200, 200, 200, 429, 429]);
  });

  it('the online count is the sum over both instances', async () => {
    const ua = await registerUser(a, 'erin');
    const ub = await registerUser(b, 'frank');
    await a.connect(ua.accessToken);
    await b.connect(ub.accessToken);
    await b.connect(ub.accessToken);
    await vi.waitFor(async () => {
      await b.services.presence.realCount(); // each instance publishes its own figure …
      expect(await a.services.presence.realCount()).toBe(3); // … and any instance reads the total
    });
  });
});
