import type { Socket } from 'socket.io-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  GemLedgerModel, GiftModel, MatchModel, MessageModel, UserModel, syncIndexes,
} from '../../src/infra/db/models/index.js';
import { registerUser } from '../helpers/full-app.js';
import { clearTestDb, startTestDb, stopTestDb } from '../helpers/mongo.js';
import { call, nextEvent, startSocketApp, stays, type SocketApp } from '../helpers/socket-app.js';

type U = Awaited<ReturnType<typeof registerUser>>;

describe('realtime (Socket.IO)', () => {
  let app: SocketApp;

  beforeAll(async () => {
    await startTestDb();
    await syncIndexes();
    app = await startSocketApp({}, { demoReplyDelayMs: 20, matchingConfig: { demoDelayMs: 40 } });
  });
  afterAll(async () => {
    await app.stop();
    await stopTestDb();
  });
  beforeEach(async () => {
    await clearTestDb();
    await app.deps.cache.clear();
    for (const c of app.clients) c.disconnect();
    app.clients.length = 0;
  });

  const user = (name: string, extra: Record<string, unknown> = {}) => registerUser(app, name, extra);
  const vipify = (u: U) => UserModel.updateOne({ id: u.id }, { vipExpiry: new Date(Date.now() + 86_400_000) });

  /** Two users, connected, and matched with each other. */
  async function matchedPair(a = 'alice', b = 'bobby') {
    const ua = await user(a);
    const ub = await user(b);
    const sa = await app.connect(ua.accessToken);
    const sb = await app.connect(ub.accessToken);
    const foundA = nextEvent(sa, 'match_found');
    const foundB = nextEvent(sb, 'match_found');
    await call(sa, 'join_queue', {});
    await call(sb, 'join_queue', {});
    return { ua, ub, sa, sb, foundA: await foundA, foundB: await foundB };
  }

  describe('handshake', () => {
    it('accepts a valid access token and rejects everything else with a reason', async () => {
      const u = await user('alice');
      expect((await app.connect(u.accessToken)).connected).toBe(true);
      expect((await app.connectFails(undefined)).data?.code).toBe('unauthorized');
      expect((await app.connectFails('garbage.token.here')).data?.code).toBe('token_invalid');
      expect((await app.connectFails(app.deps.tokens.signAccess({ sub: 'ghost', role: 'user', sid: 'x' }).token)).data?.code).toBe('account_not_found');
    });

    it('rejects banned users and revoked sessions', async () => {
      const banned = await user('mallory');
      await UserModel.updateOne({ id: banned.id }, { isBanned: true });
      await app.userStatus.invalidate(banned.id);
      expect((await app.connectFails(banned.accessToken)).data?.code).toBe('account_banned');

      const out = await user('olivia');
      await app.http().post('/api/v1/auth/logout').set('Authorization', out.bearer).send({});
      expect((await app.connectFails(out.accessToken)).data?.code).toBe('session_revoked');
    });

    it('accepts the token from the Authorization header too (non-browser clients)', async () => {
      const u = await user('alice');
      const { io } = await import('socket.io-client');
      const s = io(app.url, { extraHeaders: { Authorization: u.bearer }, transports: ['websocket'], reconnection: false, forceNew: true });
      app.clients.push(s);
      await new Promise<void>((res, rej) => { s.once('connect', () => res()); s.once('connect_error', rej); });
      expect(s.connected).toBe(true);
    });

    it('identity comes from the token: a client cannot claim another userId', async () => {
      const a = await user('alice');
      const b = await user('bobby');
      const sa = await app.connect(a.accessToken);
      const sb = await app.connect(b.accessToken);
      const found = nextEvent(sb, 'match_found');
      // alice tries to join "as" bob and with junk fields: unknown keys are rejected outright
      const spoof = await call(sa, 'join_queue', { userId: b.id });
      expect(spoof.ok).toBe(false);
      expect(spoof.error.code).toBe('validation_failed');
      await call(sa, 'join_queue', {});
      await call(sb, 'join_queue', {});
      expect((await found).partner.id).toBe(a.id);
    });
  });

  describe('matching & signalling', () => {
    it('pairs two users, relays signals only between peers, and the newcomer initiates', async () => {
      const { ua, ub, sa, sb, foundA, foundB } = await matchedPair();
      expect(foundB).toMatchObject({ initiator: true, partner: { id: ua.id, username: 'alice' } });
      expect(foundA).toMatchObject({ initiator: false, partner: { id: ub.id } });
      expect(JSON.stringify([foundA, foundB])).not.toMatch(/email|passwordHash|gems/);

      const offer = nextEvent(sa, 'signal');
      const ack = await call(sb, 'signal', { signal: { type: 'offer', sdp: 'v=0...' } });
      expect(ack).toEqual({ ok: true, delivered: true });
      expect(await offer).toMatchObject({ signal: { type: 'offer', sdp: 'v=0...' } });
    });

    it('a stranger cannot inject signals into somebody else\'s call', async () => {
      const { sa, sb } = await matchedPair();
      const eve = await user('eve');
      const se = await app.connect(eve.accessToken);
      const ack = await call(se, 'signal', { signal: { type: 'offer', sdp: 'evil' } });
      expect(ack).toEqual({ ok: true, delivered: false });
      expect(await stays(sa, 'signal')).toBe(true);
      expect(await stays(sb, 'signal')).toBe(true);
    });

    it('validates signal payloads (no addressing sockets, no junk types)', async () => {
      const { sb } = await matchedPair();
      expect((await call(sb, 'signal', { to: 'someone', signal: { type: 'offer' } })).ok).toBe(false);
      expect((await call(sb, 'signal', { signal: { type: 'nuke' } })).ok).toBe(false);
      expect((await call(sb, 'signal', { signal: { type: 'offer', extra: 1 } })).ok).toBe(false);
      expect((await call(sb, 'signal', 'string')).ok).toBe(false);
    });

    it('skip: partner is told, both can queue again, history is written for both', async () => {
      const { ua, ub, sa, sb } = await matchedPair();
      await new Promise((r) => setTimeout(r, 1100)); // ≥ 1 s so the call is recorded
      const skipped = nextEvent(sb, 'partner_skipped');
      expect((await call(sa, 'skip_match')).ok).toBe(true);
      expect(await skipped).toEqual({ reason: 'skipped' });
      expect(await MatchModel.countDocuments({ type: 'video_chat' })).toBe(2);
      expect(await MatchModel.exists({ userId: ua.id, partnerId: ub.id })).toBeTruthy();
      expect(await MatchModel.exists({ userId: ub.id, partnerId: ua.id })).toBeTruthy();
      // after the call ended, signalling is closed
      expect((await call(sb, 'signal', { signal: { type: 'offer' } })).delivered).toBe(false);
    });

    it('a dropped connection ends the call for the other side', async () => {
      const { sa, sb } = await matchedPair();
      const skipped = nextEvent(sb, 'partner_skipped');
      sa.disconnect();
      expect(await skipped).toEqual({ reason: 'disconnected' });
    });

    it('leave_queue stops waiting; filters of non-VIP users are ignored and reported', async () => {
      const u = await user('alice');
      const s = await app.connect(u.accessToken);
      const joined = await call(s, 'join_queue', { gender: 'male', country: 'Japan', superMatch: true });
      expect(joined).toMatchObject({ ok: true, status: 'waiting', applied: { gender: 'both', country: '', superMatch: false, filtersIgnored: true } });
      expect((await call(s, 'leave_queue')).ok).toBe(true);
      expect(await app.services.matching.queueSize()).toBe(0);
    });

    it('VIP filters work end-to-end', async () => {
      const vip = await user('vipman', { gender: 'male' });
      await vipify(vip);
      const fr = await user('fr1', { gender: 'female' });
      await UserModel.updateOne({ id: fr.id }, { country: 'France', countryCode: 'FR' });
      const sf = await app.connect(fr.accessToken);
      const sv = await app.connect(vip.accessToken);
      await call(sf, 'join_queue', {});
      const found = nextEvent(sv, 'match_found');
      const joined = await call(sv, 'join_queue', { gender: 'female', country: 'France' });
      expect(joined).toMatchObject({ status: 'matched', applied: { filtersIgnored: false } });
      expect((await found).partner.id).toBe(fr.id);
    });

    it('validation errors come back as acks and legacy match_error events', async () => {
      const u = await user('alice');
      const s = await app.connect(u.accessToken);
      const err = nextEvent(s, 'match_error');
      const ack = await call(s, 'join_queue', { gender: 'robot' });
      expect(ack).toMatchObject({ ok: false, error: { code: 'validation_failed' } });
      expect((await err).code).toBe('validation_failed');
    });
  });

  describe('chat & gifts inside a call', () => {
    it('messages are persisted, delivered to the peer in real time, and mirrored to the inbox channel', async () => {
      const { ua, ub, sa, sb } = await matchedPair();
      const live = nextEvent(sa, 'receive_message');
      const inbox = nextEvent(sa, 'new_message_notification');
      const ack = await call(sb, 'send_message', { text: 'hello from bob' });
      expect(ack).toMatchObject({ ok: true, message: { senderId: ub.id, receiverId: ua.id, text: 'hello from bob' } });
      expect(await live).toMatchObject({ from: ub.id, text: 'hello from bob', id: ack.message.id });
      expect(await inbox).toMatchObject({ id: ack.message.id });
      expect(await MessageModel.countDocuments({ text: 'hello from bob' })).toBe(1);
    });

    it('you can only message the peer you are matched with', async () => {
      const u = await user('alice');
      const s = await app.connect(u.accessToken);
      const r = await call(s, 'send_message', { text: 'anyone?' });
      expect(r).toMatchObject({ ok: false, error: { code: 'not_in_call' } });
      expect(await MessageModel.countDocuments()).toBe(0);
      expect((await call(s, 'send_message', { text: 'x', to: 'victim' })).ok).toBe(false);
      expect((await call(s, 'send_message', { text: '' })).ok).toBe(false);
    });

    it('gifts: price from the database, balance returned, ledger written, peer receives the gift message', async () => {
      const { ua, ub, sa, sb } = await matchedPair();
      const gift = await GiftModel.create({ name: 'Rose', price: 40, imagePath: '/images/gift/rose.svg' });
      const incoming = nextEvent(sa, 'receive_message');
      const ack = await call(sb, 'send_gift', { giftId: gift.id });
      expect(ack).toMatchObject({ ok: true, balance: 260, gift: { name: 'Rose', price: 40 }, message: { gift: { id: gift.id, cost: 40 } } });
      expect(await incoming).toMatchObject({ from: ub.id, gift: { name: 'Rose', cost: 40 } });
      expect((await UserModel.findOne({ id: ub.id }).lean())?.gems).toBe(260);
      expect(await GemLedgerModel.countDocuments({ userId: ub.id, reason: 'gift_sent' })).toBe(1);
      expect(ua.id).not.toBe(ub.id);

      const poor = await call(sb, 'send_gift', { giftId: (await GiftModel.create({ name: 'Yacht', price: 9999, imagePath: '/x.svg' })).id });
      expect(poor).toMatchObject({ ok: false, error: { code: 'insufficient_gems' } });
      expect((await call(sb, 'send_gift', { giftId: gift.id, price: 0 })).ok).toBe(false);
      expect((await UserModel.findOne({ id: ub.id }).lean())?.gems).toBe(260);
    });

    it('demo personas answer in-call messages', async () => {
      const u = await user('alice');
      await UserModel.create({ username: 'demo_x', usernameLower: 'demo_x', name: 'Demo X', isDemo: true, isOnline: true, videoUrl: '/videos/x.mp4' });
      const s = await app.connect(u.accessToken);
      const found = nextEvent(s, 'match_found');
      await call(s, 'join_queue', {});
      expect(await found).toMatchObject({ isDemo: true, videoUrl: '/videos/x.mp4' });
      const reply = nextEvent(s, 'receive_message');
      await call(s, 'send_message', { text: 'hi demo' });
      expect((await reply).text.length).toBeGreaterThan(0);
      expect((await call(s, 'signal', { signal: { type: 'offer' } })).delivered).toBe(false); // no WebRTC peer for a demo
    });
  });

  describe('server pushes', () => {
    it('REST messages and likes reach the target in real time', async () => {
      const a = await user('alice');
      const b = await user('bobby');
      await app.http().put(`/api/v1/users/${b.id}/follow`).set('Authorization', a.bearer);
      await app.http().put(`/api/v1/users/${a.id}/follow`).set('Authorization', b.bearer);
      const sb = await app.connect(b.accessToken);

      const note = nextEvent(sb, 'new_message_notification');
      await app.http().post(`/api/v1/conversations/${b.id}/messages`).set('Authorization', a.bearer).send({ text: 'dm!' });
      expect(await note).toMatchObject({ senderId: a.id, text: 'dm!' });

      const liked = nextEvent(sb, 'partner_liked');
      await app.http().put(`/api/v1/users/${b.id}/like`).set('Authorization', a.bearer);
      expect(await liked).toEqual({ newLikesCount: 1 });
    });

    it('banning a user, revoking a session and deleting an account drop their sockets', async () => {
      const a = await user('alice');
      const sa = await app.connect(a.accessToken);
      const dropped = new Promise<string>((r) => sa.once('disconnect', r));
      await app.deps.events.emitAndWait('user.banned', { userId: a.id, banned: true });
      expect(await dropped).toBe('io server disconnect');

      const b = await user('bobby');
      const sb = await app.connect(b.accessToken);
      const dropped2 = new Promise<string>((r) => sb.once('disconnect', r));
      await app.http().post('/api/v1/auth/logout').set('Authorization', b.bearer).send({});
      expect(await dropped2).toBe('io server disconnect');
    });

    it('tracks online status and broadcasts the online count', async () => {
      const a = await user('alice');
      const sa = await app.connect(a.accessToken);
      await new Promise((r) => setTimeout(r, 50));
      expect((await UserModel.findOne({ id: a.id }).lean())?.isOnline).toBe(true);
      expect((await app.http().get('/api/v1/stats/online')).body.data.onlineUsers).toBeGreaterThanOrEqual(1);
      sa.disconnect();
      await new Promise((r) => setTimeout(r, 100));
      expect((await UserModel.findOne({ id: a.id }).lean())?.isOnline).toBe(false);
    });
  });

  describe('abuse protection', () => {
    it('rate-limits noisy sockets per event without affecting others', async () => {
      // a dedicated server with tiny budgets
      const { attachRealtime } = await import('../../src/realtime/realtime.js');
      const base = (await import('../helpers/full-app.js')).buildFullApp();
      const http = (await import('node:http')).default;
      const server = http.createServer(base.app);
      const rt = attachRealtime(server, { ...base.realtimeDeps, budgets: { send_message: { max: 2, windowMs: 60_000 } } });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const port = (server.address() as { port: number }).port;
      const { io } = await import('socket.io-client');
      const u = await registerUser(base, 'spammer');
      const s: Socket = io(`http://127.0.0.1:${port}`, { auth: { token: u.accessToken }, transports: ['websocket'], forceNew: true });
      await new Promise<void>((r) => s.once('connect', () => r()));
      const results = [];
      for (let i = 0; i < 4; i++) results.push(await call(s, 'send_message', { text: `m${i}` }));
      // first two reach the handler (not in a call → 409), the rest are throttled
      expect(results.map((r) => r.error.code)).toEqual(['not_in_call', 'not_in_call', 'rate_limited', 'rate_limited']);
      expect(results[2].error.retryAfter).toBeGreaterThan(0);
      s.disconnect();
      await rt.close();
      server.closeAllConnections();
    });

    it('oversized payloads are refused by the transport', async () => {
      const u = await user('alice');
      const s = await app.connect(u.accessToken);
      const closed = new Promise<string>((r) => s.once('disconnect', r));
      s.emit('signal', { signal: { type: 'offer', sdp: 'x'.repeat(200_000) } });
      expect(['transport close', 'transport error', 'io server disconnect']).toContain(await closed);
    });
  });

  describe('ICE servers & stats endpoints', () => {
    it('requires authentication and returns STUN by default', async () => {
      expect((await app.http().get('/api/v1/webrtc/ice-servers')).status).toBe(401);
      const u = await user('alice');
      const res = await app.http().get('/api/v1/webrtc/ice-servers').set('Authorization', u.bearer);
      expect(res.body.data.iceServers).toEqual([{ urls: 'stun:stun.l.google.com:19302' }]);
    });
  });
});
