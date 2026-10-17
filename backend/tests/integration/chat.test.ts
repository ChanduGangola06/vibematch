import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ContactMessageModel, ConversationModel, MatchModel, MessageModel, ReportModel, UserModel, syncIndexes,
} from '../../src/infra/db/models/index.js';
import { RecaptchaVerifier } from '../../src/modules/contact/captcha.js';
import { conversationKey } from '../../src/modules/chat/chat.service.js';
import { buildFullApp, registerUser, type FullApp } from '../helpers/full-app.js';
import { clearTestDb, countDbOps, startTestDb, stopTestDb } from '../helpers/mongo.js';

type U = Awaited<ReturnType<typeof registerUser>>;

describe('chat, history, reports, contact', () => {
  let f: FullApp;
  beforeAll(async () => {
    await startTestDb();
    await syncIndexes();
    f = buildFullApp({}, { demoReplyDelayMs: 10 });
  });
  afterAll(stopTestDb);
  beforeEach(async () => {
    await clearTestDb();
    await f.deps.cache.clear();
  });

  const send = (from: U, toId: string, text: string, extra: (r: ReturnType<ReturnType<FullApp['http']>['post']>) => void = () => {}) => {
    const r = f.http().post(`/api/v1/conversations/${toId}/messages`).set('Authorization', from.bearer);
    extra(r);
    return r.send({ text });
  };
  const get = (u: U, url: string) => f.http().get(url).set('Authorization', u.bearer);
  const mutual = async (a: U, b: U) => {
    await f.http().put(`/api/v1/users/${b.id}/follow`).set('Authorization', a.bearer);
    await f.http().put(`/api/v1/users/${a.id}/follow`).set('Authorization', b.bearer);
  };

  describe('permissions', () => {
    it('strangers cannot message each other', async () => {
      const a = await registerUser(f, 'alice');
      const b = await registerUser(f, 'bobby');
      const res = await send(a, b.id, 'hello?');
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('chat_not_allowed');
      expect(await MessageModel.countDocuments()).toBe(0);
    });

    it('mutual followers can; a one-way follow cannot', async () => {
      const a = await registerUser(f, 'carol');
      const b = await registerUser(f, 'dave');
      await f.http().put(`/api/v1/users/${b.id}/follow`).set('Authorization', a.bearer);
      expect((await send(a, b.id, 'hi')).status).toBe(403);
      await f.http().put(`/api/v1/users/${a.id}/follow`).set('Authorization', b.bearer);
      expect((await send(a, b.id, 'hi')).status).toBe(201);
      expect((await send(b, a.id, 'hi back')).status).toBe(201);
    });

    it('people who matched before can chat (also guests), and demo/admin accounts are always reachable', async () => {
      const a = await registerUser(f, 'erin');
      const g = (await f.http().post('/api/v1/auth/guest')).body.data;
      const guest: U = { id: g.user.id, accessToken: g.tokens.accessToken, refreshToken: g.tokens.refreshToken, bearer: `Bearer ${g.tokens.accessToken}`, user: g.user };
      expect((await send(guest, a.id, 'hi')).status).toBe(403);
      await MatchModel.create({ userId: a.id, partnerId: guest.id, type: 'video_chat' });
      expect((await send(guest, a.id, 'we matched!')).status).toBe(201);

      const demo = await UserModel.create({ username: 'demo_x', usernameLower: 'demo_x', name: 'Demo', isDemo: true });
      expect((await send(a, demo.id, 'hello demo')).status).toBe(201);
    });

    it('validates the receiver and the text; cannot spoof the sender', async () => {
      const a = await registerUser(f, 'frank');
      const b = await registerUser(f, 'gina');
      await mutual(a, b);
      expect((await send(a, a.id, 'self')).status).toBe(400);
      expect((await send(a, 'nobody', 'x')).status).toBe(404);
      expect((await send(a, b.id, '   ')).status).toBe(400); // whitespace-only is empty after cleaning
      expect((await send(a, b.id, 'x'.repeat(2001))).status).toBe(422);
      const spoof = await f.http().post(`/api/v1/conversations/${b.id}/messages`).set('Authorization', a.bearer).send({ text: 'hey', senderId: b.id });
      expect(spoof.status).toBe(422);
      await UserModel.updateOne({ id: b.id }, { isBanned: true });
      expect((await send(a, b.id, 'hi')).status).toBe(404);
      expect((await f.http().post(`/api/v1/conversations/${b.id}/messages`).send({ text: 'x' })).status).toBe(401);
    });

    it('strips control characters', async () => {
      const a = await registerUser(f, 'hank');
      const b = await registerUser(f, 'ivy');
      await mutual(a, b);
      const res = await send(a, b.id, 'hi\u0000 \u0007there\n');
      expect(res.body.data.text).toBe('hi there');
    });
  });

  describe('inbox & messages', () => {
    it('lists conversations with unread counts, newest first, with partner info', async () => {
      const me = await registerUser(f, 'jack');
      const p1 = await registerUser(f, 'kate');
      const p2 = await registerUser(f, 'liam');
      await mutual(me, p1);
      await mutual(me, p2);
      await send(p1, me.id, 'one');
      await send(p1, me.id, 'two');
      await send(me, p2.id, 'yo');
      await send(p2, me.id, 'hey!');

      const inbox = await get(me, '/api/v1/conversations');
      expect(inbox.status).toBe(200);
      expect(inbox.body.data.map((c: { partner: { username: string } }) => c.partner.username)).toEqual(['liam', 'kate']);
      expect(inbox.body.data[0]).toMatchObject({ unreadCount: 1, lastMessage: { text: 'hey!', senderId: p2.id, isGift: false } });
      expect(inbox.body.data[1]).toMatchObject({ unreadCount: 2, lastMessage: { text: 'two' } });
      expect(inbox.body.data[1].partner).toMatchObject({ isFollowing: true, isMutualFollow: true });
      expect(inbox.body.data[1].partner).not.toHaveProperty('email');
      expect((await get(me, '/api/v1/conversations/unread-count')).body.data.count).toBe(3);
      // the sender's own side has nothing unread
      expect((await get(p1, '/api/v1/conversations/unread-count')).body.data.count).toBe(0);
    });

    it('pages messages newest-first with a cursor and hides nothing from participants only', async () => {
      const a = await registerUser(f, 'mona');
      const b = await registerUser(f, 'nick');
      const outsider = await registerUser(f, 'oscar');
      await mutual(a, b);
      for (let i = 1; i <= 5; i++) await send(i % 2 ? a : b, i % 2 ? b.id : a.id, `m${i}`);

      const p1 = await get(a, `/api/v1/conversations/${b.id}/messages?limit=2`);
      expect(p1.body.data.map((m: { text: string }) => m.text)).toEqual(['m5', 'm4']);
      const p2 = await get(a, `/api/v1/conversations/${b.id}/messages?limit=2&cursor=${encodeURIComponent(p1.body.page.nextCursor)}`);
      const p3 = await get(a, `/api/v1/conversations/${b.id}/messages?limit=2&cursor=${encodeURIComponent(p2.body.page.nextCursor)}`);
      expect([...p1.body.data, ...p2.body.data, ...p3.body.data].map((m: { text: string }) => m.text)).toEqual(['m5', 'm4', 'm3', 'm2', 'm1']);
      expect(p3.body.page.hasMore).toBe(false);

      // BOLA: the conversation key is derived from the caller, so an outsider only ever sees *their own* thread with b
      const sneaky = await get(outsider, `/api/v1/conversations/${b.id}/messages`);
      expect(sneaky.body.data).toEqual([]);
      const sneaky2 = await get(outsider, `/api/v1/conversations/${a.id}/messages`);
      expect(sneaky2.body.data).toEqual([]);
    });

    it('read receipts: marking read clears my unread and flips isRead only for messages addressed to me', async () => {
      const a = await registerUser(f, 'pam');
      const b = await registerUser(f, 'quin');
      await mutual(a, b);
      await send(a, b.id, 'to b');
      await send(b, a.id, 'to a');
      const res = await f.http().post(`/api/v1/conversations/${b.id}/read`).set('Authorization', a.bearer);
      expect(res.body.data.updated).toBe(1);
      expect((await get(a, '/api/v1/conversations/unread-count')).body.data.count).toBe(0);
      expect((await get(b, '/api/v1/conversations/unread-count')).body.data.count).toBe(1);
      const msgs = (await get(a, `/api/v1/conversations/${b.id}/messages`)).body.data as { text: string; isRead: boolean }[];
      expect(Object.fromEntries(msgs.map((m) => [m.text, m.isRead]))).toEqual({ 'to a': true, 'to b': false });
    });

    it('clearing a chat only hides it for me, and it resurfaces on a new message', async () => {
      const a = await registerUser(f, 'rob');
      const b = await registerUser(f, 'sue');
      await mutual(a, b);
      await send(a, b.id, 'old');
      expect((await f.http().delete(`/api/v1/conversations/${b.id}`).set('Authorization', a.bearer)).status).toBe(204);
      expect((await get(a, '/api/v1/conversations')).body.data).toHaveLength(0);
      expect((await get(a, `/api/v1/conversations/${b.id}/messages`)).body.data).toHaveLength(0);
      expect((await get(b, `/api/v1/conversations/${a.id}/messages`)).body.data).toHaveLength(1); // other side untouched
      expect(await MessageModel.countDocuments()).toBe(1);

      await send(b, a.id, 'new');
      const after = await get(a, `/api/v1/conversations/${b.id}/messages`);
      expect(after.body.data.map((m: { text: string }) => m.text)).toEqual(['new']);
      expect((await get(a, '/api/v1/conversations')).body.data).toHaveLength(1);
    });

    it('deleting an account removes its conversations from the partner\'s inbox', async () => {
      const a = await registerUser(f, 'tom');
      const b = await registerUser(f, 'una');
      await mutual(a, b);
      await send(a, b.id, 'bye');
      await f.http().post('/api/v1/users/me/delete').set('Authorization', a.bearer).send({ password: 'Tr0ub4dor&3-horse' });
      expect((await get(b, '/api/v1/conversations')).body.data).toHaveLength(0);
      expect(await ConversationModel.countDocuments()).toBe(0);
    });

    it('send is idempotent with an Idempotency-Key (network retry does not duplicate)', async () => {
      const a = await registerUser(f, 'val');
      const b = await registerUser(f, 'walt');
      await mutual(a, b);
      const once = () => send(a, b.id, 'exactly once', (r) => void r.set('Idempotency-Key', 'msg-retry-0001'));
      const r1 = await once();
      const r2 = await once();
      expect(r2.headers['idempotent-replayed']).toBe('true');
      expect(r2.body.data.id).toBe(r1.body.data.id);
      expect(await MessageModel.countDocuments()).toBe(1);
    });

    it('conversationKey is symmetric', () => {
      expect(conversationKey('a', 'b')).toBe(conversationKey('b', 'a'));
    });
  });

  describe('demo profiles answer', () => {
    it('replies after a short delay and the reply shows up in the thread', async () => {
      const a = await registerUser(f, 'xavi');
      const demo = await UserModel.create({ username: 'demo_y', usernameLower: 'demo_y', name: 'Demo Y', isDemo: true });
      await send(a, demo.id, 'hello');
      await vi.waitFor(async () => {
        const msgs = (await get(a, `/api/v1/conversations/${demo.id}/messages`)).body.data as { senderId: string }[];
        expect(msgs.some((m) => m.senderId === demo.id)).toBe(true);
      }, { timeout: 2000 });
      expect(await MessageModel.countDocuments({ senderId: demo.id })).toBe(1); // exactly one reply, no loop
    });
  });

  describe('history', () => {
    it('lists past video chats with live partner data and relationship flags, without N+1', async () => {
      const me = await registerUser(f, 'yan');
      const p = await registerUser(f, 'zoe');
      await f.http().put(`/api/v1/users/${p.id}/follow`).set('Authorization', me.bearer);
      await MatchModel.create({ userId: me.id, partnerId: p.id, type: 'video_chat', durationSec: 75, partner: { name: 'Old name', username: 'old', avatar: '/old.png', country: 'X' } });
      await MatchModel.create({ userId: me.id, partnerId: 'gone-user', type: 'video_chat', durationSec: 5, partner: { name: 'Ghost', username: 'ghost', avatar: '/g.png', country: 'Y', age: 30 } });
      await MatchModel.create({ userId: p.id, partnerId: me.id, type: 'video_chat' }); // someone else's history

      const res = await get(me, '/api/v1/matches');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      const live = res.body.data.find((e: { partner: { id: string } }) => e.partner.id === p.id);
      expect(live).toMatchObject({ durationSec: 75, partner: { username: 'zoe', isFollowing: true, isMutualFollow: false, exists: true } });
      const gone = res.body.data.find((e: { partner: { id: string } }) => e.partner.id === 'gone-user');
      expect(gone.partner).toMatchObject({ name: 'Ghost', age: 30, exists: false });
    });

    it('viewed-me returns only views of my profile (the legacy endpoint queried the wrong type)', async () => {
      const me = await registerUser(f, 'amy');
      const v = await registerUser(f, 'ben');
      await f.http().post(`/api/v1/users/${me.id}/views`).set('Authorization', v.bearer);
      await MatchModel.create({ userId: me.id, partnerId: 'x', type: 'video_chat' });
      const res = await get(me, '/api/v1/matches/viewed-me');
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0]).toMatchObject({ type: 'view', partner: { username: 'ben' } });
      expect((await get(v, '/api/v1/matches/viewed-me')).body.data).toHaveLength(0);
    });

    it('pages with cursors and requires auth', async () => {
      const me = await registerUser(f, 'cam');
      await MatchModel.insertMany(Array.from({ length: 5 }, (_, i) => ({ userId: me.id, partnerId: `p${i}`, type: 'video_chat' })));
      const p1 = await get(me, '/api/v1/matches?limit=3');
      expect(p1.body.page.hasMore).toBe(true);
      const p2 = await get(me, `/api/v1/matches?limit=3&cursor=${encodeURIComponent(p1.body.page.nextCursor)}`);
      expect(p2.body.data).toHaveLength(2);
      expect((await f.http().get('/api/v1/matches')).status).toBe(401);
    });
  });

  describe('query efficiency (no N+1)', () => {
    it('inbox and history cost the same number of DB operations for 2 or 12 rows', async () => {
      const me = await registerUser(f, 'perf');
      const ops = async (url: string) => countDbOps(async () => { await get(me, url); });

      const partners: U[] = [];
      for (let i = 0; i < 12; i++) partners.push(await registerUser(f, `peer${i}`));
      for (const p of partners.slice(0, 2)) {
        await mutual(me, p);
        await send(p, me.id, 'hi');
        await MatchModel.create({ userId: me.id, partnerId: p.id, type: 'video_chat' });
      }
      const inboxSmall = await ops('/api/v1/conversations');
      const historySmall = await ops('/api/v1/matches');

      for (const p of partners.slice(2)) {
        await mutual(me, p);
        await send(p, me.id, 'hi');
        await MatchModel.create({ userId: me.id, partnerId: p.id, type: 'video_chat' });
      }
      expect(await ops('/api/v1/conversations')).toBe(inboxSmall);
      expect(await ops('/api/v1/matches')).toBe(historySmall);
      expect((await get(me, '/api/v1/conversations?limit=100')).body.data).toHaveLength(12);
    });
  });

  describe('reports', () => {
    it('takes the reporter from the token, validates, and de-duplicates open reports', async () => {
      const a = await registerUser(f, 'dee');
      const b = await registerUser(f, 'eve');
      const r1 = await f.http().post('/api/v1/reports').set('Authorization', a.bearer).send({ reportedUserId: b.id, reason: 'spam', details: 'sent links' });
      expect(r1.status).toBe(201);
      const r2 = await f.http().post('/api/v1/reports').set('Authorization', a.bearer).send({ reportedUserId: b.id, reason: 'spam again' });
      expect(r2.status).toBe(200);
      expect(r2.body.data.id).toBe(r1.body.data.id);
      expect(await ReportModel.countDocuments()).toBe(1);
      expect((await ReportModel.findOne().lean())).toMatchObject({ reporterId: a.id, reportedUserId: b.id, status: 'pending' });

      expect((await f.http().post('/api/v1/reports').set('Authorization', a.bearer).send({ reportedUserId: a.id, reason: 'me' })).status).toBe(400);
      expect((await f.http().post('/api/v1/reports').set('Authorization', a.bearer).send({ reportedUserId: 'ghost', reason: 'x1' })).status).toBe(404);
      expect((await f.http().post('/api/v1/reports').set('Authorization', a.bearer).send({ reportedUserId: b.id, reason: 'x1', reporterId: 'someone-else' })).status).toBe(422);
      expect((await f.http().post('/api/v1/reports').send({ reportedUserId: b.id, reason: 'anon' })).status).toBe(401);
    });
  });

  describe('contact form', () => {
    const body = { name: 'Zed', email: 'Zed@Example.com', message: 'Hello there, I have a question.' };
    it('stores the message (public, lower-cased e-mail, links the user when signed in)', async () => {
      expect((await f.http().post('/api/v1/contact').send(body)).status).toBe(201);
      const u = await registerUser(f, 'fan');
      await f.http().post('/api/v1/contact').set('Authorization', u.bearer).send(body);
      const rows = await ContactMessageModel.find().sort({ createdAt: 1 }).lean();
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ email: 'zed@example.com', status: 'unread' });
      expect(rows[1]?.userId).toBe(u.id);
    });

    it('validates input', async () => {
      for (const bad of [{ ...body, email: 'nope' }, { ...body, message: 'hi' }, { ...body, name: '' }, { ...body, status: 'read' }]) {
        expect((await f.http().post('/api/v1/contact').send(bad)).status).toBe(422);
      }
    });

    it('enforces reCAPTCHA when enabled: missing, failed, service down, and passing', async () => {
      const fetchImpl = vi.fn();
      const app = buildFullApp({}, {
        captcha: new RecaptchaVerifier({ get: async () => ({ enabled: true, secret: 's3cret' }) }, fetchImpl as never),
      });
      expect((await app.http().post('/api/v1/contact').send(body)).status).toBe(400);
      fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({ success: false })));
      expect((await app.http().post('/api/v1/contact').send({ ...body, recaptchaToken: 'bad' })).status).toBe(400);
      fetchImpl.mockRejectedValueOnce(new Error('network'));
      expect((await app.http().post('/api/v1/contact').send({ ...body, recaptchaToken: 'tok' })).status).toBe(503);
      fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({ success: true })));
      expect((await app.http().post('/api/v1/contact').send({ ...body, recaptchaToken: 'good' })).status).toBe(201);
      const sent = fetchImpl.mock.calls.at(-1)![1].body as URLSearchParams;
      expect(sent.get('secret')).toBe('s3cret');
      expect(sent.get('response')).toBe('good');
    });
  });
});
