import { createHash } from 'node:crypto';
import { AppError, BadRequestError, NotFoundError } from '../../../core/errors/index.js';
import { callJson, type FetchLike } from './http.js';
import type { PaymentProvider, VerifiedPayment, VerifyContext } from '../payment.types.js';

interface AppleInApp {
  product_id: string;
  transaction_id: string;
  purchase_date_ms?: string;
  cancellation_date?: string;
}
interface AppleResponse {
  status: number;
  receipt?: { in_app?: AppleInApp[] };
  latest_receipt_info?: AppleInApp[];
}

/**
 * App Store receipt verification via `verifyReceipt`: production first, sandbox on status 21007
 * (App Review and TestFlight send sandbox receipts to production servers).
 * The matched transaction must be for the product configured on the pack and must not be cancelled.
 */
export class AppStoreProvider implements PaymentProvider {
  readonly id = 'apple' as const;

  constructor(
    private readonly cfg: { sharedSecret?: string | undefined },
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private async call(url: string, receipt: string): Promise<AppleResponse> {
    const r = await callJson<AppleResponse>(
      this.fetchImpl,
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 'receipt-data': receipt, ...(this.cfg.sharedSecret ? { password: this.cfg.sharedSecret } : {}), 'exclude-old-transactions': false }),
      },
      'App Store',
    );
    return r.body;
  }

  async verify(input: Record<string, unknown>, ctx: VerifyContext): Promise<VerifiedPayment> {
    const pack = await ctx.findPack(String(input.packId ?? ''));
    if (!pack || pack.gems <= 0) throw new NotFoundError('Gem pack');
    const productId = pack.applePayId ?? pack.id;
    const receipt = String(input.receipt ?? '');
    if (receipt.length < 20) throw new BadRequestError('Invalid App Store receipt');

    let data = await this.call('https://buy.itunes.apple.com/verifyReceipt', receipt);
    if (data.status === 21007) data = await this.call('https://sandbox.itunes.apple.com/verifyReceipt', receipt);
    if (data.status !== 0) {
      throw new AppError(402, 'receipt_invalid', 'Payment required', { detail: `App Store verification returned status ${data.status}` });
    }

    const entries = [...(data.latest_receipt_info ?? []), ...(data.receipt?.in_app ?? [])]
      .filter((e) => e.product_id === productId && !e.cancellation_date)
      .sort((a, b) => Number(b.purchase_date_ms ?? 0) - Number(a.purchase_date_ms ?? 0));
    const tx = entries[0];
    if (!tx) throw new AppError(402, 'receipt_invalid', 'Payment required', { detail: 'No matching purchase in this receipt' });

    return {
      provider: 'apple',
      providerTxnId: tx.transaction_id,
      packId: pack.id,
      packName: pack.name,
      gems: pack.gems,
      amount: pack.price,
      currency: 'USD',
      receiptHash: createHash('sha256').update(`${tx.transaction_id}:${productId}`).digest('hex'),
    };
  }
}
