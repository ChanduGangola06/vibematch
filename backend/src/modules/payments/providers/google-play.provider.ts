import { createHash, createSign } from 'node:crypto';
import { AppError, BadGatewayError, BadRequestError, NotFoundError } from '../../../core/errors/index.js';
import { callJson, type FetchLike } from './http.js';
import type { PaymentProvider, VerifiedPayment, VerifyContext } from '../payment.types.js';

interface GoogleProductPurchase {
  purchaseState?: number; // 0 purchased, 1 canceled, 2 pending
  consumptionState?: number;
  acknowledgementState?: number;
  orderId?: string;
  error?: { message?: string };
}

/**
 * Google Play Billing receipt verification (server side, fail-closed):
 *  - the purchase token is looked up with the Play Developer API using our service account
 *  - the product must be the one configured on the pack the caller says they bought
 *  - the package name is configuration, not a constant (v1 hard-coded `com.vibematch.app`)
 */
export class GooglePlayProvider implements PaymentProvider {
  readonly id = 'google' as const;
  private cachedToken: { value: string; expiresAt: number } | undefined;

  constructor(
    private readonly cfg: { serviceAccountJson: string; packageName: string },
    private readonly fetchImpl: FetchLike = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private async accessToken(): Promise<string> {
    if (this.cachedToken && this.cachedToken.expiresAt > this.now() + 60_000) return this.cachedToken.value;

    let creds: { client_email: string; private_key: string };
    try {
      creds = JSON.parse(this.cfg.serviceAccountJson);
    } catch {
      throw new BadGatewayError('Google service account JSON is not valid');
    }
    const iat = Math.floor(this.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const claim = Buffer.from(
      JSON.stringify({
        iss: creds.client_email,
        scope: 'https://www.googleapis.com/auth/androidpublisher',
        aud: 'https://oauth2.googleapis.com/token',
        iat,
        exp: iat + 3600,
      }),
    ).toString('base64url');
    const signature = createSign('RSA-SHA256').update(`${header}.${claim}`).sign(creds.private_key, 'base64url');

    const r = await callJson<{ access_token?: string; expires_in?: number }>(
      this.fetchImpl,
      'https://oauth2.googleapis.com/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claim}.${signature}` }),
      },
      'Google OAuth',
    );
    if (!r.body.access_token) throw new BadGatewayError('Could not authenticate with Google Play');
    this.cachedToken = { value: r.body.access_token, expiresAt: this.now() + (r.body.expires_in ?? 3600) * 1000 };
    return r.body.access_token;
  }

  async verify(input: Record<string, unknown>, ctx: VerifyContext): Promise<VerifiedPayment> {
    const pack = await ctx.findPack(String(input.packId ?? ''));
    if (!pack || pack.gems <= 0) throw new NotFoundError('Gem pack');
    const productId = pack.googlePayId ?? pack.id;

    const receipt = String(input.receipt ?? '');
    let purchaseToken = receipt;
    try {
      const parsed = JSON.parse(receipt) as { purchaseToken?: string };
      if (parsed && typeof parsed === 'object' && parsed.purchaseToken) purchaseToken = parsed.purchaseToken;
    } catch {
      /* plain token */
    }
    if (purchaseToken.length < 20) throw new BadRequestError('Invalid Google Play receipt: missing purchaseToken');

    const token = await this.accessToken();
    const base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(this.cfg.packageName)}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}`;
    const r = await callJson<GoogleProductPurchase>(this.fetchImpl, base, { headers: { Authorization: `Bearer ${token}` } }, 'Google Play');
    if (!r.ok || r.body.purchaseState !== 0) {
      throw new AppError(402, 'receipt_invalid', 'Payment required', {
        detail: r.body.error?.message ?? `Google Play purchase is not valid (state ${String(r.body.purchaseState)})`,
      });
    }

    // Unacknowledged purchases are refunded automatically after 3 days — acknowledge once we credit.
    if (r.body.acknowledgementState === 0) {
      void callJson(this.fetchImpl, `${base}:acknowledge`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' }, 'Google Play').catch(() => {});
    }

    const receiptHash = createHash('sha256').update(purchaseToken).digest('hex');
    return {
      provider: 'google',
      providerTxnId: r.body.orderId ?? `gp_${receiptHash.slice(0, 32)}`,
      packId: pack.id,
      packName: pack.name,
      gems: pack.gems,
      amount: pack.price,
      currency: 'USD',
      receiptHash,
    };
  }
}
