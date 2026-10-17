import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEventBus } from '../../src/core/events/index.js';
import { createAsyncLogger } from '../../src/core/logger/index.js';
import { MatchModel, UserModel, syncIndexes } from '../../src/infra/db/models/index.js';
import {
  MemoryMatchQueue, RedisMatchQueue, defaultRules, type MatchQueue, type QueueEntry, type RedisQueueLike,
} from '../../src/modules/matching/queue.js';
import { MatchingService, type PeerNotifier } from '../../src/modules/matching/matching.service.js';
import { MemorySessionStore, RedisSessionStore } from '../../src/modules/matching/session-store.js';
import { UserRepository } from '../../src/modules/users/user.repository.js';
import { clearTestDb, startTestDb, stopTestDb } from '../helpers/mongo.js';

// ------------------------------------------------------------------------------------------------
class FakeRedis implements RedisQueueLike {
  kv = new Map<string, string>();
  hashes = new Map<string, Map<string, string>>();
  zsets = new Map<string, Map<string, number>>();
  async set(key: string, value: string, ...args: (string | number)[]) {
    if (args.includes('NX') && this.kv.has(key)) return null;
    this.kv.set(key, value);
    return 'OK';
  }
  async get(key: string) { return this.kv.get(key) ?? null; }
  async del(...keys: string[]) { return keys.reduce((n, k) => n + Number(this.kv.delete(k)), 0); }
  private h(k: string) { return this.hashes.get(k) ?? this.hashes.set(k, new Map()).get(k)!; }
  private z(k: string) { return this.zsets.get(k) ?? this.zsets.set(k, new Map()).get(k)!; }
  async hset(k: string, f: string, v: string) { this.h(k).set(f, v); return 1; }
  async hget(k: string, f: string) { return this.h(k).get(f) ?? null; }
  async hmget(k: string, ...fs: string[]) { return fs.map((f) => this.h(k).get(f) ?? null); }
  async hdel(k: string, ...fs: string[]) { return fs.reduce((n, f) => n + Number(this.h(k).delete(f)), 0); }
  async zadd(k: string, score: number, m: string) { this.z(k).set(m, score); return 1; }
  async zrange(k: string, s: number, e: number) { return [...this.z(k)].sort((a, b) => a[1] - b[1]).map(([m]) => m).slice(s, e + 1); }
  async zrem(k: string, ...ms: string[]) { return ms.reduce((n, m) => n + Number(this.z(k).delete(m)), 0); }
  async zcard(k: string) { return this.z(k).size; }
  async zremrangebyscore() { return 0; }
}

const entry = (over: Partial<QueueEntry> & { socketId: string; userId: string }): QueueEntry => ({
  gender: 'female', country: 'France', countryCode: 'FR', prefGender: 'both', prefCountry: '', superMatch: false, joinedAt: 1000, ...over,
});

// ================================================================================== queues =======
const queueImpls: [string, () => MatchQueue][] = [
  ['MemoryMatchQueue', () => new MemoryMatchQueue()],
  ['RedisMatchQueue', () => new RedisMatchQueue(new FakeRedis(), () => new Promise((r) => setTimeout(r, 1)))],
];

