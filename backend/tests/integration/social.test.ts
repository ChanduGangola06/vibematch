import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalStorage } from '../../src/infra/storage/index.js';
import {
  FollowModel, LikeModel, MatchModel, MessageModel, NotificationModel, UserModel, GemLedgerModel, syncIndexes,
} from '../../src/infra/db/models/index.js';
import { buildFullApp, registerUser, strongPassword, type FullApp } from '../helpers/full-app.js';
import { clearTestDb, startTestDb, stopTestDb } from '../helpers/mongo.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);

describe('users, social graph, notifications, discover', () => {
  let f: FullApp;
  let dir: string;
  const pushSend = vi.fn().mockResolvedValue({ sent: 1, invalidTokens: [] });

  beforeAll(async () => {
    await startTestDb();
    await syncIndexes();
    dir = await mkdtemp(path.join(os.tmpdir(), 'vm-imgs-'));
    f = buildFullApp({}, {
      storage: { get: async () => new LocalStorage(dir, '/images') },
      push: { get: async () => ({ send: pushSend }) },
    });
  });
  afterAll(async () => {
    await stopTestDb();
    await rm(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await clearTestDb();
    await f.deps.cache.clear();
    pushSend.mockClear();
    await rm(path.join(dir, 'users'), { recursive: true, force: true });
  });

  const get = (url: string, bearer?: string) => (bearer ? f.http().get(url).set('Authorization', bearer) : f.http().get(url));
  const settle = () => new Promise((r) => setTimeout(r, 60)); // event listeners run async

  describe('profiles', () => {
    it('shows a public profile without private fields and with the viewer relationship', async () => {
      const a = await registerUser(f, 'alice');
      const b = await registerUser(f, 'bobby');
      await f.http().put(`/api/v1/users/${b.id}/follow`).set('Authorization', a.bearer);

      const anon = await get(`/api/v1/users/${a.id}`);
      expect(anon.status).toBe(200);
      expect(anon.body.data).toMatchObject({ id: a.id, username: 'alice', isFollowing: false, isMutualFollow: false });
      for (const secret of ['email', 'phone', 'address', 'gems', 'passwordHash', 'role', 'isBanned']) expect(anon.body.data).not.toHaveProperty(secret);

      const asA = await get(`/api/v1/users/${b.id}`, a.bearer);
      expect(asA.body.data).toMatchObject({ isFollowing: true, isMutualFollow: false, followersCount: 1 });
      await f.http().put(`/api/v1/users/${a.id}/follow`).set('Authorization', b.bearer);
      expect((await get(`/api/v1/users/${b.id}`, a.bearer)).body.data.isMutualFollow).toBe(true);
    });

    it('supports by-username (case-insensitive), the "me" alias, 404s and hides banned users', async () => {
      const a = await registerUser(f, 'carol');
      expect((await get('/api/v1/users/by-username/CAROL')).body.data.id).toBe(a.id);
      expect((await get('/api/v1/users/me', a.bearer)).body.data.id).toBe(a.id);
      expect((await get('/api/v1/users/me')).status).toBe(401);
      expect((await get('/api/v1/users/nope')).status).toBe(404);
      expect((await get('/api/v1/users/by-username/bad name')).status).toBe(422);
      await UserModel.updateOne({ id: a.id }, { isBanned: true });
      expect((await get(`/api/v1/users/${a.id}`)).status).toBe(404);
    });

    it('checks username availability', async () => {
      await registerUser(f, 'taken_one');
      const check = async (u: string) => (await get(`/api/v1/users/check-username?username=${encodeURIComponent(u)}`)).body.data;
      expect(await check('free_name')).toEqual({ available: true });
      expect(await check('TAKEN_ONE')).toEqual({ available: false, reason: 'taken' });
      expect(await check('a')).toEqual({ available: false, reason: 'invalid' });
      expect(await check('admin')).toEqual({ available: false, reason: 'reserved' });
    });
  });

  describe('editing my profile', () => {
    it('updates whitelisted fields only', async () => {
      const a = await registerUser(f, 'dave', { gender: 'male' });
      const ok = await f.http().patch('/api/v1/users/me').set('Authorization', a.bearer).send({ name: 'Dave D', bio: 'hi', age: 30, countryCode: 'us', country: 'United States', phone: '+1 (555) 010-0100' });
      expect(ok.status).toBe(200);
      expect(ok.body.data).toMatchObject({ name: 'Dave D', bio: 'hi', age: 30, countryCode: 'US' });
      for (const evil of [{ role: 'admin' }, { gems: 9999 }, { isBanned: false }, { email: 'x@y.z' }, { followersCount: 5 }, { avatar: 'https://tracker.example/p.gif' }, {}]) {
        expect((await f.http().patch('/api/v1/users/me').set('Authorization', a.bearer).send(evil)).status, JSON.stringify(evil)).toBe(422);
      }
      const row = await UserModel.findOne({ id: a.id }).lean();
      expect(row).toMatchObject({ role: 'user', gems: 300, followersCount: 0 });
    });

    it('changes username (unique, case-insensitive) and rejects duplicates', async () => {
      const a = await registerUser(f, 'erin');
      await registerUser(f, 'frank');
      expect((await f.http().patch('/api/v1/users/me').set('Authorization', a.bearer).send({ username: 'Frank' })).body.code).toBe('username_taken');
      const ok = await f.http().patch('/api/v1/users/me').set('Authorization', a.bearer).send({ username: 'Erin_New' });
      expect(ok.body.data.username).toBe('erin_new');
      expect((await get('/api/v1/users/by-username/erin_new')).status).toBe(200);
      expect((await get('/api/v1/users/by-username/erin')).status).toBe(404);
    });

    it('swaps a default avatar when gender changes but keeps uploaded photos', async () => {
      const a = await registerUser(f, 'gina', { gender: 'female' });
      const sw = await f.http().patch('/api/v1/users/me').set('Authorization', a.bearer).send({ gender: 'male' });
      expect(sw.body.data.avatar).toMatch(/^\/images\/avatars\/male-\d+\.svg$/);
      await f.http().post('/api/v1/users/me/avatar').set('Authorization', a.bearer).attach('avatar', PNG, { filename: 'me.png', contentType: 'image/png' });
      const keep = await f.http().patch('/api/v1/users/me').set('Authorization', a.bearer).send({ gender: 'female' });
      expect(keep.body.data.avatar).toMatch(/^\/images\/users\//);
    });

    it('guests cannot edit a profile', async () => {
      const g = (await f.http().post('/api/v1/auth/guest')).body.data;
      expect((await f.http().patch('/api/v1/users/me').set('Authorization', `Bearer ${g.tokens.accessToken}`).send({ bio: 'x' })).status).toBe(403);
    });
  });

  describe('avatar upload', () => {
    const upload = (bearer: string, buf: Buffer, filename: string, contentType: string) =>
      f.http().post('/api/v1/users/me/avatar').set('Authorization', bearer).attach('avatar', buf, { filename, contentType });

    it('stores a real image under a generated name and replaces the previous one', async () => {
      const a = await registerUser(f, 'hank');
      const first = await upload(a.bearer, PNG, '../../evil.png', 'image/png');
      expect(first.status).toBe(200);
      expect(first.body.data.avatar).toMatch(new RegExp(`^/images/users/${a.id}-[0-9a-f]{12}\\.png$`));
      expect(await readdir(path.join(dir, 'users'))).toHaveLength(1);
      const second = await upload(a.bearer, JPG, 'x.jpg', 'image/jpeg');
      expect(second.body.data.avatar).toMatch(/\.jpg$/);
      expect(await readdir(path.join(dir, 'users'))).toHaveLength(1); // old file removed
    });

    it('rejects polyglots: HTML/SVG/script posing as an image, by content not by name', async () => {
      const a = await registerUser(f, 'ivy');
      const html = Buffer.from('<html><script>alert(1)</script></html>'.padEnd(64, ' '));
      expect((await upload(a.bearer, html, 'a.png', 'image/png')).status).toBe(400);
      expect((await upload(a.bearer, Buffer.from('<svg onload=alert(1)></svg>'.padEnd(64, ' ')), 'a.svg', 'image/svg+xml')).status).toBe(400);
      expect((await upload(a.bearer, PNG, 'a.png', 'text/html')).status).toBe(400); // filtered by declared type
      expect((await UserModel.findOne({ id: a.id }).lean())?.avatar).toMatch(/^\/images\/avatars\//);
    });

    it('enforces the size limit and requires a file', async () => {
      const a = await registerUser(f, 'jack');
      const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]);
      expect((await upload(a.bearer, big, 'big.png', 'image/png')).status).toBe(413);
      expect((await f.http().post('/api/v1/users/me/avatar').set('Authorization', a.bearer)).status).toBe(400);
      expect((await f.http().post('/api/v1/users/me/avatar').attach('avatar', PNG, 'a.png')).status).toBe(401);
    });
  });

  describe('account deletion', () => {
    it('needs the password, erases personal data, and fixes other users\' counters', async () => {
      const a = await registerUser(f, 'kate');
      const b = await registerUser(f, 'liam');
      await f.http().put(`/api/v1/users/${b.id}/follow`).set('Authorization', a.bearer);
      await f.http().put(`/api/v1/users/${a.id}/follow`).set('Authorization', b.bearer);
      await f.http().put(`/api/v1/users/${b.id}/like`).set('Authorization', a.bearer);
      await MessageModel.create({ senderId: a.id, receiverId: b.id, conversationKey: 'k', text: 'hi' });
      await MatchModel.create({ userId: b.id, partnerId: a.id, type: 'video_chat' });

      expect((await f.http().post('/api/v1/users/me/delete').set('Authorization', a.bearer).send({})).status).toBe(400);
      expect((await f.http().post('/api/v1/users/me/delete').set('Authorization', a.bearer).send({ password: 'wrong-password-1' })).status).toBe(401);
      expect((await f.http().post('/api/v1/users/me/delete').set('Authorization', a.bearer).send({ password: strongPassword })).status).toBe(204);

      expect(await UserModel.countDocuments({ id: a.id })).toBe(0);
      expect(await FollowModel.countDocuments()).toBe(0);
      expect(await LikeModel.countDocuments()).toBe(0);
      expect(await MessageModel.countDocuments()).toBe(0);
      expect(await MatchModel.countDocuments()).toBe(0);
      expect(await GemLedgerModel.countDocuments({ userId: a.id })).toBe(1); // financial record retained
      expect(await UserModel.findOne({ id: b.id }).lean()).toMatchObject({ followersCount: 0, followingCount: 0, likesCount: 0 });
      expect((await get('/api/v1/auth/me', a.bearer)).status).toBe(401);
      expect((await f.http().post('/api/v1/auth/login').send({ identifier: 'kate', password: strongPassword })).status).toBe(401);
    });
  });

  describe('follow / like / view', () => {
    it('follow is idempotent and counters stay exact; unfollow likewise', async () => {
      const a = await registerUser(f, 'mona');
      const b = await registerUser(f, 'nick');
      const r1 = await f.http().put(`/api/v1/users/${b.id}/follow`).set('Authorization', a.bearer);
      const r2 = await f.http().put(`/api/v1/users/${b.id}/follow`).set('Authorization', a.bearer);
      expect(r1.body.data).toEqual({ isFollowing: true, followersCount: 1, followingCount: 1 });
      expect(r2.body.data.followersCount).toBe(1);
      expect(await FollowModel.countDocuments()).toBe(1);
      const un = await f.http().delete(`/api/v1/users/${b.id}/follow`).set('Authorization', a.bearer);
      expect(un.body.data).toEqual({ isFollowing: false, followersCount: 0, followingCount: 0 });
      await f.http().delete(`/api/v1/users/${b.id}/follow`).set('Authorization', a.bearer);
      expect((await UserModel.findOne({ id: b.id }).lean())?.followersCount).toBe(0); // never negative
    });

    it('concurrent follows from many requests create exactly one edge', async () => {
      const a = await registerUser(f, 'olga');
      const b = await registerUser(f, 'pete');
      await Promise.all(Array.from({ length: 8 }, () => f.http().put(`/api/v1/users/${b.id}/follow`).set('Authorization', a.bearer)));
      expect(await FollowModel.countDocuments()).toBe(1);
      expect((await UserModel.findOne({ id: b.id }).lean())?.followersCount).toBe(1);
    });

    it('rejects self-follow, unknown/banned targets, guests and anonymous callers', async () => {
      const a = await registerUser(f, 'quin');
      const b = await registerUser(f, 'rosa');
      expect((await f.http().put(`/api/v1/users/${a.id}/follow`).set('Authorization', a.bearer)).status).toBe(400);
      expect((await f.http().put('/api/v1/users/ghost/follow').set('Authorization', a.bearer)).status).toBe(404);
      await UserModel.updateOne({ id: b.id }, { isBanned: true });
      expect((await f.http().put(`/api/v1/users/${b.id}/follow`).set('Authorization', a.bearer)).status).toBe(404);
      const g = (await f.http().post('/api/v1/auth/guest')).body.data;
      expect((await f.http().put(`/api/v1/users/${a.id}/follow`).set('Authorization', `Bearer ${g.tokens.accessToken}`)).status).toBe(403);
      expect((await f.http().put(`/api/v1/users/${a.id}/follow`)).status).toBe(401);
    });

    it('likes are one per person: repeating does not inflate the counter', async () => {
      const a = await registerUser(f, 'sam');
      const b = await registerUser(f, 'tina');
      const c = await registerUser(f, 'uma');
      for (let i = 0; i < 3; i++) await f.http().put(`/api/v1/users/${c.id}/like`).set('Authorization', a.bearer);
      const second = await f.http().put(`/api/v1/users/${c.id}/like`).set('Authorization', b.bearer);
      expect(second.body.data).toEqual({ liked: true, likesCount: 2 });
      const un = await f.http().delete(`/api/v1/users/${c.id}/like`).set('Authorization', a.bearer);
      expect(un.body.data).toEqual({ liked: false, likesCount: 1 });
      await f.http().delete(`/api/v1/users/${c.id}/like`).set('Authorization', a.bearer);
      expect((await UserModel.findOne({ id: c.id }).lean())?.likesCount).toBe(1);
      expect((await f.http().put(`/api/v1/users/${a.id}/like`).set('Authorization', a.bearer)).status).toBe(400);
    });

    it('emits user.liked only for new likes', async () => {
      const a = await registerUser(f, 'vera');
      const b = await registerUser(f, 'walt');
      const seen: number[] = [];
      f.deps.events.on('user.liked', (e) => void seen.push(e.likesCount));
      await f.http().put(`/api/v1/users/${b.id}/like`).set('Authorization', a.bearer);
      await f.http().put(`/api/v1/users/${b.id}/like`).set('Authorization', a.bearer);
      await settle();
      expect(seen).toEqual([1]);
    });

    it('profile views are deduplicated per 24 h and ignore self / admin viewers', async () => {
      const a = await registerUser(f, 'xena');
      const b = await registerUser(f, 'yuri');
      for (let i = 0; i < 3; i++) expect((await f.http().post(`/api/v1/users/${b.id}/views`).set('Authorization', a.bearer)).status).toBe(204);
      await f.http().post(`/api/v1/users/${a.id}/views`).set('Authorization', a.bearer);
      expect(await MatchModel.countDocuments({ type: 'view', userId: b.id, partnerId: a.id })).toBe(1);
      expect(await MatchModel.countDocuments({ type: 'view', userId: a.id })).toBe(0);
      await MatchModel.collection.updateMany({ type: 'view' }, { $set: { createdAt: new Date(Date.now() - 25 * 3600_000) } }); // createdAt is immutable via mongoose
      await f.http().post(`/api/v1/users/${b.id}/views`).set('Authorization', a.bearer);
      expect(await MatchModel.countDocuments({ type: 'view' })).toBe(2);
    });
  });

  describe('followers / following lists', () => {
    it('paginates with cursors, without N+1, and marks my relationship to each entry', async () => {
      const star = await registerUser(f, 'star');
      const fans: Awaited<ReturnType<typeof registerUser>>[] = [];
      for (let i = 0; i < 5; i++) fans.push(await registerUser(f, `fan${i}`));
      for (const fan of fans) await f.http().put(`/api/v1/users/${star.id}/follow`).set('Authorization', fan.bearer);
      await f.http().put(`/api/v1/users/${fans[0]!.id}/follow`).set('Authorization', fans[1]!.bearer);

      const p1 = await get(`/api/v1/users/${star.id}/followers?limit=2`, fans[1]!.bearer);
      expect(p1.body.data).toHaveLength(2);
      expect(p1.body.page).toMatchObject({ limit: 2, hasMore: true });
      const p2 = await get(`/api/v1/users/${star.id}/followers?limit=2&cursor=${encodeURIComponent(p1.body.page.nextCursor)}`, fans[1]!.bearer);
      const p3 = await get(`/api/v1/users/${star.id}/followers?limit=2&cursor=${encodeURIComponent(p2.body.page.nextCursor)}`, fans[1]!.bearer);
      const ids = [...p1.body.data, ...p2.body.data, ...p3.body.data].map((u: { id: string }) => u.id);
      expect(new Set(ids).size).toBe(5);
      expect(p3.body.page.hasMore).toBe(false);
      const f0 = [...p1.body.data, ...p2.body.data, ...p3.body.data].find((u: { id: string }) => u.id === fans[0]!.id);
      expect(f0.isFollowing).toBe(true);

      expect((await get(`/api/v1/users/me/following`, fans[1]!.bearer)).body.data.map((u: { id: string }) => u.id).sort()).toEqual([star.id, fans[0]!.id].sort());
      expect((await get(`/api/v1/users/${star.id}/followers?cursor=tampered`)).status).toBe(400);
      expect((await get(`/api/v1/users/me/followers`)).status).toBe(401);
    });
  });

  describe('notifications', () => {
    it('a follow creates one notification (no spam on re-follow) and a push', async () => {
      const a = await registerUser(f, 'zed');
      const b = await registerUser(f, 'abby');
      await f.http().put('/api/v1/users/me/push-token').set('Authorization', b.bearer).send({ token: 'fcm-token-'.padEnd(30, 'x') });
      await f.http().put(`/api/v1/users/${b.id}/follow`).set('Authorization', a.bearer);
      await f.http().delete(`/api/v1/users/${b.id}/follow`).set('Authorization', a.bearer);
      await f.http().put(`/api/v1/users/${b.id}/follow`).set('Authorization', a.bearer);
      await settle();

      const list = await get('/api/v1/notifications', b.bearer);
      expect(list.body.data).toHaveLength(1);
      expect(list.body.data[0]).toMatchObject({ type: 'follow', isRead: false, from: { id: a.id, username: 'zed' } });
      expect((await get('/api/v1/notifications/unread-count', b.bearer)).body.data.count).toBe(1);
      expect(pushSend).toHaveBeenCalledTimes(1);
      expect(pushSend.mock.calls[0]![1]).toMatchObject({ title: 'New follower' });
    });

    it('is owner-scoped: you cannot read or mark someone else\'s notification', async () => {
      const a = await registerUser(f, 'cody');
      const b = await registerUser(f, 'dina');
      await f.http().put(`/api/v1/users/${b.id}/follow`).set('Authorization', a.bearer);
      await settle();
      const notif = (await get('/api/v1/notifications', b.bearer)).body.data[0];
      expect((await get('/api/v1/notifications', a.bearer)).body.data).toHaveLength(0);
      expect((await f.http().post(`/api/v1/notifications/${notif.id}/read`).set('Authorization', a.bearer)).status).toBe(404);
      expect((await get('/api/v1/notifications/unread-count', b.bearer)).body.data.count).toBe(1);
      expect((await f.http().post(`/api/v1/notifications/${notif.id}/read`).set('Authorization', b.bearer)).status).toBe(204);
      expect((await get('/api/v1/notifications/unread-count', b.bearer)).body.data.count).toBe(0);
      expect((await f.http().post(`/api/v1/notifications/${notif.id}/read`)).status).toBe(401);
    });

    it('read-all marks everything and returns the count', async () => {
      const t = await registerUser(f, 'target');
      for (let i = 0; i < 3; i++) await NotificationModel.create({ userId: t.id, type: 'system' });
      expect((await f.http().post('/api/v1/notifications/read-all').set('Authorization', t.bearer)).body.data.updated).toBe(3);
      expect((await get('/api/v1/notifications/unread-count', t.bearer)).body.data.count).toBe(0);
    });

    it('push tokens move between accounts, cap per user, prune invalid ones and can be revoked', async () => {
      const a = await registerUser(f, 'eli');
      const b = await registerUser(f, 'fay');
      const tok = 'device-token-'.padEnd(40, '1');
      await f.http().put('/api/v1/users/me/push-token').set('Authorization', a.bearer).send({ token: tok });
      await f.http().put('/api/v1/users/me/push-token').set('Authorization', b.bearer).send({ token: tok });
      expect((await UserModel.findOne({ id: a.id }).lean())?.fcmTokens).toEqual([]);
      expect((await UserModel.findOne({ id: b.id }).lean())?.fcmTokens).toEqual([tok]);
      for (let i = 0; i < 12; i++) await f.http().put('/api/v1/users/me/push-token').set('Authorization', b.bearer).send({ token: `t${i}`.padEnd(30, 'z') });
      expect((await UserModel.findOne({ id: b.id }).lean())?.fcmTokens).toHaveLength(10);
      await f.http().post('/api/v1/users/me/push-token/revoke').set('Authorization', b.bearer).send({ token: 't11'.padEnd(30, 'z') });
      expect((await UserModel.findOne({ id: b.id }).lean())?.fcmTokens).toHaveLength(9);

      pushSend.mockResolvedValueOnce({ sent: 0, invalidTokens: ['t10'.padEnd(30, 'z')] });
      await f.http().put(`/api/v1/users/${b.id}/follow`).set('Authorization', a.bearer);
      await settle();
      expect((await UserModel.findOne({ id: b.id }).lean())?.fcmTokens).not.toContain('t10'.padEnd(30, 'z'));
      expect((await f.http().put('/api/v1/users/me/push-token').set('Authorization', b.bearer).send({ token: 'short' })).status).toBe(422);
    });
  });

  describe('discover', () => {
    const mk = (username: string, extra: Record<string, unknown> = {}) =>
      UserModel.create({ username, usernameLower: username, name: username, ...extra });

    it('respects the configured mode and never leaks private fields', async () => {
      await Promise.all([
        mk('demo1', { isDemo: true, videoUrl: '/videos/a.mp4', email: 'x@y.z', emailLower: 'x@y.z' }),
        mk('real1', { role: 'user' }),
        mk('guest_1', { role: 'guest' }),
        mk('boss1', { role: 'admin' }),
        mk('banned1', { isBanned: true }),
      ]);
      const names = async (mode: 'demo_only' | 'real_only' | 'real_no_guest' | 'all') => {
        const app = buildFullApp({}, { discoverConfig: { mode: async () => mode } });
        const res = await app.http().get('/api/v1/discover');
        expect(res.status).toBe(200);
        return (res.body.data as { username: string }[]).map((u) => u.username).sort();
      };
      expect(await names('demo_only')).toEqual(['demo1']);
      expect(await names('real_only')).toEqual(['guest_1', 'real1']);
      expect(await names('real_no_guest')).toEqual(['real1']);
      expect(await names('all')).toEqual(['demo1', 'guest_1', 'real1']);

      const demo = (await buildFullApp().http().get('/api/v1/discover')).body.data[0];
      expect(demo.videoUrl).toBe('/videos/a.mp4');
      expect(demo).not.toHaveProperty('email');
    });

    it('excludes the caller and caps the grid at 24', async () => {
      await UserModel.insertMany(Array.from({ length: 40 }, (_, i) => ({ username: `d${i}`, usernameLower: `d${i}`, isDemo: true })));
      const me = await registerUser(f, 'viewer');
      await UserModel.updateOne({ id: me.id }, { isDemo: true });
      const app = buildFullApp({}, { discoverConfig: { mode: async () => 'demo_only' } });
      const res = await app.http().get('/api/v1/discover').set('Authorization', me.bearer);
      expect(res.body.data).toHaveLength(24);
      expect(res.body.data.some((u: { id: string }) => u.id === me.id)).toBe(false);
    });
  });
});
