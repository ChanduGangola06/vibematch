import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError, BadGatewayError, BadRequestError } from '../../../core/errors/index.js';
import { callJson, type FetchLike } from './http.js';
import { metaFor, toMinor, type CheckoutInput, type CheckoutResult, type PaymentProvider, type VerifiedPayment } from '../payment.types.js';

interface RazorpayOrder {
  id: string;
  status: string;
  amount: number;
  amount_paid: number;
  currency: string;
  notes?: Record<string, string>;
}

const hmac = (secret: string, data: string | Buffer) => createHmac('sha256', secret).update(data).digest('hex');
const safeEq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export class RazorpayProvider implements PaymentProvider {
  readonly id = 'razorpay' as const;
  private static readonly BASE = 'https://api.razorpay.com/v1';

  constructor(
    private readonly cfg: { keyId: string; keySecret: string; webhookSecret?: string | undefined; currency: string },
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private get auth() {
    return { Authorization: `Basic ${Buffer.from(`${this.cfg.keyId}:${this.cfg.keySecret}`).toString('base64')}` };
  }

  async checkout(input: CheckoutInput): Promise<CheckoutResult> {
    const meta = metaFor(input);
    const r = await callJson<RazorpayOrder>(
      this.fetchImpl,
      `${RazorpayProvider.BASE}/orders`,
      {
        method: 'POST',
        headers: { ...this.auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: toMinor(meta.price),
          currency: this.cfg.currency,
          receipt: `rcpt_${Date.now()}`,
          notes: { userId: meta.userId, packId: meta.packId, packName: meta.packName, gems: String(meta.gems), price: String(meta.price) },
        }),
      },
      'Razorpay',
    );
    if (!r.ok) throw new BadGatewayError('Razorpay could not create the order');
    return { orderId: r.body.id, extra: { keyId: this.cfg.keyId, amount: r.body.amount, currency: r.body.currency } };
  }

  async verify(input: Record<string, unknown>): Promise<VerifiedPayment> {
    const orderId = String(input.orderId ?? '');
    const paymentId = String(input.paymentId ?? '');
    const signature = String(input.signature ?? '');
    // 1. proof that the checkout really completed this payment for this order
    if (!safeEq(hmac(this.cfg.keySecret, `${orderId}|${paymentId}`), signature)) {
      throw new BadRequestError('Invalid payment signature', { extensions: { code: 'invalid_signature' } });
    }
    // 2. server-side truth about the order (owner, pack, amount) — never the client's claims
    const r = await callJson<RazorpayOrder>(
      this.fetchImpl,
      `${RazorpayProvider.BASE}/orders/${encodeURIComponent(orderId)}`,
      { headers: this.auth },
      'Razorpay',
    );
    if (!r.ok) throw new BadRequestError('Unknown Razorpay order');
    return this.fromOrder(r.body, paymentId);
  }

  async webhook(rawBody: Buffer, headers: Record<string, string | undefined>): Promise<VerifiedPayment | null> {
    if (!this.cfg.webhookSecret) throw new AppError(400, 'webhook_not_configured', 'Webhook not configured');
    if (!safeEq(hmac(this.cfg.webhookSecret, rawBody), headers['x-razorpay-signature'] ?? '')) {
      throw new BadRequestError('Invalid webhook signature');
    }
    let event: { event?: string; payload?: { order?: { entity?: RazorpayOrder }; payment?: { entity?: { id: string } } } };
    try {
      event = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new BadRequestError('Malformed webhook body');
    }
    if (event.event !== 'order.paid') return null;
    const order = event.payload?.order?.entity;
    const paymentId = event.payload?.payment?.entity?.id;
    return order && paymentId ? this.fromOrder(order, paymentId) : null;
  }

  private fromOrder(o: RazorpayOrder, paymentId: string): VerifiedPayment {
    const n = o.notes ?? {};
    const price = Number(n.price);
    const gems = Number(n.gems);
    if (!n.userId || !n.packId || !Number.isFinite(price) || !Number.isInteger(gems) || gems <= 0) {
      throw new BadRequestError('This Razorpay order was not created by this server');
    }
    if (o.status !== 'paid' || o.amount_paid !== toMinor(price)) {
      throw new AppError(402, 'payment_not_completed', 'Payment required', { detail: 'The order has not been fully paid' });
    }
    return {
      provider: 'razorpay',
      providerTxnId: paymentId,
      userId: n.userId,
      packId: n.packId,
      packName: n.packName ?? 'Diamond Pack',
      gems,
      amount: price,
      currency: o.currency,
    };
  }
}
