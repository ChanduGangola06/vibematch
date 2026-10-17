import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LocalStorage } from '../../src/infra/storage/index.js';
import {
  AuditLogModel, ContactMessageModel, FollowModel, GemLedgerModel, GiftModel, MatchModel, MessageModel, PackModel,
  PurchaseModel, ReportModel, UserModel, VipPlanModel, syncIndexes,
} from '../../src/infra/db/models/index.js';
import { buildFullApp, makeAdmin, registerUser, strongPassword, type FullApp } from '../helpers/full-app.js';
import { clearTestDb, countDbOps, startTestDb, stopTestDb } from '../helpers/mongo.js';

type U = Awaited<ReturnType<typeof registerUser>>;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const GOOD_SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>');

describe('admin API', () => {
  let f: FullApp;
  let admin: U;
  let dir: string;

  beforeAll(async () => {
    await startTestDb();
    await syncIndexes();
    dir = await mkdtemp(path.join(os.tmpdir(), 'vm-admin-'));
  });
  afterAll(async () => {
    await stopTestDb();
    await rm(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await clearTestDb();
    await rm(path.join(dir, 'gift'), { recursive: true, force: true });
    f = buildFullApp({}, { storage: { get: async () => new LocalStorage(dir, '/images') } });
    admin = await makeAdmin(f);
  });

  const A = (req: any) => req.set('Authorization', admin.bearer);
  const get = (url: string) => A(f.http().get(`/api/v1${url}`));
  const post = (url: string, body: unknown = {}) => A(f.http().post(`/api/v1${url}`)).send(body as object);
  const patch = (url: string, body: unknown) => A(f.http().patch(`/api/v1${url}`)).send(body as object);
  const del = (url: string) => A(f.http().delete(`/api/v1${url}`));
  const put = (url: string, body: unknown) => A(f.http().put(`/api/v1${url}`)).send(body as object);

  // ===================================================================================== users
  describe('users', () => {
    it('lists real users only (not demo, not admins unless asked), with search, filters and paging', async () => {
      const a = await registerUser(f, 'alice_x', { name: 'Alice Wonder' });
      await registerUser(f, 'bobby_x');
      await UserModel.create({ username: 'demo9', usernameLower: 'demo9', isDemo: true });
      await UserModel.updateOne({ id: a.id }, { vipExpiry: new Date(Date.now() + 1e9) });
      const bob = await UserModel.findOne({ username: 'bobby_x' });
      await UserModel.updateOne({ id: bob!.id }, { isBanned: true });

      const all = await get('/admin/users');
      expect(all.body.data.map((u: { username: string }) => u.username).sort()).toEqual(['alice_x', 'bobby_x', 'boss']);
      expect(all.body.page).toMatchObject({ total: 3 });
      expect(JSON.stringify(all.body)).not.toMatch(/passwordHash|\$2[aby]\$/);

      expect((await get('/admin/users?q=wonder')).body.data).toHaveLength(1);
      expect((await get('/admin/users?q=.*')).body.data).toHaveLength(0); // regex is escaped
      expect((await get('/admin/users?banned=true')).body.data.map((u: { username: string }) => u.username)).toEqual(['bobby_x']);
      expect((await get('/admin/users?vip=true')).body.data.map((u: { username: string }) => u.username)).toEqual(['alice_x']);
      expect((await get('/admin/users?role=admin')).body.data.map((u: { username: string }) => u.username)).toEqual(['boss']);
      expect((await get('/admin/users?pageSize=2&page=2')).body.data).toHaveLength(1);
      expect((await get('/admin/users?pageSize=500')).status).toBe(422);
      expect((await get(`/admin/users/${a.id}`)).body.data).toMatchObject({ username: 'alice_x', isBanned: false });
      expect((await get('/admin/users/nope')).status).toBe(404);
    });

    it('edits profile fields (whitelist) and reports e-mail conflicts', async () => {
      const a = await registerUser(f, 'carol');
      const b = await registerUser(f, 'dave');
      const ok = await patch(`/admin/users/${a.id}`, { name: 'Carol C', phone: '+1 555', email: 'NEW@Example.com' });
      expect(ok.body.data).toMatchObject({ name: 'Carol C', phone: '+1 555', email: 'new@example.com' });
      expect((await patch(`/admin/users/${b.id}`, { email: 'new@example.com' })).body.code).toBe('email_taken');
      for (const bad of [{ role: 'admin' }, { gems: 99 }, { isBanned: true }, { passwordHash: 'x' }, {}]) {
        expect((await patch(`/admin/users/${a.id}`, bad)).status, JSON.stringify(bad)).toBe(422);
      }
      expect(await UserModel.findOne({ id: a.id }).lean()).toMatchObject({ role: 'user', gems: 300, isBanned: false });
    });

    it('gem adjustments go through the ledger (credit / debit / overdraft)', async () => {
      const a = await registerUser(f, 'erin');
      expect((await post(`/admin/users/${a.id}/gems`, { amount: 200, note: 'contest prize' })).body.data.balance).toBe(500);
      expect((await post(`/admin/users/${a.id}/gems`, { amount: -50 })).body.data.balance).toBe(450);
      expect((await post(`/admin/users/${a.id}/gems`, { amount: -9999 })).status).toBe(402);
      expect((await post(`/admin/users/${a.id}/gems`, { amount: 0 })).status).toBe(400);
      expect((await post(`/admin/users/${a.id}/gems`, { amount: 1.5 })).status).toBe(422);
      expect((await post('/admin/users/ghost/gems', { amount: 5 })).status).toBe(404);
      const rows = await GemLedgerModel.find({ userId: a.id, reason: 'admin_adjust' }).sort({ createdAt: 1 }).lean();
      expect(rows.map((r) => [r.delta, r.balanceAfter])).toEqual([[200, 500], [-50, 450]]);
      const audit = await AuditLogModel.find({ action: 'user.gems' }).lean();
      expect(audit[0]).toMatchObject({ actorId: admin.id, target: a.id, meta: { amount: 200, note: 'contest prize' } });
    });

    it('banning ends sessions at once, blocks login, can be lifted — and protects admins and yourself', async () => {
      const a = await registerUser(f, 'frank');
      expect((await post(`/admin/users/${a.id}/ban`)).body.data.isBanned).toBe(true);
      expect((await f.http().get('/api/v1/auth/me').set('Authorization', a.bearer)).status).toBe(401); // session revoked
      expect((await f.http().post('/api/v1/auth/login').send({ identifier: 'frank', password: strongPassword })).body.code).toBe('account_banned');
      expect((await f.http().post('/api/v1/auth/refresh').send({ refreshToken: a.refreshToken })).status).toBe(401);

      expect((await del(`/admin/users/${a.id}/ban`)).body.data.isBanned).toBe(false);
      expect((await f.http().post('/api/v1/auth/login').send({ identifier: 'frank', password: strongPassword })).status).toBe(200);

      expect((await post(`/admin/users/${admin.id}/ban`)).body.code).toBe('self_action');
      const other = await makeAdmin(f, 'boss2');
      expect((await post(`/admin/users/${other.id}/ban`)).body.code).toBe('admin_protected');
      expect((await del(`/admin/users/${other.id}`)).body.code).toBe('admin_protected');
      expect((await del(`/admin/users/${admin.id}`)).body.code).toBe('self_action');
    });

    it('role changes: promote, demote, never yourself or guests; the new role applies immediately', async () => {
      const a = await registerUser(f, 'gina');
      expect((await put(`/admin/users/${a.id}/role`, { role: 'admin' })).body.data.role).toBe('admin');
      await f.userStatus.invalidate(a.id);
      const relogin = await f.http().post('/api/v1/auth/login').send({ identifier: 'gina', password: strongPassword });
      expect((await f.http().get('/api/v1/admin/users').set('Authorization', `Bearer ${relogin.body.data.tokens.accessToken}`)).status).toBe(200);
      expect((await put(`/admin/users/${a.id}/role`, { role: 'user' })).body.data.role).toBe('user');
      await f.userStatus.invalidate(a.id);
      expect((await f.http().get('/api/v1/admin/users').set('Authorization', `Bearer ${relogin.body.data.tokens.accessToken}`)).status).toBe(401); // sessions were revoked on role change

      expect((await put(`/admin/users/${admin.id}/role`, { role: 'user' })).body.code).toBe('self_action');
      const g = (await f.http().post('/api/v1/auth/guest')).body.data.user;
      expect((await put(`/admin/users/${g.id}/role`, { role: 'admin' })).status).toBe(400);
      expect((await put(`/admin/users/${a.id}/role`, { role: 'superuser' })).status).toBe(422);
    });

    it('deleting a user erases their data and fixes counters', async () => {
      const a = await registerUser(f, 'hank');
      const b = await registerUser(f, 'ivy');
      await f.http().put(`/api/v1/users/${b.id}/follow`).set('Authorization', a.bearer);
      await MessageModel.create({ senderId: a.id, receiverId: b.id, conversationKey: 'k', text: 'x' });
      expect((await del(`/admin/users/${a.id}`)).status).toBe(204);
      expect(await UserModel.countDocuments({ id: a.id })).toBe(0);
      expect(await FollowModel.countDocuments()).toBe(0);
      expect(await MessageModel.countDocuments()).toBe(0);
      expect((await UserModel.findOne({ id: b.id }).lean())?.followersCount).toBe(0);
      expect((await del(`/admin/users/${a.id}`)).status).toBe(404);
      expect(await AuditLogModel.countDocuments({ action: 'user.delete', target: a.id })).toBe(1);
    });
  });

  // ============================================================================== demo users
  describe('demo users', () => {
    const body = { name: 'Sofia', gender: 'female', age: 24, country: 'Spain', countryCode: 'es', videoUrl: '/videos/sofia.mp4' };

    it('CRUD, and the discover grid reflects edits immediately', async () => {
      const created = await post('/admin/demo-users', body);
      expect(created.status).toBe(201);
      expect(created.body.data).toMatchObject({ name: 'Sofia', isDemo: true, countryCode: 'ES', videoUrl: '/videos/sofia.mp4', gems: 0 });
      const id = created.body.data.id as string;
      expect((await f.http().get('/api/v1/discover')).body.data.map((u: { id: string }) => u.id)).toContain(id);

      expect((await patch(`/admin/demo-users/${id}`, { name: 'Sofía', isOnline: false })).body.data).toMatchObject({ name: 'Sofía', isOnline: false });
      expect((await f.http().get('/api/v1/discover')).body.data.find((u: { id: string }) => u.id === id).name).toBe('Sofía');
      expect((await get('/admin/demo-users')).body.page.total).toBe(1);

      expect((await del(`/admin/demo-users/${id}`)).status).toBe(204);
      expect((await f.http().get('/api/v1/discover')).body.data).toHaveLength(0);
      expect((await del(`/admin/demo-users/${id}`)).status).toBe(404);
    });

    it('validates input and cannot touch real users through the demo endpoints', async () => {
      for (const bad of [{ ...body, age: 12 }, { ...body, videoUrl: 'javascript:alert(1)' }, { ...body, videoUrl: 'http://insecure/x.mp4' }, { ...body, role: 'admin' }, { ...body, avatar: 'https://tracker/p.gif' }, { name: 'x' }]) {
        expect((await post('/admin/demo-users', bad)).status, JSON.stringify(bad)).toBe(422);
      }
      const real = await registerUser(f, 'realuser');
      expect((await patch(`/admin/demo-users/${real.id}`, { name: 'hijacked' })).status).toBe(404);
      expect((await del(`/admin/demo-users/${real.id}`)).status).toBe(404);
      expect(await UserModel.countDocuments({ id: real.id })).toBe(1);
    });
  });

  // ============================================================================ moderation
  describe('reports & mailbox', () => {
    it('lists reports with both parties resolved in a fixed number of queries (no N+1)', async () => {
      const users: U[] = [];
      for (let i = 0; i < 12; i++) users.push(await registerUser(f, `rep${i}`));
      const make = (n: number) => ReportModel.insertMany(Array.from({ length: n }, (_, i) => ({ reporterId: users[i]!.id, reportedUserId: users[(i + 1) % 12]!.id, reason: 'spam' })));
      await make(2);
      await get('/admin/reports'); // warm the auth caches so only the endpoint's own queries are counted
      const small = await countDbOps(async () => void (await get('/admin/reports')));
      await ReportModel.deleteMany({});
      await make(12);
      const big = await countDbOps(async () => void (await get('/admin/reports')));
      expect(big).toBe(small);
      const res = await get('/admin/reports?pageSize=50');
      expect(res.body.data[0]).toMatchObject({ reason: 'spam', status: 'pending', reporter: { exists: true }, reported: { exists: true } });
    });

    it('status workflow, filter, delete; tolerates deleted users', async () => {
      const a = await registerUser(f, 'rpa');
      const r = await ReportModel.create({ reporterId: a.id, reportedUserId: 'gone', reason: 'abuse' });
      const listed = await get('/admin/reports');
      expect(listed.body.data[0].reported).toMatchObject({ id: 'gone', name: 'Deleted user', exists: false });
      expect((await patch(`/admin/reports/${r.id}`, { status: 'resolved' })).body.data.status).toBe('resolved');
      expect((await get('/admin/reports?status=pending')).body.data).toHaveLength(0);
      expect((await get('/admin/reports?status=resolved')).body.data).toHaveLength(1);
      expect((await patch(`/admin/reports/${r.id}`, { status: 'weird' })).status).toBe(422);
      expect((await del(`/admin/reports/${r.id}`)).status).toBe(204);
      expect((await del(`/admin/reports/${r.id}`)).status).toBe(404);
    });

    it('mailbox: list, unread count, mark read, delete', async () => {
      const m1 = await ContactMessageModel.create({ name: 'A', email: 'a@x.co', message: 'hello one' });
      await ContactMessageModel.create({ name: 'B', email: 'b@x.co', message: 'hello two' });
      expect((await get('/admin/mailbox/unread-count')).body.data.count).toBe(2);
      expect((await patch(`/admin/mailbox/${m1.id}`, { status: 'read' })).body.data.status).toBe('read');
      expect((await get('/admin/mailbox/unread-count')).body.data.count).toBe(1);
      expect((await get('/admin/mailbox?status=unread')).body.data).toHaveLength(1);
      expect((await del(`/admin/mailbox/${m1.id}`)).status).toBe(204);
      expect((await patch('/admin/mailbox/zzz', { status: 'read' })).status).toBe(404);
    });
  });

  // ================================================================================= catalog
  describe('gifts, packs and VIP plans', () => {
    const upload = (url: string, method: 'post' | 'patch', fields: Record<string, string>, file?: { buf: Buffer; name: string; type: string }) => {
      const r = A(f.http()[method](`/api/v1${url}`));
      for (const [k, v] of Object.entries(fields)) r.field(k, v);
      if (file) r.attach('giftImage', file.buf, { filename: file.name, contentType: file.type });
      return r;
    };

    it('creates a gift with an uploaded image; the public catalogue updates; edits replace the file; delete cleans up', async () => {
      const made = await upload('/admin/gifts', 'post', { name: 'Red Rose', price: '40' }, { buf: PNG, name: '../x.png', type: 'image/png' });
      expect(made.status).toBe(201);
      expect(made.body.data).toMatchObject({ name: 'Red Rose', price: 40, image: expect.stringMatching(/^\/images\/gift\/red-rose-[0-9a-f]{10}\.png$/) });
      expect(await readdir(path.join(dir, 'gift'))).toHaveLength(1);
      expect((await f.http().get('/api/v1/gifts')).body.data[0]).toMatchObject({ name: 'Red Rose', price: 40 });

      const id = made.body.data.id as string;
      await f.deps.cache.clear();
      const edited = await upload(`/admin/gifts/${id}`, 'patch', { price: '55' }, { buf: GOOD_SVG, name: 'rose.svg', type: 'image/svg+xml' });
      expect(edited.body.data).toMatchObject({ price: 55, image: expect.stringMatching(/\.svg$/) });
      expect(await readdir(path.join(dir, 'gift'))).toHaveLength(1); // old png removed
      expect((await f.http().get('/api/v1/gifts')).body.data[0].price).toBe(55);

      expect((await del(`/admin/gifts/${id}`)).status).toBe(204);
      expect(await readdir(path.join(dir, 'gift'))).toHaveLength(0);
      expect(await GiftModel.countDocuments()).toBe(0);
      expect((await del(`/admin/gifts/${id}`)).status).toBe(404);
    });

    it('rejects bad gift uploads: scripted SVG, HTML renamed to .png, wrong type, no file, bad price', async () => {
      const evilSvgs = [
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
        '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>',
        '<svg xmlns="http://www.w3.org/2000/svg"><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>',
        '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div/></foreignObject></svg>',
        '<!DOCTYPE svg [<!ENTITY x "boom">]><svg xmlns="http://www.w3.org/2000/svg"/>',
      ];
      for (const svg of evilSvgs) {
        expect((await upload('/admin/gifts', 'post', { name: 'Evil', price: '1' }, { buf: Buffer.from(svg), name: 'e.svg', type: 'image/svg+xml' })).status, svg.slice(0, 40)).toBe(400);
      }
      expect((await upload('/admin/gifts', 'post', { name: 'x', price: '1' }, { buf: Buffer.from('<html><script>alert(1)</script></html>'.padEnd(64)), name: 'a.png', type: 'image/png' })).status).toBe(400);
      expect((await upload('/admin/gifts', 'post', { name: 'x', price: '1' }, { buf: PNG, name: 'a.exe', type: 'application/octet-stream' })).status).toBe(400);
      expect((await upload('/admin/gifts', 'post', { name: 'x', price: '1' })).status).toBe(400);
      expect((await upload('/admin/gifts', 'post', { name: 'x', price: 'free' }, { buf: PNG, name: 'a.png', type: 'image/png' })).status).toBe(400);
      expect(await GiftModel.countDocuments()).toBe(0);
      expect(await readdir(path.join(dir, 'gift')).catch(() => [])).toHaveLength(0);
    });

    it('packs: CRUD with validation; the public store reflects changes at once', async () => {
      const made = await post('/admin/packs', { name: 'Starter', price: 4.99, gems: 500, googlePayId: 'gems_500' });
      expect(made.status).toBe(201);
      const id = made.body.data.id as string;
      expect((await f.http().get('/api/v1/packs')).body.data).toHaveLength(1);
      expect((await patch(`/admin/packs/${id}`, { price: 5.99, popular: true })).body.data).toMatchObject({ price: 5.99, popular: true, gems: 500 });
      expect((await f.http().get('/api/v1/packs')).body.data[0]).toMatchObject({ price: 5.99 });
      expect((await get('/admin/packs')).body.data[0]).not.toHaveProperty('_id');
      for (const bad of [{ name: 'x', price: -1, gems: 5 }, { name: 'x', price: 1, gems: 0 }, { name: 'x', price: 1, gems: 5, stripeId: 'y' }, { price: 1 }]) {
        expect((await post('/admin/packs', bad)).status, JSON.stringify(bad)).toBe(422);
      }
      expect((await del(`/admin/packs/${id}`)).status).toBe(204);
      expect((await f.http().get('/api/v1/packs')).body.data).toHaveLength(0);
      expect((await patch('/admin/packs/nope', { price: 1 })).status).toBe(404);
    });

    it('VIP plans: CRUD with validation and cache invalidation', async () => {
      const made = await post('/admin/vip-plans', { name: 'Month', priceGems: 500, durationDays: 30 });
      const id = made.body.data.id as string;
      expect((await f.http().get('/api/v1/vip-plans')).body.data).toHaveLength(1);
      expect((await patch(`/admin/vip-plans/${id}`, { priceGems: 450 })).body.data.priceGems).toBe(450);
      expect((await f.http().get('/api/v1/vip-plans')).body.data[0].priceGems).toBe(450);
      expect((await post('/admin/vip-plans', { name: 'Bad', priceGems: 5, durationDays: 0 })).status).toBe(422);
      expect((await del(`/admin/vip-plans/${id}`)).status).toBe(204);
      expect(await VipPlanModel.countDocuments()).toBe(0);
      expect(await PackModel.countDocuments()).toBe(0);
    });
  });

  // ================================================================================ reporting
  describe('purchases, metrics, audit log', () => {
    it('lists, filters and streams purchases (NDJSON) with constant memory shape', async () => {
      const u = await registerUser(f, 'buyer');
      await PurchaseModel.insertMany([
        { userId: u.id, username: 'buyer', provider: 'stripe', providerTxnId: 's1', packId: 'p', packName: 'S', gems: 10, amount: 4.99, currency: 'USD' },
        { userId: u.id, username: 'buyer', provider: 'paypal', providerTxnId: 'p1', packId: 'p', packName: 'S', gems: 10, amount: 9.99, currency: 'USD' },
        { userId: 'other', username: 'o', provider: 'stripe', providerTxnId: 's2', packId: 'p', packName: 'S', gems: 10, amount: 1, currency: 'EUR' },
      ]);
      const list = await get('/admin/purchases?provider=stripe');
      expect(list.body.data).toHaveLength(2);
      expect(list.body.data[0]).toHaveProperty('providerTxnId');
      expect((await get(`/admin/purchases?userId=${u.id}`)).body.page.total).toBe(2);
      expect((await get('/admin/purchases?provider=bitcoin')).status).toBe(422);

      const exp = await get('/admin/purchases/export?provider=stripe').buffer(true).parse((r: NodeJS.ReadableStream, cb: (e: Error | null, b: unknown) => void) => {
        let d = '';
        r.on('data', (c: Buffer) => (d += c));
        r.on('end', () => cb(null, d));
      });
      expect(exp.headers['content-type']).toContain('application/x-ndjson');
      expect(exp.headers['content-disposition']).toContain('purchases.ndjson');
      const lines = (exp.body as string).trim().split('\n').map((l) => JSON.parse(l));
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatchObject({ provider: 'stripe', gems: 10 });
      expect(await AuditLogModel.countDocuments({ action: 'purchases.export' })).toBe(1);
    });

    it('dashboard metrics aggregate the requested period', async () => {
      const a = await registerUser(f, 'mia1');
      const b = await registerUser(f, 'mia2');
      await UserModel.updateOne({ id: a.id }, { vipExpiry: new Date(Date.now() + 1e9) });
      await UserModel.create({ username: 'dm', usernameLower: 'dm', isDemo: true });
      await MatchModel.create({ userId: a.id, partnerId: b.id, type: 'video_chat' });
      await MessageModel.create({ senderId: a.id, receiverId: b.id, conversationKey: 'k', text: 'x' });
      await GemLedgerModel.create({ userId: a.id, delta: -40, balanceAfter: 260, reason: 'gift_sent', refType: 'gift', refId: 'g1' });
      await GemLedgerModel.create({ userId: a.id, delta: -10, balanceAfter: 250, reason: 'gift_sent', refType: 'gift', refId: 'g2' });
      await PurchaseModel.create({ userId: a.id, provider: 'stripe', providerTxnId: 't', packId: 'p', gems: 5, amount: 4.5, currency: 'USD' });
      await PurchaseModel.create({ userId: a.id, provider: 'stripe', providerTxnId: 't2', packId: 'p', gems: 5, amount: 5.5, currency: 'USD' });

      const m = (await get('/admin/metrics?period=today')).body.data;
      expect(m).toMatchObject({
        period: 'today', newUsers: 3, totalUsers: 3, videoChats: 1, messagesSent: 1, giftsSent: 2, gemsSpentOnGifts: 50,
        activeVips: 1, purchases: 2, revenue: [{ currency: 'USD', amount: 10 }],
      });
      const yesterday = (await get('/admin/metrics?period=yesterday')).body.data;
      expect(yesterday).toMatchObject({ newUsers: 0, videoChats: 0, giftsSent: 0, purchases: 0, revenue: [] });
      expect((await get('/admin/metrics?period=alltime')).body.data.newUsers).toBe(3);
      expect((await get('/admin/metrics?period=forever')).status).toBe(422);
      expect((await get('/admin/metrics')).body.data.period).toBe('today');
    });

    it('audit log records privileged actions with the actor and filters by actor/action', async () => {
      const u = await registerUser(f, 'aud');
      await post(`/admin/users/${u.id}/gems`, { amount: 5 });
      await post(`/admin/users/${u.id}/ban`);
      const all = await get('/admin/audit-log');
      expect(all.body.data.map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(['user.gems', 'user.ban']));
      expect(all.body.data[0]).toMatchObject({ actorId: admin.id, actorName: 'boss', ip: expect.any(String) });
      expect((await get('/admin/audit-log?action=user.ban')).body.data).toHaveLength(1);
      expect((await get(`/admin/audit-log?actorId=${admin.id}`)).body.page.total).toBeGreaterThanOrEqual(2);
      expect((await get('/admin/audit-log?actorId=nobody')).body.data).toHaveLength(0);
    });

    it('changing my e-mail needs my password', async () => {
      expect((await put('/admin/profile/email', { email: 'new@x.co', password: 'wrong-pass-123' })).status).toBe(401);
      expect((await put('/admin/profile/email', { email: 'new@x.co', password: strongPassword })).body.data.email).toBe('new@x.co');
      await registerUser(f, 'taken');
      expect((await put('/admin/profile/email', { email: 'taken@example.com', password: strongPassword })).body.code).toBe('email_taken');
      expect((await put('/admin/profile/email', { email: 'not-an-email', password: strongPassword })).status).toBe(422);
    });
  });
});