describe.each(queueImpls)('%s', (_n, make) => {
  it('enqueues when nobody is waiting, then matches the next arrival FIFO and removes both', async () => {
    const q = make();
    expect(await q.matchOrEnqueue(entry({ socketId: 's1', userId: 'u1', joinedAt: 1 }), defaultRules)).toBeNull();
    expect(await q.matchOrEnqueue(entry({ socketId: 's2', userId: 'u2', joinedAt: 2 }), defaultRules)).toMatchObject({ socketId: 's1' });
    expect(await q.size()).toBe(0);
  });

  it('never matches a user with themself (two tabs) and respects arrival order', async () => {
    const q = make();
    await q.matchOrEnqueue(entry({ socketId: 'a1', userId: 'same', joinedAt: 1 }), defaultRules);
    expect(await q.matchOrEnqueue(entry({ socketId: 'a2', userId: 'same', joinedAt: 2 }), defaultRules)).toBeNull();
    expect(await q.size()).toBe(2);
    expect(await q.matchOrEnqueue(entry({ socketId: 'b1', userId: 'other', joinedAt: 3 }), defaultRules)).toMatchObject({ socketId: 'a1' });
  });

  it('applies gender and country preferences in both directions', async () => {
    const q = make();
    await q.matchOrEnqueue(entry({ socketId: 'f-fr', userId: 'u1', gender: 'female', country: 'France', countryCode: 'FR', prefGender: 'male', joinedAt: 1 }), defaultRules);
    // a female asker is refused by the waiting user (wants males)
    expect(await q.matchOrEnqueue(entry({ socketId: 'f2', userId: 'u2', gender: 'female', joinedAt: 2 }), defaultRules)).toBeNull();
    // a male asker who only wants Germans is refused too
    expect(await q.matchOrEnqueue(entry({ socketId: 'm-de', userId: 'u3', gender: 'male', prefCountry: 'Germany', joinedAt: 3 }), defaultRules)).toBeNull();
    // a male asker who wants France (by ISO code, any case) is accepted
    expect(await q.matchOrEnqueue(entry({ socketId: 'm-fr', userId: 'u4', gender: 'male', prefCountry: 'fr', joinedAt: 4 }), defaultRules)).toMatchObject({ socketId: 'f-fr' });
  });

  it('remove() reports whether the user was still waiting; re-joining replaces the old entry', async () => {
    const q = make();
    await q.matchOrEnqueue(entry({ socketId: 's1', userId: 'u1' }), defaultRules);
    await q.matchOrEnqueue(entry({ socketId: 's1', userId: 'u1', prefGender: 'male' }), defaultRules);
    expect(await q.size()).toBe(1);
    expect(await q.remove('s1')).toBe(true);
    expect(await q.remove('s1')).toBe(false);
  });

  it('purge drops zombies only', async () => {
    const q = make();
    await q.matchOrEnqueue(entry({ socketId: 'old', userId: 'u1', joinedAt: 0, prefGender: 'male' }), defaultRules);
    await q.matchOrEnqueue(entry({ socketId: 'new', userId: 'u2', joinedAt: 9_000, prefGender: 'male' }), defaultRules);
    expect(await q.purge(5_000, 10_000)).toBe(1);
    expect(await q.size()).toBe(1);
  });

  it('is atomic: 200 simultaneous arrivals form exactly 100 pairs, nobody is matched twice', async () => {
    const q = make();
    const matched = new Set<string>();
    let pairs = 0;
    await Promise.all(
      Array.from({ length: 200 }, async (_, i) => {
        const me = entry({ socketId: `s${i}`, userId: `u${i}`, joinedAt: i });
        const partner = await q.matchOrEnqueue(me, defaultRules);
        if (partner) {
          pairs++;
          for (const id of [me.socketId, partner.socketId]) {
            expect(matched.has(id)).toBe(false);
            matched.add(id);
          }
        }
      }),
    );
    expect(pairs).toBe(100);
    expect(await q.size()).toBe(0);
  });
});

describe('RedisMatchQueue specifics', () => {
  it('skips dangling order entries and survives a lock held by a crashed instance', async () => {
    const r = new FakeRedis();
    const q = new RedisMatchQueue(r, async () => {});
    r.zsets.set('vm:mq:order', new Map([['ghost', 1]]));
    expect(await q.matchOrEnqueue(entry({ socketId: 's1', userId: 'u1', joinedAt: 5 }), defaultRules)).toBeNull();
    expect(await q.size()).toBe(1); // ghost cleaned, s1 queued

    r.kv.set('vm:mq:lock', 'dead-instance');
    let waits = 0;
    const patient = new RedisMatchQueue(r, async () => { if (++waits === 3) r.kv.delete('vm:mq:lock'); });
    expect(await patient.matchOrEnqueue(entry({ socketId: 's2', userId: 'u2', joinedAt: 6 }), defaultRules)).toMatchObject({ socketId: 's1' });
    expect(waits).toBe(3);
  });

  it('gives up with an error rather than hanging when the lock never frees', async () => {
    const r = new FakeRedis();
    r.kv.set('vm:mq:lock', 'stuck');
    await expect(new RedisMatchQueue(r, async () => {}).matchOrEnqueue(entry({ socketId: 's', userId: 'u' }), defaultRules)).rejects.toThrow(/lock timeout/);
  });
});

