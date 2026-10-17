import Stripe from 'stripe';
import { AppError, BadGatewayError, BadRequestError } from '../../../core/errors/index.js';
import { metaFor, toMinor, type CheckoutInput, type CheckoutResult, type PaymentProvider, type VerifiedPayment } from '../payment.types.js';

/** The slice of the Stripe SDK we use — lets tests inject a fake. */
export interface StripeLike {
  checkout: {
    sessions: {
      create(params: Record<string, unknown>): Promise<{ id: string; url: string | null }>;
      retrieve(id: string): Promise<StripeSession>;
    };
  };
  webhooks: {
    constructEvent(payload: Buffer, signature: string, secret: string): { type: string; data: { object: StripeSession } };
  };
}

export interface StripeSession {
  id: string;
  payment_status: string;
  amount_total: number | null;
  currency: string | null;
  metadata: Record<string, string> | null;
}

export const createStripeClient = (secretKey: string): StripeLike =>
  new Stripe(secretKey, { maxNetworkRetries: 2, timeout: 15_000 }) as unknown as StripeLike;

export class StripeProvider implements PaymentProvider {
  readonly id = 'stripe' as const;

  constructor(
    private readonly stripe: StripeLike,
    private readonly webhookSecret?: string,
  ) {}

  async checkout(input: CheckoutInput): Promise<CheckoutResult> {
    const meta = metaFor(input);
    try {
      const session = await this.stripe.checkout.sessions.create({
        mode: 'payment',
        payment_method_types: ['card'],
        client_reference_id: input.userId,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: input.currency.toLowerCase(),
              unit_amount: toMinor(meta.price), // price comes from OUR database, never from the request
              product_data: { name: meta.packName },
            },
          },
        ],
        metadata: { userId: meta.userId, packId: meta.packId, packName: meta.packName, gems: String(meta.gems), price: String(meta.price) },
        success_url: `${input.returnBaseUrl}/payment-callback?status=success&method=stripe&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${input.returnBaseUrl}/payment-callback?status=cancel&method=stripe`,
      });
      if (!session.url) throw new Error('Stripe returned no checkout url');
      return { url: session.url, orderId: session.id };
    } catch (err) {
      throw new BadGatewayError('Could not start the Stripe checkout', err);
    }
  }

  async verify(input: Record<string, unknown>): Promise<VerifiedPayment> {
    const sessionId = String(input.sessionId ?? '');
    let session: StripeSession;
    try {
      session = await this.stripe.checkout.sessions.retrieve(sessionId);
    } catch {
      throw new BadRequestError('Unknown Stripe session', { extensions: { code: 'payment_not_found' } });
    }
    return this.toVerified(session);
  }

  async webhook(rawBody: Buffer, headers: Record<string, string | undefined>): Promise<VerifiedPayment | null> {
    if (!this.webhookSecret) throw new AppError(400, 'webhook_not_configured', 'Webhook not configured');
    const sig = headers['stripe-signature'];
    if (!sig) throw new BadRequestError('Missing Stripe-Signature header');
    let event;
    try {
      event = this.stripe.webhooks.constructEvent(rawBody, sig, this.webhookSecret);
    } catch {
      throw new BadRequestError('Invalid webhook signature');
    }
    if (event.type !== 'checkout.session.completed' && event.type !== 'checkout.session.async_payment_succeeded') return null;
    return event.data.object.payment_status === 'paid' ? this.toVerified(event.data.object) : null;
  }

  private toVerified(s: StripeSession): VerifiedPayment {
    if (s.payment_status !== 'paid') throw new AppError(402, 'payment_not_completed', 'Payment required', { detail: 'The payment has not been completed' });
    const m = s.metadata ?? {};
    const price = Number(m.price);
    const gems = Number(m.gems);
    if (!m.userId || !m.packId || !Number.isFinite(price) || !Number.isInteger(gems) || gems <= 0) {
      throw new BadRequestError('This Stripe session was not created by this server');
    }
    // What was charged must equal what we asked for when the session was created.
    if (s.amount_total !== toMinor(price)) {
      throw new AppError(409, 'amount_mismatch', 'Conflict', { detail: 'Paid amount does not match the pack price' });
    }
    return {
      provider: 'stripe', providerTxnId: s.id, userId: m.userId, packId: m.packId, packName: m.packName ?? 'Diamond Pack',
      gems, amount: price, currency: (s.currency ?? '').toUpperCase(),
    };
  }
}
