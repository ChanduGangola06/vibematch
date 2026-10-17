import { AppError, BadGatewayError, BadRequestError } from '../../../core/errors/index.js';
import { callJson, type FetchLike } from './http.js';
import { metaFor, type CheckoutInput, type CheckoutResult, type PaymentProvider, type VerifiedPayment } from '../payment.types.js';

interface PayPalCapture {
  id: string;
  status: string;
  custom_id?: string;
  amount: { currency_code: string; value: string };
}
interface PayPalOrder {
  id: string;
  status: string;
  links?: { rel: string; href: string }[];
  purchase_units?: { custom_id?: string; payments?: { captures?: PayPalCapture[] } }[];
  name?: string;
  details?: { issue?: string }[];
}

export interface PayPalConfig {
  clientId: string;
  clientSecret: string;
  env: 'sandbox' | 'live';
  webhookId?: string | undefined;
}

/** custom_id written at checkout: `userId|packId|gems|price|packName` — set by us, echoed back by PayPal. */
const encodeCustom = (c: ReturnType<typeof metaFor>) =>
  [c.userId, c.packId, c.gems, c.price, c.packName.replace(/\|/g, ' ')].join('|');

const decodeCustom = (s: string | undefined) => {
  const [userId, packId, gems, price, ...name] = (s ?? '').split('|');
  const g = Number(gems);
  const p = Number(price);
  if (!userId || !packId || !Number.isInteger(g) || g <= 0 || !Number.isFinite(p)) return null;
  return { userId, packId, gems: g, price: p, packName: name.join('|') || 'Diamond Pack' };
};

export class PayPalProvider implements PaymentProvider {
  readonly id = 'paypal' as const;
  private readonly base: string;

  constructor(
    private readonly cfg: PayPalConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    // Environment is configuration (v1 hard-coded the sandbox URL).
    this.base = cfg.env === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
  }

  private async token(): Promise<string> {
    const auth = Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString('base64');
    const r = await callJson<{ access_token?: string }>(
      this.fetchImpl,
      `${this.base}/v1/oauth2/token`,
      {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials',
      },
      'PayPal',
    );
    if (!r.body.access_token) throw new BadGatewayError('PayPal rejected the configured credentials');
    return r.body.access_token;
  }

  async checkout(input: CheckoutInput): Promise<CheckoutResult> {
    const meta = metaFor(input);
    const token = await this.token();
    const r = await callJson<PayPalOrder>(
      this.fetchImpl,
      `${this.base}/v2/checkout/orders`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          intent: 'CAPTURE',
          purchase_units: [
            {
              description: meta.packName.slice(0, 120),
              custom_id: encodeCustom(meta),
              amount: { currency_code: input.currency.toUpperCase(), value: meta.price.toFixed(2) },
            },
          ],
          payment_source: {
            paypal: {
              experience_context: {
                return_url: `${input.returnBaseUrl}/payment-callback?status=success&method=paypal`,
                cancel_url: `${input.returnBaseUrl}/payment-callback?status=cancel&method=paypal`,
                user_action: 'PAY_NOW',
              },
            },
          },
        }),
      },
      'PayPal',
    );
    if (!r.ok) throw new BadGatewayError('PayPal could not create the order');
    const approve = r.body.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve')?.href;
    if (!approve) throw new BadGatewayError('PayPal returned no approval link');
    return { url: approve, orderId: r.body.id };
  }

  async verify(input: Record<string, unknown>): Promise<VerifiedPayment> {
    const orderId = String(input.orderId ?? '');
    if (!/^[A-Za-z0-9-]{5,40}$/.test(orderId)) throw new BadRequestError('Invalid PayPal order id');
    const token = await this.token();
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    let r = await callJson<PayPalOrder>(this.fetchImpl, `${this.base}/v2/checkout/orders/${orderId}/capture`, { method: 'POST', headers, body: '{}' }, 'PayPal');
    // A retry after a successful capture must still succeed: read the order instead.
    if (r.status === 422 && r.body.details?.some((d) => d.issue === 'ORDER_ALREADY_CAPTURED')) {
      r = await callJson<PayPalOrder>(this.fetchImpl, `${this.base}/v2/checkout/orders/${orderId}`, { method: 'GET', headers }, 'PayPal');
    }
    if (!r.ok) throw new AppError(402, 'payment_not_completed', 'Payment required', { detail: 'PayPal did not confirm this payment' });
    return this.toVerified(r.body);
  }

  async webhook(rawBody: Buffer, headers: Record<string, string | undefined>): Promise<VerifiedPayment | null> {
    if (!this.cfg.webhookId) throw new AppError(400, 'webhook_not_configured', 'Webhook not configured');
    let event: { event_type?: string; resource?: PayPalCapture };
    try {
      event = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new BadRequestError('Malformed webhook body');
    }
    const token = await this.token();
    const check = await callJson<{ verification_status?: string }>(
      this.fetchImpl,
      `${this.base}/v1/notifications/verify-webhook-signature`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          auth_algo: headers['paypal-auth-algo'],
          cert_url: headers['paypal-cert-url'],
          transmission_id: headers['paypal-transmission-id'],
          transmission_sig: headers['paypal-transmission-sig'],
          transmission_time: headers['paypal-transmission-time'],
          webhook_id: this.cfg.webhookId,
          webhook_event: event,
        }),
      },
      'PayPal',
    );
    if (check.body.verification_status !== 'SUCCESS') throw new BadRequestError('Invalid webhook signature');
    if (event.event_type !== 'PAYMENT.CAPTURE.COMPLETED' || !event.resource) return null;
    return this.fromCapture(event.resource);
  }

  private toVerified(order: PayPalOrder): VerifiedPayment {
    const unit = order.purchase_units?.[0];
    const capture = unit?.payments?.captures?.find((c) => c.status === 'COMPLETED');
    if (order.status !== 'COMPLETED' || !capture) {
      throw new AppError(402, 'payment_not_completed', 'Payment required', { detail: 'The payment has not been completed' });
    }
    return this.fromCapture({ ...capture, custom_id: capture.custom_id ?? unit?.custom_id });
  }

  private fromCapture(c: PayPalCapture): VerifiedPayment {
    const meta = decodeCustom(c.custom_id);
    if (!meta) throw new BadRequestError('This PayPal order was not created by this server');
    if (c.status !== 'COMPLETED') throw new AppError(402, 'payment_not_completed', 'Payment required', { detail: 'Capture not completed' });
    const paid = Number(c.amount.value);
    if (Math.abs(paid - meta.price) > 0.001) {
      throw new AppError(409, 'amount_mismatch', 'Conflict', { detail: 'Paid amount does not match the pack price' });
    }
    return {
      provider: 'paypal',
      providerTxnId: c.id,
      userId: meta.userId,
      packId: meta.packId,
      packName: meta.packName,
      gems: meta.gems,
      amount: paid,
      currency: c.amount.currency_code,
    };
  }
}