describe('RedisSessionStore', () => {
  it('round-trips and deletes', async () => {
    const kv = new Map<string, string>();
    const store = new RedisSessionStore({
      set: async (k, v) => void kv.set(k, v), get: async (k) => kv.get(k) ?? null, del: async (...ks) => ks.reduce((n, k) => n + Number(kv.delete(k)), 0),
    });
    const s = { socketId: 'a', userId: 'u1', partnerSocketId: 'b', partnerUserId: 'u2', isDemo: false, startedAt: 1 };
    await store.set(s);
    expect(await store.get('a')).toEqual(s);
    expect(await store.delete('a')).toEqual(s);
    expect(await store.get('a')).toBeUndefined();
    expect(await store.delete('a')).toBeUndefined();
  });
});

// ============================================================================ MatchingService ====
describe('MatchingService', () => {
  const log = createAsyncLogger({ level: 'silent', flushMs: 1000 }).logger;
  const sent: { to: string; event: string; payload: any }[] = [];
  const notifier: PeerNotifier = { emit: (to, event, payload) => void sent.push({ to, event, payload }) };
  let svc: MatchingService;
  let sessions: MemorySessionStore;
  let queue: MemoryMatchQueue;
  const users = new UserRepository();
  const emitted = vi.fn();
  let now = 1_000_000;

  beforeAll(async () => {
    await startTestDb();
    await syncIndexes();
  });
  afterAll(stopTestDb);
  beforeEach(async () => {
    await clearTestDb();
    sent.length = 0;
    emitted.mockClear();
    now = 1_000_000;
    sessions = new MemorySessionStore();
    queue = new MemoryMatchQueue();
    const events = createEventBus();
    events.on('match.ended', emitted);
    svc = new MatchingService(queue, sessions, users, notifier, events, log, { demoDelayMs: 25, staleAfterMs: 60_000 }, defaultRules, () => now);
  });

  const mk = (id: string, extra: Record<string, unknown> = {}) =>
    UserModel.create({ id, username: id, usernameLower: id, name: id.toUpperCase(), gender: 'female', country: 'France', countryCode: 'FR', age: 25, ...extra });
  const vip = { vipExpiry: new Date(Date.now() + 86_400_000) };
  const eventsTo = (to: string, event: string) => sent.filter((s) => s.to === to && s.event === event);

  it('pairs two real users, tells each about the other, and the newcomer initiates', async () => {
    await mk('alice', { likesCount: 7 });
    await mk('bob', { gender: 'male', country: 'Spain', countryCode: 'ES' });
    expect((await svc.join({ socketId: 's-alice', userId: 'alice' })).status).toBe('waiting');
    expect((await svc.join({ socketId: 's-bob', userId: 'bob' })).status).toBe('matched');

    expect(eventsTo('s-bob', 'match_found')[0]!.payload).toMatchObject({ initiator: true, peerId: 's-alice', partner: { id: 'alice', name: 'ALICE', likesCount: 7, isVip: false } });
    expect(eventsTo('s-alice', 'match_found')[0]!.payload).toMatchObject({ initiator: false, peerId: 's-bob', partner: { id: 'bob', country: 'Spain' } });
    expect(JSON.stringify(sent)).not.toMatch(/email|passwordHash|gems/);
    expect(await svc.session('s-alice')).toMatchObject({ partnerSocketId: 's-bob', partnerUserId: 'bob', isDemo: false });
    expect(await svc.session('s-bob')).toMatchObject({ partnerSocketId: 's-alice' });
    expect(await svc.queueSize()).toBe(0);
  });

  it('skip: notifies the partner, closes both sessions and writes history for BOTH users', async () => {
    await mk('alice');
    await mk('bob', { name: 'Bobby' });
    await svc.join({ socketId: 's-alice', userId: 'alice' });
    await svc.join({ socketId: 's-bob', userId: 'bob' });
    now += 75_000;
    await svc.end('s-alice', 'skipped');

    expect(eventsTo('s-bob', 'partner_skipped')).toHaveLength(1);
    expect(await svc.session('s-alice')).toBeUndefined();
    expect(await svc.session('s-bob')).toBeUndefined();
    const rows = await MatchModel.find({ type: 'video_chat' }).sort({ userId: 1 }).lean();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ userId: 'alice', partnerId: 'bob', durationSec: 75, partner: { name: 'Bobby', username: 'bob' } });
    expect(rows[1]).toMatchObject({ userId: 'bob', partnerId: 'alice' });
    expect(emitted).toHaveBeenCalledWith({ userIds: ['alice', 'bob'], durationSec: 75 });

    await svc.end('s-alice'); // idempotent
    await svc.end('s-bob');
    expect(await MatchModel.countDocuments()).toBe(2);
  });

  it('a dropped connection behaves like a skip; a call shorter than 1 s leaves no history', async () => {
    await mk('alice');
    await mk('bob');
    await svc.join({ socketId: 's-alice', userId: 'alice' });
    await svc.join({ socketId: 's-bob', userId: 'bob' });
    await svc.disconnect('s-bob');
    expect(eventsTo('s-alice', 'partner_skipped')[0]!.payload).toEqual({ reason: 'disconnected' });
    expect(await MatchModel.countDocuments()).toBe(0);

    await svc.join({ socketId: 's-carol', userId: 'alice' }); // waiting again
    await svc.disconnect('s-carol');
    expect(await svc.queueSize()).toBe(0);
  });

  it('joining again ends the previous call first (Next button)', async () => {
    await mk('alice');
    await mk('bob');
    await mk('carol');
    await svc.join({ socketId: 's-alice', userId: 'alice' });
    await svc.join({ socketId: 's-bob', userId: 'bob' });
    now += 5000;
    await svc.join({ socketId: 's-bob', userId: 'bob' });
    expect(eventsTo('s-alice', 'partner_skipped')[0]!.payload).toEqual({ reason: 'rejoined' });
    expect(await svc.session('s-alice')).toBeUndefined();
    expect((await svc.join({ socketId: 's-carol', userId: 'carol' })).status).toBe('matched');
    expect(await svc.session('s-carol')).toMatchObject({ partnerSocketId: 's-bob' });
  });

  describe('filters are a VIP feature, enforced on the server', () => {
    it('non-VIP filters are ignored (and the caller is told), so a male filter cannot be used for free', async () => {
      await mk('fan', { gender: 'female' });
      await mk('freeloader', { gender: 'male' });
      await svc.join({ socketId: 's1', userId: 'fan', gender: 'male' }); // ignored: fan is not VIP
      const r = await svc.join({ socketId: 's2', userId: 'freeloader', gender: 'female', country: 'Japan', superMatch: true });
      expect(r.applied).toEqual({ gender: 'both', country: '', superMatch: false, filtersIgnored: true });
      expect(r.status).toBe('matched'); // would have been refused had the Japan filter been honoured
    });

    it('VIP gender and country filters are honoured', async () => {
      await mk('vipman', { gender: 'male', ...vip });
      await mk('fr1', { gender: 'female', country: 'France', countryCode: 'FR' });
      await mk('de1', { gender: 'female', country: 'Germany', countryCode: 'DE' });
      await mk('guy', { gender: 'male', country: 'Germany', countryCode: 'DE' });
      await svc.join({ socketId: 's-fr', userId: 'fr1' });
      await svc.join({ socketId: 's-guy', userId: 'guy' }); // male: not compatible with fr1? (no prefs) → matches fr1 actually
      // fr1 and guy paired (both open). Start clean for the filtered scenario:
      await svc.end('s-fr');
      await svc.join({ socketId: 's-de', userId: 'de1' });
      const r = await svc.join({ socketId: 's-vip', userId: 'vipman', gender: 'female', country: 'germany' });
      expect(r.applied).toEqual({ gender: 'female', country: 'germany', superMatch: false, filtersIgnored: false });
      expect(r.status).toBe('matched');
      expect(await svc.session('s-vip')).toMatchObject({ partnerUserId: 'de1' });
    });

    it('a VIP filter that nobody satisfies keeps waiting instead of matching a wrong person', async () => {
      await mk('vipman', { gender: 'male', ...vip });
      await mk('de1', { gender: 'female', country: 'Germany', countryCode: 'DE' });
      await svc.join({ socketId: 's-de', userId: 'de1' });
      expect((await svc.join({ socketId: 's-vip', userId: 'vipman', country: 'France' })).status).toBe('waiting');
      expect(await svc.queueSize()).toBe(2);
    });
  });

  describe('demo personas', () => {
    it('are offered when nobody real is waiting, with the video and no WebRTC peer', async () => {
      await mk('alice');
      await mk('demo1', { isDemo: true, isOnline: true, videoUrl: '/videos/d1.mp4', gender: 'female' });
      await svc.join({ socketId: 's-alice', userId: 'alice' });
      await vi.waitFor(() => expect(eventsTo('s-alice', 'match_found')).toHaveLength(1), { timeout: 1000 });
      expect(eventsTo('s-alice', 'match_found')[0]!.payload).toMatchObject({ isDemo: true, initiator: true, peerId: 'demo_demo1', videoUrl: '/videos/d1.mp4', partner: { id: 'demo1' } });
      expect(await svc.session('s-alice')).toMatchObject({ isDemo: true, partnerUserId: 'demo1' });
      expect(await svc.queueSize()).toBe(0);

      now += 10_000;
      await svc.end('s-alice');
      expect(await MatchModel.countDocuments({ userId: 'alice', partnerId: 'demo1' })).toBe(1);
      expect(sent.some((s) => s.event === 'partner_skipped')).toBe(false); // nobody to notify
    });

    it('fall back through the relaxation ladder and use a default video', async () => {
      await mk('alice');
      await mk('demo-m', { isDemo: true, isOnline: false, gender: 'male' });
      await svc.join({ socketId: 's-alice', userId: 'alice' });
      await vi.waitFor(() => expect(eventsTo('s-alice', 'match_found')).toHaveLength(1), { timeout: 1000 });
      expect(eventsTo('s-alice', 'match_found')[0]!.payload.videoUrl).toBe('/videos/demo-male.mp4');
    });

    it('are skipped when a real user arrives first, and for VIP "super match"', async () => {
      await mk('alice');
      await mk('bob');
      await mk('demo1', { isDemo: true, isOnline: true });
      await mk('vipsuper', { ...vip });
      await svc.join({ socketId: 's-alice', userId: 'alice' });
      await svc.join({ socketId: 's-bob', userId: 'bob' });
      await new Promise((r) => setTimeout(r, 80));
      expect(sent.filter((s) => s.event === 'match_found' && s.payload.isDemo)).toHaveLength(0);

      await svc.join({ socketId: 's-vip', userId: 'vipsuper', superMatch: true });
      await new Promise((r) => setTimeout(r, 80));
      expect(eventsTo('s-vip', 'match_found')).toHaveLength(0); // waits for a real person
      expect(await svc.queueSize()).toBe(1);
    });

    it('leaving the queue cancels the pending demo offer', async () => {
      await mk('alice');
      await mk('demo1', { isDemo: true, isOnline: true });
      await svc.join({ socketId: 's-alice', userId: 'alice' });
      await svc.leave('s-alice');
      await new Promise((r) => setTimeout(r, 80));
      expect(sent).toHaveLength(0);
    });

    it('with no demo users the user simply keeps waiting', async () => {
      await mk('alice');
      await svc.join({ socketId: 's-alice', userId: 'alice' });
      await new Promise((r) => setTimeout(r, 80));
      expect(sent).toHaveLength(0);
      expect(await svc.queueSize()).toBe(1);
    });
  });

  it('refuses banned and unknown accounts', async () => {
    await mk('bad', { isBanned: true });
    await expect(svc.join({ socketId: 's1', userId: 'bad' })).rejects.toMatchObject({ status: 403, code: 'account_banned' });
    await expect(svc.join({ socketId: 's2', userId: 'ghost' })).rejects.toMatchObject({ status: 404 });
    expect(await svc.queueSize()).toBe(0);
  });

  it('a partner who was deleted while waiting is skipped, not matched', async () => {
    await mk('alice');
    await mk('bob');
    await svc.join({ socketId: 's-alice', userId: 'alice' });
    await UserModel.deleteOne({ id: 'alice' });
    expect((await svc.join({ socketId: 's-bob', userId: 'bob' })).status).toBe('waiting');
    expect(eventsTo('s-bob', 'match_found')).toHaveLength(0);
  });

  it('purgeStale removes abandoned queue entries', async () => {
    await mk('alice');
    await svc.join({ socketId: 's-alice', userId: 'alice', superMatch: false });
    now += 61_000;
    expect(await svc.purgeStale()).toBe(1);
  });
});
