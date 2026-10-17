import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  GemLedgerModel, GiftModel, MessageModel, NotificationModel, PackModel, UserModel, VipPlanModel, syncIndexes,
} from '../../src/infra/db/models/index.js';
import { buildFullApp, registerUser, type FullApp } from '../helpers/full-app.js';
import { clearTestDb, startTestDb, stopTestDb } from '../helpers/mongo.js';

type U = Awaited<ReturnType<typeof registerUser>>;
let n = 0;
const key = () => `idem-key-${String(++n).padStart(8, '0')}`;

describe('gifts & VIP', () => {
  let f: FullApp;
  beforeAll(async () => {
    await startTestDb();
    await syncIndexes();
    f = buildFullApp();
  });
  afterAll(stopTestDb);
  beforeEach(async () => {
    await clearTestDb();
    await f.deps.cache.clear();
  });

  const gems = async (u: U) => (await UserModel.findOne({ id: u.id }).lean())!.gems;
  const mutual = async (a: U, b: U) => {
    await f.http().put(`/api/v1/users/${b.id}/follow`).set('Authorization', a.bearer);
    await f.http().put(`/api/v1/users/${a.id}/follow`).set('Authorization', b.bearer);
  };
  const sendGift = (from: U, giftId: string, receiverId: string, idem = key()) =>
    f.http().post(`/api/v1/gifts/${giftId}/send`).set('Authorization', from.bearer).set('Idempotency-Key', idem).send({ receiverId });
  const mkGift = (price: number, name = 'Rose') => GiftModel.create({ name, price, imagePath: '/images/gift/rose.svg' });

  describe('gifts', () => {
    it('lists the catalogue publicly (cheapest first) with a cache header', async () => {
      await mkGift(50, 'Cake');
      await mkGift(5, 'Rose');
      const res = await f.http().get('/api/v1/gifts');
      expect(res.status).toBe(200);
      expect(res.body.data.map((g: { name: string }) => g.name)).toEqual(['Rose', 'Cake']);
      expect(res.body.data[0]).toEqual({ id: expect.any(String), name: 'Rose', price: 5, image: '/images/gift/rose.svg' });
      expect(res.headers['cache-control']).toBe('public, max-age=60');
    });

    it('charges the price from the database, stores a gift message and a ledger row, and notifies', async () => {
      const a = await registerUser(f, 'alice');
      const b = await registerUser(f, 'bobby');
      await mutual(a, b);
      const g = await mkGift(40);
      const res = await sendGift(a, g.id, b.id);
      expect(res.status).toBe(201);
      expect(res.body.data.balance).toBe(260);
      expect(res.body.data.message).toMatchObject({ senderId: a.id, receiverId: b.id, text: '', gift: { id: g.id, name: 'Rose', cost: 40 } });
      expect(await gems(a)).toBe(260);
      expect(await gems(b)).toBe(300); // the receiver is not paid (gems are a sink)

      const ledger = await GemLedgerModel.find({ userId: a.id, reason: 'gift_sent' }).lean();
      expect(ledger).toEqual([expect.objectContaining({ delta: -40, balanceAfter: 260, refType: 'gift', refId: res.body.data.message.id })]);
      await new Promise((r) => setTimeout(r, 60));
      expect(await NotificationModel.countDocuments({ userId: b.id, type: 'gift' })).toBe(1);
      const inbox = await f.http().get('/api/v1/conversations').set('Authorization', b.bearer);
      expect(inbox.body.data[0].lastMessage).toMatchObject({ isGift: true, text: 'Rose' });
    });

    it('ignores any client-supplied price / cost fields (v1 trusted `cost`)', async () => {
      const a = await registerUser(f, 'carol');
      const b = await registerUser(f, 'dave');
      await mutual(a, b);
      const g = await mkGift(40);
      const res = await f.http().post(`/api/v1/gifts/${g.id}/send`).set('Authorization', a.bearer).set('Idempotency-Key', key()).send({ receiverId: b.id, cost: 0, price: 0 });
      expect(res.status).toBe(422);
      expect(await gems(a)).toBe(300);
    });

    it('rejects insufficient gems without side effects', async () => {
      const a = await registerUser(f, 'erin');
      const b = await registerUser(f, 'frank');
      await mutual(a, b);
      const g = await mkGift(301);
      const res = await sendGift(a, g.id, b.id);
      expect(res.status).toBe(402);
      expect(res.body.code).toBe('insufficient_gems');
      expect(await gems(a)).toBe(300);
      expect(await MessageModel.countDocuments()).toBe(0);
    });

    it('is idempotent: a retried request charges once and replays the response', async () => {
      const a = await registerUser(f, 'gina');
      const b = await registerUser(f, 'hank');
      await mutual(a, b);
      const g = await mkGift(10);
      const id = key();
      const r1 = await sendGift(a, g.id, b.id, id);
      const r2 = await sendGift(a, g.id, b.id, id);
      expect(r2.headers['idempotent-replayed']).toBe('true');
      expect(r2.body.data.message.id).toBe(r1.body.data.message.id);
      expect(await gems(a)).toBe(290);
      expect(await MessageModel.countDocuments()).toBe(1);
      expect((await f.http().post(`/api/v1/gifts/${g.id}/send`).set('Authorization', a.bearer).send({ receiverId: b.id })).status).toBe(400); // key required
    });

    it('concurrent gifts can never overdraw', async () => {
      const a = await registerUser(f, 'ivy');
      const b = await registerUser(f, 'jack');
      await mutual(a, b);
      const g = await mkGift(100);
      const results = await Promise.all(Array.from({ length: 6 }, () => sendGift(a, g.id, b.id)));
      expect(results.filter((r) => r.status === 201)).toHaveLength(3);
      expect(results.filter((r) => r.status === 402)).toHaveLength(3);
      expect(await gems(a)).toBe(0);
      expect(await MessageModel.countDocuments()).toBe(3);
    });

    it('validates gift, receiver and permission', async () => {
      const a = await registerUser(f, 'kate');
      const b = await registerUser(f, 'liam');
      const g = await mkGift(1);
      expect((await sendGift(a, g.id, b.id)).body.code).toBe('chat_not_allowed'); // strangers
      await mutual(a, b);
      expect((await sendGift(a, 'nope', b.id)).status).toBe(404);
      expect((await sendGift(a, g.id, 'ghost')).status).toBe(404);
      expect((await sendGift(a, g.id, a.id)).status).toBe(400);
      await UserModel.updateOne({ id: b.id }, { isBanned: true });
      expect((await sendGift(a, g.id, b.id)).status).toBe(404);
      expect(await gems(a)).toBe(300);
    });

    it('guests cannot send gifts; anonymous gets 401', async () => {
      const b = await registerUser(f, 'mona');
      const g = await mkGift(1);
      const guest = (await f.http().post('/api/v1/auth/guest')).body.data;
      const res = await f.http().post(`/api/v1/gifts/${g.id}/send`).set('Authorization', `Bearer ${guest.tokens.accessToken}`).set('Idempotency-Key', key()).send({ receiverId: b.id });
      expect(res.status).toBe(403);
      expect((await f.http().post(`/api/v1/gifts/${g.id}/send`).set('Idempotency-Key', key()).send({ receiverId: b.id })).status).toBe(401);
    });

    it('refunds the debit when the message cannot be stored (compensation)', async () => {
      const a = await registerUser(f, 'nick');
      const b = await registerUser(f, 'olga');
      await mutual(a, b);
      const g = await mkGift(25);
      const { ChatService } = await import('../../src/modules/chat/chat.service.js');
      const orig = ChatService.prototype.send;
      ChatService.prototype.send = async () => { throw new Error('db hiccup'); };
      try {
        const res = await sendGift(a, g.id, b.id);
        expect(res.status).toBe(500);
      } finally {
        ChatService.prototype.send = orig;
      }
      expect(await gems(a)).toBe(300);
      const rows = await GemLedgerModel.find({ userId: a.id }).sort({ createdAt: 1 }).lean();
      expect(rows.map((r) => r.reason)).toEqual(['signup_bonus', 'gift_sent', 'refund']);
      // the failed attempt released its idempotency key, so a retry works
    });

    it('catalogue edits show up after a content.changed event (cache invalidation)', async () => {
      await mkGift(5, 'Rose');
      expect((await f.http().get('/api/v1/gifts')).body.data).toHaveLength(1);
      await mkGift(6, 'Heart');
      expect((await f.http().get('/api/v1/gifts')).body.data).toHaveLength(1); // cached
      await f.deps.events.emitAndWait('content.changed', { kind: 'gifts' });
      expect((await f.http().get('/api/v1/gifts')).body.data).toHaveLength(2);
    });
  });

  describe('packs & VIP', () => {
    it('lists packs and plans publicly', async () => {
      await PackModel.create({ name: 'Big', price: 9.99, gems: 1000 });
      await PackModel.create({ name: 'Small', price: 0.99, gems: 50, popular: true });
      await VipPlanModel.create({ name: 'Month', priceGems: 500, durationDays: 30 });
      const packs = await f.http().get('/api/v1/packs');
      expect(packs.body.data.map((p: { name: string }) => p.name)).toEqual(['Small', 'Big']);
      expect(packs.body.data[0]).toMatchObject({ price: 0.99, gems: 50, popular: true });
      expect((await f.http().get('/api/v1/vip-plans')).body.data[0]).toMatchObject({ name: 'Month', priceGems: 500, durationDays: 30 });
    });

    it('subscribing charges gems and sets the expiry; renewing extends from the current expiry', async () => {
      const u = await registerUser(f, 'pam');
      const plan = await VipPlanModel.create({ name: 'Week', priceGems: 100, durationDays: 7 });
      const sub = () => f.http().post(`/api/v1/vip-plans/${plan.id}/subscribe`).set('Authorization', u.bearer).set('Idempotency-Key', key());

      const t0 = Date.now();
      const first = await sub();
      expect(first.status).toBe(201);
      expect(first.body.data.balance).toBe(200);
      const exp1 = new Date(first.body.data.vipExpiry).getTime();
      expect(exp1 - t0).toBeGreaterThan(7 * 86_400_000 - 5000);
      expect(exp1 - t0).toBeLessThan(7 * 86_400_000 + 5000);

      const second = await sub();
      expect(new Date(second.body.data.vipExpiry).getTime() - exp1).toBe(7 * 86_400_000); // stacked, not reset
      const me = await f.http().get('/api/v1/auth/me').set('Authorization', u.bearer);
      expect(me.body.data).toMatchObject({ isVip: true, gems: 100 });
      expect(await GemLedgerModel.countDocuments({ userId: u.id, reason: 'vip_subscribe' })).toBe(2);
    });

    it('an expired VIP restarts from now; insufficient gems changes nothing', async () => {
      const u = await registerUser(f, 'quin');
      const plan = await VipPlanModel.create({ name: 'Day', priceGems: 100, durationDays: 1 });
      await UserModel.updateOne({ id: u.id }, { vipExpiry: new Date(Date.now() - 10 * 86_400_000) });
      const r = await f.http().post(`/api/v1/vip-plans/${plan.id}/subscribe`).set('Authorization', u.bearer).set('Idempotency-Key', key());
      expect(new Date(r.body.data.vipExpiry).getTime() - Date.now()).toBeLessThan(86_400_000 + 5000);

      const dear = await VipPlanModel.create({ name: 'Year', priceGems: 5000, durationDays: 365 });
      const before = await UserModel.findOne({ id: u.id }).lean();
      const fail = await f.http().post(`/api/v1/vip-plans/${dear.id}/subscribe`).set('Authorization', u.bearer).set('Idempotency-Key', key());
      expect(fail.status).toBe(402);
      const after = await UserModel.findOne({ id: u.id }).lean();
      expect(after!.gems).toBe(before!.gems);
      expect(after!.vipExpiry!.getTime()).toBe(before!.vipExpiry!.getTime());
    });

    it('is idempotent and race-safe; validates plan and key', async () => {
      const u = await registerUser(f, 'rosa');
      const plan = await VipPlanModel.create({ name: 'Wk', priceGems: 100, durationDays: 7 });
      const id = key();
      const call = () => f.http().post(`/api/v1/vip-plans/${plan.id}/subscribe`).set('Authorization', u.bearer).set('Idempotency-Key', id);
      const [r1, r2] = [await call(), await call()];
      expect(r2.headers['idempotent-replayed']).toBe('true');
      expect(r2.body.data).toEqual(r1.body.data);
      expect(await UserModel.findOne({ id: u.id }).lean().then((x) => x!.gems)).toBe(200);

      const many = await Promise.all(Array.from({ length: 5 }, () => f.http().post(`/api/v1/vip-plans/${plan.id}/subscribe`).set('Authorization', u.bearer).set('Idempotency-Key', key())));
      expect(many.filter((r) => r.status === 201)).toHaveLength(2); // only 200 gems were left
      expect(await UserModel.findOne({ id: u.id }).lean().then((x) => x!.gems)).toBe(0);

      expect((await f.http().post('/api/v1/vip-plans/nope/subscribe').set('Authorization', u.bearer).set('Idempotency-Key', key())).status).toBe(404);
      expect((await f.http().post(`/api/v1/vip-plans/${plan.id}/subscribe`).set('Authorization', u.bearer)).status).toBe(400);
      expect((await f.http().post(`/api/v1/vip-plans/${plan.id}/subscribe`).set('Idempotency-Key', key())).status).toBe(401);
    });
  });
});
