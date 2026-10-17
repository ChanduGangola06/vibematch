import { createHmac, generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GemLedgerModel, PackModel, PurchaseModel, UserModel, syncIndexes } from '../../src/infra/db/models/index.js';
import type { PaymentConfig } from '../../src/modules/payments/payment.types.js';
import { PaymentProviderFactory } from '../../src/modules/payments/provider.factory.js';
import type { StripeLike, StripeSession } from '../../src/modules/payments/providers/stripe.provider.js';
import { buildFullApp, registerUser, type FullApp } from '../helpers/full-app.js';
import { clearTestDb, startTestDb, stopTestDb } from '../helpers/mongo.js';

type U = Awaited<ReturnType<typeof registerUser>>;

// ---- fake gateways ------------------------------------------------------------------------------
class FakeStripe implements StripeLike {
  sessions = new Map<string, StripeSession>();
  created: Record<string, any>[] = [];
  private n = 0;
  checkout = {
    sessions: {
      create: async (params: Record<string, any>) => {
        const id = `cs_test_${++this.n}`;
        this.created.push(params);
        const item = params.line_items[0].price_data;
        this.sessions.set(id, { id, payment_status: 'unpaid', amount_total: item.unit_amount, currency: item.currency, metadata: params.metadata });
        return { id, url: `https://checkout.stripe.test/${id}` };
      },
      retrieve: async (id: string) => {
        const s = this.sessions.get(id);
        if (!s) throw new Error('No such session');
        return s;
      },
    },
  };
  webhooks = {
    constructEvent: (payload: Buffer, sig: string, secret: string) => {
      if (sig !== `valid:${secret}`) throw new Error('bad signature');
      return JSON.parse(payload.toString());
    },
  };
  pay(id: string) {
    this.sessions.get(id)!.payment_status = 'paid';
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('payments', () => {
  let f: FullApp;
  let stripe: FakeStripe;
  let fetchMock: ReturnType<typeof vi.fn>;
  let config: PaymentConfig;
  const purchased: unknown[] = [];

  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const serviceAccount = JSON.stringify({
    client_email: 'play@test.iam', private_key: rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  });

  beforeAll(async () => {
    await startTestDb();
    await syncIndexes();
  });
  afterAll(stopTestDb);

  beforeEach(async () => {
    await clearTestDb();
    stripe = new FakeStripe();
    fetchMock = vi.fn();
    config = {
      currency: 'USD',
      stripe: { secretKey: 'sk_test_x', webhookSecret: 'whsec_1' },
      paypal: { clientId: 'cid', clientSecret: 'csec', env: 'sandbox', webhookId: 'WH-1' },
      razorpay: { keyId: 'rzp_key', keySecret: 'rzp_secret', webhookSecret: 'rzp_wh', currency: 'INR' },
      google: { serviceAccountJson: serviceAccount, packageName: 'com.example.app' },
      apple: { sharedSecret: 'apple-secret' },
    };
    f = buildFullApp(
      { CORS_ORIGINS: 'http://app.test' },
      {
        paymentConfig: { get: async () => config },
        paymentFactory: new PaymentProviderFactory(fetchMock as never, () => stripe),
      },
    );
    purchased.length = 0;
    f.deps.events.on('purchase.completed', (e) => void purchased.push(e));
  });

  const pack = (over: Record<string, unknown> = {}) =>
    PackModel.create({ name: 'Starter', price: 4.99, gems: 500, googlePayId: 'gems_500', applePayId: 'com.app.gems500', ...over });
  const gemsOf = async (u: U) => (await UserModel.findOne({ id: u.id }).lean())!.gems;
  const post = (u: U | null, url: string, body: unknown = {}) => {
    const r = f.http().post(url);
    if (u) r.set('Authorization', u.bearer);
    return r.send(body as object);
  };
  const settle = () => new Promise((r) => setTimeout(r, 40));

  // ================================================================ Stripe
  describe('Stripe', () => {
    it('checkout: price and gems come from the database; the session is bound to the buyer', async () => {
      const u = await registerUser(f, 'alice');
      const p = await pack();
      const res = await post(u, '/api/v1/payments/stripe/checkout', { packId: p.id });
      expect(res.status).toBe(201);
      expect(res.body.data).toEqual({ url: expect.stringContaining('https://checkout.stripe.test/'), orderId: 'cs_test_1' });

      const sent = stripe.created[0]!;
      expect(sent.line_items[0].price_data).toMatchObject({ unit_amount: 499, currency: 'usd' });
      expect(sent.metadata).toMatchObject({ userId: u.id, packId: p.id, gems: '500', price: '4.99' });
      expect(sent.success_url).toBe('http://localhost:3000/payment-callback?status=success&method=stripe&session_id={CHECKOUT_SESSION_ID}');
    });

    it('rejects client-supplied prices/gems, unknown packs, anonymous and guest callers', async () => {
      const u = await registerUser(f, 'bobby');
      const p = await pack();
      expect((await post(u, '/api/v1/payments/stripe/checkout', { packId: p.id, price: 0.01, gemsToAdd: 99999 })).status).toBe(422);
      expect((await post(u, '/api/v1/payments/stripe/checkout', { packId: 'nope' })).status).toBe(404);
      expect((await post(null, '/api/v1/payments/stripe/checkout', { packId: p.id })).status).toBe(401);
      const g = (await f.http().post('/api/v1/auth/guest')).body.data;
      const guest = await f.http().post('/api/v1/payments/stripe/checkout').set('Authorization', `Bearer ${g.tokens.accessToken}`).send({ packId: p.id });
      expect(guest.status).toBe(403);
      expect(stripe.created).toHaveLength(0);
    });

    it('returnUrl must be on the allow-list (open-redirect guard)', async () => {
      const u = await registerUser(f, 'carol');
      const p = await pack();
      const ok = await post(u, '/api/v1/payments/stripe/checkout', { packId: p.id, returnUrl: 'http://app.test/shop?x=1' });
      expect(ok.status).toBe(201);
      expect(stripe.created[0]!.success_url).toContain('http://app.test/payment-callback');
      const bad = await post(u, '/api/v1/payments/stripe/checkout', { packId: p.id, returnUrl: 'https://evil.example/steal' });
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe('return_url_not_allowed');
    });

    it('reports an unconfigured gateway clearly', async () => {
      const u = await registerUser(f, 'dave');
      const p = await pack();
      delete config.stripe;
      const res = await post(u, '/api/v1/payments/stripe/checkout', { packId: p.id });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('provider_not_configured');
    });

    async function paidSession(u: U) {
      const p = await pack();
      const co = await post(u, '/api/v1/payments/stripe/checkout', { packId: p.id });
      stripe.pay(co.body.data.orderId);
      return co.body.data.orderId as string;
    }

    it('verify credits the gems once, records purchase + ledger, and is idempotent', async () => {
      const u = await registerUser(f, 'erin');
      const sid = await paidSession(u);
      const first = await post(u, '/api/v1/payments/stripe/verify', { sessionId: sid });
      expect(first.status).toBe(201);
      expect(first.body.data).toMatchObject({ balance: 800, gems: 500, alreadyProcessed: false });
      const again = await post(u, '/api/v1/payments/stripe/verify', { sessionId: sid });
      expect(again.status).toBe(200);
      expect(again.body.data).toMatchObject({ balance: 800, alreadyProcessed: true, purchaseId: first.body.data.purchaseId });

      expect(await gemsOf(u)).toBe(800);
      expect(await PurchaseModel.countDocuments()).toBe(1);
      expect(await PurchaseModel.findOne().lean()).toMatchObject({ userId: u.id, provider: 'stripe', providerTxnId: sid, gems: 500, amount: 4.99, currency: 'USD', status: 'completed' });
      expect(await GemLedgerModel.find({ userId: u.id, reason: 'purchase' }).lean()).toEqual([expect.objectContaining({ delta: 500, balanceAfter: 800 })]);
      await settle();
      expect(purchased).toHaveLength(1);
    });

    it('unpaid sessions and unknown sessions credit nothing', async () => {
      const u = await registerUser(f, 'frank');
      const p = await pack();
      const co = await post(u, '/api/v1/payments/stripe/checkout', { packId: p.id });
      const unpaid = await post(u, '/api/v1/payments/stripe/verify', { sessionId: co.body.data.orderId });
      expect(unpaid.status).toBe(402);
      expect(unpaid.body.code).toBe('payment_not_completed');
      expect((await post(u, '/api/v1/payments/stripe/verify', { sessionId: 'cs_unknown_zzz' })).status).toBe(400);
      expect(await gemsOf(u)).toBe(300);
    });

    it('IDOR: someone else\'s paid session cannot be claimed (v1 let the caller\'s token win)', async () => {
      const victim = await registerUser(f, 'gina');
      const thief = await registerUser(f, 'hank');
      const sid = await paidSession(victim);
      const res = await post(thief, '/api/v1/payments/stripe/verify', { sessionId: sid });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('payment_owner_mismatch');
      expect(await gemsOf(thief)).toBe(300);
      expect(await PurchaseModel.countDocuments()).toBe(0);
      // and the rightful owner can still claim it
      expect((await post(victim, '/api/v1/payments/stripe/verify', { sessionId: sid })).status).toBe(201);
    });

    it('detects amount tampering and foreign sessions', async () => {
      const u = await registerUser(f, 'ivy');
      const sid = await paidSession(u);
      stripe.sessions.get(sid)!.amount_total = 1; // paid 1 cent for a 4.99 pack
      const res = await post(u, '/api/v1/payments/stripe/verify', { sessionId: sid });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('amount_mismatch');

      stripe.sessions.set('cs_foreign', { id: 'cs_foreign', payment_status: 'paid', amount_total: 100, currency: 'usd', metadata: {} });
      expect((await post(u, '/api/v1/payments/stripe/verify', { sessionId: 'cs_foreign' })).status).toBe(400);
      expect(await gemsOf(u)).toBe(300);
    });

    it('concurrent verifies of the same payment credit exactly once', async () => {
      const u = await registerUser(f, 'jack');
      const sid = await paidSession(u);
      const results = await Promise.all(Array.from({ length: 6 }, () => post(u, '/api/v1/payments/stripe/verify', { sessionId: sid })));
      expect(results.every((r) => r.status === 200 || r.status === 201)).toBe(true);
      expect(results.filter((r) => r.body.data.alreadyProcessed === false)).toHaveLength(1);
      expect(await gemsOf(u)).toBe(800);
      expect(await PurchaseModel.countDocuments()).toBe(1);
      expect(await GemLedgerModel.countDocuments({ reason: 'purchase' })).toBe(1);
    });

    it('self-heals when a previous attempt stored the purchase but never credited', async () => {
      const u = await registerUser(f, 'kate');
      const sid = await paidSession(u);
      await PurchaseModel.create({ id: 'txn_crashed', userId: u.id, provider: 'stripe', providerTxnId: sid, packId: 'x', packName: 'Starter', gems: 500, amount: 4.99, currency: 'USD' });
      expect(await gemsOf(u)).toBe(300);
      const res = await post(u, '/api/v1/payments/stripe/verify', { sessionId: sid });
      expect(res.body.data).toMatchObject({ balance: 800, alreadyProcessed: false, purchaseId: 'txn_crashed' });
      expect((await post(u, '/api/v1/payments/stripe/verify', { sessionId: sid })).body.data.alreadyProcessed).toBe(true);
      expect(await gemsOf(u)).toBe(800);
    });

    it('webhook: valid signature credits the buyer; replays and the later verify do not double-credit', async () => {
      const u = await registerUser(f, 'liam');
      const sid = await paidSession(u);
      const event = JSON.stringify({ type: 'checkout.session.completed', data: { object: stripe.sessions.get(sid) } });
      const hook = (sig: string, body = event) => f.http().post('/api/v1/payments/webhooks/stripe').set('Stripe-Signature', sig).set('Content-Type', 'application/json').send(body);

      expect((await hook('valid:whsec_1')).body.data).toEqual({ received: true, processed: true });
      expect((await hook('valid:whsec_1')).status).toBe(200);
      expect(await gemsOf(u)).toBe(800);
      expect((await post(u, '/api/v1/payments/stripe/verify', { sessionId: sid })).body.data.alreadyProcessed).toBe(true);
      expect(await gemsOf(u)).toBe(800);
      await settle();
      expect(purchased).toHaveLength(1);
    });

    it('webhook: bad / missing signature is rejected, unrelated events are acknowledged and ignored', async () => {
      const u = await registerUser(f, 'mona');
      const sid = await paidSession(u);
      const event = JSON.stringify({ type: 'checkout.session.completed', data: { object: stripe.sessions.get(sid) } });
      const bad = await f.http().post('/api/v1/payments/webhooks/stripe').set('Stripe-Signature', 'forged').set('Content-Type', 'application/json').send(event);
      expect(bad.status).toBe(400);
      expect((await f.http().post('/api/v1/payments/webhooks/stripe').set('Content-Type', 'application/json').send(event)).status).toBe(400);
      expect(await gemsOf(u)).toBe(300);
      const ignored = await f.http().post('/api/v1/payments/webhooks/stripe').set('Stripe-Signature', 'valid:whsec_1').set('Content-Type', 'application/json').send(JSON.stringify({ type: 'customer.created', data: { object: {} } }));
      expect(ignored.body.data).toEqual({ received: true, processed: false });
      delete config.stripe!.webhookSecret;
      expect((await f.http().post('/api/v1/payments/webhooks/stripe').set('Stripe-Signature', 'x').set('Content-Type', 'application/json').send(event)).status).toBe(400);
    });

    it('webhook for a deleted account is acknowledged (no retry storm) and flagged', async () => {
      const u = await registerUser(f, 'nick');
      const sid = await paidSession(u);
      await UserModel.deleteOne({ id: u.id });
      const event = JSON.stringify({ type: 'checkout.session.completed', data: { object: stripe.sessions.get(sid) } });
      const res = await f.http().post('/api/v1/payments/webhooks/stripe').set('Stripe-Signature', 'valid:whsec_1').set('Content-Type', 'application/json').send(event);
      expect(res.status).toBe(200);
      expect(res.body.data.processed).toBe(false);
      expect(await PurchaseModel.countDocuments()).toBe(0);
    });
  });

  // ================================================================ PayPal
  describe('PayPal', () => {
    const orders = new Map<string, { custom: string; status: string; value: string }>();

    beforeEach(() => {
      orders.clear();
      fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
        const body = init.body ? (typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : init.body) : undefined;
        if (url.endsWith('/v1/oauth2/token')) return json({ access_token: 'pp_token', expires_in: 3000 });
        if (url.endsWith('/v2/checkout/orders') && init.method === 'POST') {
          const unit = (body as any).purchase_units[0];
          const id = `ORDER${orders.size + 1}ABCDE`;
          orders.set(id, { custom: unit.custom_id, status: 'APPROVED', value: unit.amount.value });
          return json({ id, status: 'CREATED', links: [{ rel: 'payer-action', href: `https://paypal.test/approve/${id}` }] });
        }
        const cap = /orders\/([A-Z0-9]+)\/capture$/.exec(url);
        if (cap) {
          const o = orders.get(cap[1]!);
          if (!o || o.status === 'CREATED') return json({ name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_NOT_APPROVED' }] }, 422);
          if (o.status === 'COMPLETED') return json({ details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] }, 422);
          o.status = 'COMPLETED';
          return json(orderBody(cap[1]!, o));
        }
        const get = /orders\/([A-Z0-9]+)$/.exec(url);
        if (get && orders.get(get[1]!)) return json(orderBody(get[1]!, orders.get(get[1]!)!));
        if (url.endsWith('/verify-webhook-signature')) return json({ verification_status: (body as any).transmission_sig === 'good' ? 'SUCCESS' : 'FAILURE' });
        return json({}, 404);
      });
    });

    const orderBody = (id: string, o: { custom: string; status: string; value: string }) => ({
      id, status: o.status,
      purchase_units: [{ custom_id: o.custom, payments: { captures: [{ id: `CAP-${id}`, status: 'COMPLETED', amount: { currency_code: 'USD', value: o.value } }] } }],
    });

    it('checkout → approve → verify credits once; verify again after capture still succeeds', async () => {
      const u = await registerUser(f, 'olga');
      const p = await pack();
      const co = await post(u, '/api/v1/payments/paypal/checkout', { packId: p.id });
      expect(co.status).toBe(201);
      expect(co.body.data.url).toMatch(/^https:\/\/paypal\.test\/approve\//);
      const created = JSON.parse((fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/v2/checkout/orders') && c[1]?.method === 'POST')![1] as RequestInit).body as string);
      expect(created.purchase_units[0].amount).toEqual({ currency_code: 'USD', value: '4.99' });

      const v1 = await post(u, '/api/v1/payments/paypal/verify', { orderId: co.body.data.orderId });
      expect(v1.body.data).toMatchObject({ balance: 800, alreadyProcessed: false });
      const v2 = await post(u, '/api/v1/payments/paypal/verify', { orderId: co.body.data.orderId }); // ORDER_ALREADY_CAPTURED path
      expect(v2.body.data).toMatchObject({ balance: 800, alreadyProcessed: true });
      expect(await PurchaseModel.findOne().lean()).toMatchObject({ provider: 'paypal', providerTxnId: `CAP-${co.body.data.orderId}`, amount: 4.99 });
    });

    it('uses the configured environment (live vs sandbox)', async () => {
      const u = await registerUser(f, 'pete');
      const p = await pack();
      config.paypal!.env = 'live';
      await post(u, '/api/v1/payments/paypal/checkout', { packId: p.id });
      expect(String(fetchMock.mock.calls[0]![0])).toContain('https://api-m.paypal.com/');
    });

    it('rejects orders not approved, tampered amounts, foreign orders and other users\' orders', async () => {
      const u = await registerUser(f, 'quin');
      const thief = await registerUser(f, 'rob');
      const p = await pack();
      const co = await post(u, '/api/v1/payments/paypal/checkout', { packId: p.id });
      const id = co.body.data.orderId as string;

      orders.get(id)!.status = 'CREATED';
      expect((await post(u, '/api/v1/payments/paypal/verify', { orderId: id })).status).toBe(402);

      orders.get(id)!.status = 'APPROVED';
      orders.get(id)!.value = '0.01';
      expect((await post(u, '/api/v1/payments/paypal/verify', { orderId: id })).body.code).toBe('amount_mismatch');

      orders.set('FOREIGN12345', { custom: 'garbage', status: 'APPROVED', value: '4.99' });
      expect((await post(u, '/api/v1/payments/paypal/verify', { orderId: 'FOREIGN12345' })).status).toBe(400);

      orders.get(id)!.value = '4.99';
      expect((await post(thief, '/api/v1/payments/paypal/verify', { orderId: id })).body.code).toBe('payment_owner_mismatch');
      expect((await post(u, '/api/v1/payments/paypal/verify', { orderId: '../etc/passwd' })).status).toBe(400); // path-traversal-looking id is refused before any API call
      expect(await gemsOf(u)).toBe(300);
      expect(await gemsOf(thief)).toBe(300);
    });

    it('webhook: verified via PayPal\'s API; bad signature rejected', async () => {
      const u = await registerUser(f, 'sam');
      const p = await pack();
      const co = await post(u, '/api/v1/payments/paypal/checkout', { packId: p.id });
      const o = orders.get(co.body.data.orderId)!;
      const event = JSON.stringify({ event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAP-WH', status: 'COMPLETED', custom_id: o.custom, amount: { currency_code: 'USD', value: o.value } } });
      const hook = (sig: string) => f.http().post('/api/v1/payments/webhooks/paypal').set('Content-Type', 'application/json').set('paypal-transmission-sig', sig).send(event);
      expect((await hook('forged')).status).toBe(400);
      expect(await gemsOf(u)).toBe(300);
      expect((await hook('good')).body.data.processed).toBe(true);
      expect((await hook('good')).status).toBe(200);
      expect(await gemsOf(u)).toBe(800);
    });
  });

  // ================================================================ Razorpay
  describe('Razorpay', () => {
    const rzpOrders = new Map<string, any>();
    beforeEach(() => {
      rzpOrders.clear();
      fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
        if (url.endsWith('/v1/orders') && init.method === 'POST') {
          const b = JSON.parse(init.body as string);
          const id = `order_${rzpOrders.size + 1}XYZ`;
          const o = { id, status: 'created', amount: b.amount, amount_paid: 0, currency: b.currency, notes: b.notes };
          rzpOrders.set(id, o);
          return json(o);
        }
        const m = /\/v1\/orders\/(.+)$/.exec(url);
        if (m && rzpOrders.has(decodeURIComponent(m[1]!))) return json(rzpOrders.get(decodeURIComponent(m[1]!)));
        return json({}, 404);
      });
    });
    const sign = (order: string, pay: string, secret = 'rzp_secret') => createHmac('sha256', secret).update(`${order}|${pay}`).digest('hex');
    const payOrder = (id: string) => Object.assign(rzpOrders.get(id), { status: 'paid', amount_paid: rzpOrders.get(id).amount });

    it('checkout returns what the SDK needs; verify checks signature AND server-side order', async () => {
      const u = await registerUser(f, 'tina');
      const p = await pack();
      const co = await post(u, '/api/v1/payments/razorpay/checkout', { packId: p.id });
      expect(co.body.data).toMatchObject({ orderId: 'order_1XYZ', extra: { keyId: 'rzp_key', amount: 499, currency: 'INR' } });
      payOrder('order_1XYZ');
      const ok = await post(u, '/api/v1/payments/razorpay/verify', { orderId: 'order_1XYZ', paymentId: 'pay_AAAAA', signature: sign('order_1XYZ', 'pay_AAAAA') });
      expect(ok.body.data).toMatchObject({ balance: 800, gems: 500 });
      const again = await post(u, '/api/v1/payments/razorpay/verify', { orderId: 'order_1XYZ', paymentId: 'pay_AAAAA', signature: sign('order_1XYZ', 'pay_AAAAA') });
      expect(again.body.data.alreadyProcessed).toBe(true);
    });

    it('rejects bad signatures, unpaid orders, partial payments and other users\' orders', async () => {
      const u = await registerUser(f, 'uma');
      const thief = await registerUser(f, 'vic');
      const p = await pack();
      await post(u, '/api/v1/payments/razorpay/checkout', { packId: p.id });
      const good = { orderId: 'order_1XYZ', paymentId: 'pay_BBBBB', signature: sign('order_1XYZ', 'pay_BBBBB') };
      expect((await post(u, '/api/v1/payments/razorpay/verify', { ...good, signature: 'f'.repeat(64) })).body.code).toBe('invalid_signature');
      expect((await post(u, '/api/v1/payments/razorpay/verify', { ...good, signature: sign('order_1XYZ', 'pay_BBBBB', 'wrong-secret') })).status).toBe(400);
      expect((await post(u, '/api/v1/payments/razorpay/verify', good)).status).toBe(402); // signed but order unpaid
      rzpOrders.get('order_1XYZ').status = 'paid';
      rzpOrders.get('order_1XYZ').amount_paid = 100; // partial
      expect((await post(u, '/api/v1/payments/razorpay/verify', good)).status).toBe(402);
      payOrder('order_1XYZ');
      expect((await post(thief, '/api/v1/payments/razorpay/verify', good)).body.code).toBe('payment_owner_mismatch');
      expect(await gemsOf(u)).toBe(300);
      expect(await gemsOf(thief)).toBe(300);
    });

    it('webhook order.paid is authenticated by HMAC of the raw body', async () => {
      const u = await registerUser(f, 'walt');
      const p = await pack();
      await post(u, '/api/v1/payments/razorpay/checkout', { packId: p.id });
      payOrder('order_1XYZ');
      const raw = JSON.stringify({ event: 'order.paid', payload: { order: { entity: rzpOrders.get('order_1XYZ') }, payment: { entity: { id: 'pay_WH1' } } } });
      const hook = (sig: string) => f.http().post('/api/v1/payments/webhooks/razorpay').set('Content-Type', 'application/json').set('X-Razorpay-Signature', sig).send(raw);
      expect((await hook('0'.repeat(64))).status).toBe(400);
      expect((await hook(createHmac('sha256', 'rzp_wh').update(raw).digest('hex'))).body.data.processed).toBe(true);
      expect(await gemsOf(u)).toBe(800);
    });
  });

  // ================================================================ Google Play
  describe('Google Play', () => {
    let purchaseState = 0;
    let ack = 0;
    beforeEach(() => {
      purchaseState = 0;
      ack = 0;
      fetchMock.mockImplementation(async (url: string) => {
        if (url === 'https://oauth2.googleapis.com/token') return json({ access_token: 'g_tok', expires_in: 3600 });
        if (url.endsWith(':acknowledge')) { ack++; return json({}); }
        if (url.includes('/purchases/products/')) return json({ purchaseState, acknowledgementState: 0, orderId: 'GPA.1111-2222' });
        return json({}, 404);
      });
    });
    const receipt = JSON.stringify({ purchaseToken: 'tokentokentokentokentoken', orderId: 'ignored' });

    it('verifies the token for the pack\'s product using the configured package name, credits, acknowledges', async () => {
      const u = await registerUser(f, 'xena');
      const p = await pack();
      const res = await post(u, '/api/v1/payments/google/verify', { packId: 'gems_500', receipt });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ balance: 800, gems: 500 });
      const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/purchases/products/'))!;
      expect(String(call[0])).toContain('/applications/com.example.app/purchases/products/gems_500/tokens/tokentokentokentokentoken');
      await settle();
      expect(ack).toBe(1);
      expect(await PurchaseModel.findOne().lean()).toMatchObject({ provider: 'google', providerTxnId: 'GPA.1111-2222', packId: p.id });
    });

    it('is replay-safe across accounts: the same purchase token cannot pay a second user', async () => {
      const a = await registerUser(f, 'yuri');
      const b = await registerUser(f, 'zed');
      await pack();
      await post(a, '/api/v1/payments/google/verify', { packId: 'gems_500', receipt });
      const replay = await post(b, '/api/v1/payments/google/verify', { packId: 'gems_500', receipt });
      expect(replay.status).toBe(409);
      expect(replay.body.code).toBe('payment_already_used');
      expect(await gemsOf(b)).toBe(300);
      expect((await post(a, '/api/v1/payments/google/verify', { packId: 'gems_500', receipt })).body.data.alreadyProcessed).toBe(true);
      expect(await gemsOf(a)).toBe(800);
    });

    it('fails closed: cancelled/pending purchases, unknown pack, missing config, short receipt', async () => {
      const u = await registerUser(f, 'abby');
      await pack();
      purchaseState = 1;
      expect((await post(u, '/api/v1/payments/google/verify', { packId: 'gems_500', receipt })).body.code).toBe('receipt_invalid');
      purchaseState = 2;
      expect((await post(u, '/api/v1/payments/google/verify', { packId: 'gems_500', receipt })).status).toBe(402);
      purchaseState = 0;
      expect((await post(u, '/api/v1/payments/google/verify', { packId: 'unknown_sku', receipt })).status).toBe(404);
      expect((await post(u, '/api/v1/payments/google/verify', { packId: 'gems_500', receipt: 'short' })).status).toBe(422);
      delete config.google;
      expect((await post(u, '/api/v1/payments/google/verify', { packId: 'gems_500', receipt })).body.code).toBe('provider_not_configured');
      expect(await gemsOf(u)).toBe(300);
    });
  });

  // ================================================================ App Store
  describe('App Store', () => {
    let calls: string[];
    let respond: (url: string) => Record<string, unknown>;
    beforeEach(() => {
      calls = [];
      respond = () => ({ status: 0, receipt: { in_app: [{ product_id: 'com.app.gems500', transaction_id: 'tx-1', purchase_date_ms: '1700000000000' }] } });
      fetchMock.mockImplementation(async (url: string) => {
        calls.push(url);
        return json(respond(url));
      });
    });
    const receipt = 'A'.repeat(60);

    it('verifies against production, credits, and de-duplicates by transaction id', async () => {
      const u = await registerUser(f, 'cody');
      await pack();
      const r = await post(u, '/api/v1/payments/apple/verify', { packId: 'com.app.gems500', receipt });
      expect(r.body.data).toMatchObject({ balance: 800 });
      expect(calls).toEqual(['https://buy.itunes.apple.com/verifyReceipt']);
      expect((await post(u, '/api/v1/payments/apple/verify', { packId: 'com.app.gems500', receipt })).body.data.alreadyProcessed).toBe(true);
      expect(await PurchaseModel.findOne().lean()).toMatchObject({ provider: 'apple', providerTxnId: 'tx-1' });
    });

    it('falls back to the sandbox on status 21007', async () => {
      const u = await registerUser(f, 'dina');
      await pack();
      respond = (url) => (url.includes('sandbox') ? { status: 0, receipt: { in_app: [{ product_id: 'com.app.gems500', transaction_id: 'tx-sb' }] } } : { status: 21007 });
      expect((await post(u, '/api/v1/payments/apple/verify', { packId: 'com.app.gems500', receipt })).status).toBe(201);
      expect(calls).toHaveLength(2);
      expect(calls[1]).toContain('sandbox.itunes.apple.com');
    });

    it('rejects invalid receipts, other products and cancelled transactions; picks the latest matching transaction', async () => {
      const u = await registerUser(f, 'eli');
      await pack();
      respond = () => ({ status: 21002 });
      expect((await post(u, '/api/v1/payments/apple/verify', { packId: 'com.app.gems500', receipt })).body.code).toBe('receipt_invalid');
      respond = () => ({ status: 0, receipt: { in_app: [{ product_id: 'com.app.other', transaction_id: 'tx-x' }] } });
      expect((await post(u, '/api/v1/payments/apple/verify', { packId: 'com.app.gems500', receipt })).status).toBe(402);
      respond = () => ({ status: 0, receipt: { in_app: [{ product_id: 'com.app.gems500', transaction_id: 'tx-c', cancellation_date: '2024-01-01' }] } });
      expect((await post(u, '/api/v1/payments/apple/verify', { packId: 'com.app.gems500', receipt })).status).toBe(402);
      respond = () => ({
        status: 0,
        receipt: { in_app: [
          { product_id: 'com.app.gems500', transaction_id: 'tx-old', purchase_date_ms: '1' },
          { product_id: 'com.app.gems500', transaction_id: 'tx-new', purchase_date_ms: '9' },
        ] },
      });
      await post(u, '/api/v1/payments/apple/verify', { packId: 'com.app.gems500', receipt });
      expect((await PurchaseModel.findOne().lean())?.providerTxnId).toBe('tx-new');
    });
  });

  // ================================================================ history
  describe('purchase history', () => {
    it('lists only my own purchases, newest first, with paging', async () => {
      const a = await registerUser(f, 'fay');
      const b = await registerUser(f, 'gus');
      for (let i = 0; i < 3; i++) await PurchaseModel.create({ userId: a.id, provider: 'stripe', providerTxnId: `s${i}`, packId: 'p', packName: 'P', gems: 10, amount: 1 });
      await PurchaseModel.create({ userId: b.id, provider: 'stripe', providerTxnId: 'other', packId: 'p', packName: 'P', gems: 10, amount: 1 });
      const p1 = await f.http().get('/api/v1/payments/purchases?limit=2').set('Authorization', a.bearer);
      expect(p1.body.data).toHaveLength(2);
      const p2 = await f.http().get(`/api/v1/payments/purchases?limit=2&cursor=${encodeURIComponent(p1.body.page.nextCursor)}`).set('Authorization', a.bearer);
      expect(p2.body.data).toHaveLength(1);
      expect([...p1.body.data, ...p2.body.data].every((x: { id: string }) => x.id.startsWith('txn_'))).toBe(true);
      expect(JSON.stringify(p1.body)).not.toMatch(/userId|providerTxnId|receiptHash/);
      expect((await f.http().get('/api/v1/payments/purchases')).status).toBe(401);
    });
  });
});
