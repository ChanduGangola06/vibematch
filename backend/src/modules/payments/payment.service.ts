import type { Env } from '../../config/env.js';
import type { AppEventBus } from '../../core/events/index.js';
import { AppError, BadRequestError, ForbiddenError, NotFoundError } from '../../core/errors/index.js';
import type { Logger } from '../../core/logger/index.js';
import { keysetPage, type CursorCodec, type Page } from '../../core/pagination/index.js';
import { newId } from '../../core/utils/id.js';
import { PurchaseModel, type PurchaseDoc } from '../../infra/db/models/commerce.js';
import { UserModel } from '../../infra/db/models/user.js';
import type { GemService } from '../ledger/gem.service.js';
import type { PackRepository } from '../store/store.repository.js';
import type { CheckoutResult, PurchaseProvider, VerifiedPayment } from './payment.types.js';
import type { PaymentProviders } from './provider.factory.js';

export interface PurchaseDto {
  id: string;
  provider: PurchaseProvider;
  packId: string;
  packName: string;
  gems: number;
  amount: number;
  currency: string;
  status: 'completed' | 'refunded';
  createdAt: string;
}

export const toPurchaseDto = (p: PurchaseDoc): PurchaseDto => ({
  id: p.id, provider: p.provider, packId: p.packId, packName: p.packName ?? '', gems: p.gems, amount: p.amount,
  currency: p.currency ?? 'USD', status: p.status ?? 'completed', createdAt: (p.createdAt ?? new Date(0)).toISOString(),
});

const isDuplicate = (e: unknown) => (e as { code?: number })?.code === 11000;

export interface FulfilResult {
  balance: number;
  gems: number;
  purchaseId: string;
  alreadyProcessed: boolean;
}

/** Facade over providers, ledger and purchases: the three things a route needs (checkout / verify / webhook). */
export class PaymentService {
  constructor(
    private readonly env: Env,
    private readonly providers: PaymentProviders,
    private readonly packs: Pick<PackRepository, 'findById' | 'findByAnyId'>,
    private readonly gems: GemService,
    private readonly events: AppEventBus,
    private readonly cursor: CursorCodec,
    private readonly log: Logger,
  ) {}

  /** Redirect targets are allow-listed: our own origin and the configured web app origins only. */
  resolveReturnBase(returnUrl?: string): string {
    const own = new URL(this.env.PUBLIC_URL).origin;
    if (!returnUrl) return own;
    let origin: string;
    try {
      origin = new URL(returnUrl).origin;
    } catch {
      throw new BadRequestError('returnUrl is not a valid URL');
    }
    const allowed = new Set([own, ...this.env.corsOrigins]);
    if (!allowed.has(origin)) throw new BadRequestError('returnUrl origin is not allowed', { extensions: { code: 'return_url_not_allowed' } });
    return origin;
  }

  async checkout(userId: string, providerId: PurchaseProvider, packId: string, returnUrl?: string): Promise<CheckoutResult> {
    const provider = await this.providers.get(providerId);
    if (!provider.checkout) throw new BadRequestError(`${providerId} does not support hosted checkout`);
    const pack = await this.packs.findById(packId);
    if (!pack) throw new NotFoundError('Gem pack');
    return provider.checkout({
      userId, pack, returnBaseUrl: this.resolveReturnBase(returnUrl), currency: await this.providers.currency(),
    });
  }

  async verify(userId: string, providerId: PurchaseProvider, input: Record<string, unknown>): Promise<FulfilResult> {
    const provider = await this.providers.get(providerId);
    const verified = await provider.verify(input, { userId, findPack: (k) => this.packs.findByAnyId(k) });
    // The payment must belong to the person claiming it (a leaked session/order id is useless to others).
    if (verified.userId && verified.userId !== userId) {
      throw new ForbiddenError('This payment belongs to another account', 'payment_owner_mismatch');
    }
    return this.fulfil({ ...verified, userId });
  }

  /** Returns false for ignored events so the route can still answer 200. */
  async webhook(providerId: PurchaseProvider, raw: Buffer, headers: Record<string, string | undefined>): Promise<boolean> {
    const provider = await this.providers.get(providerId);
    if (!provider.webhook) throw new BadRequestError(`${providerId} has no webhook`);
    const verified = await provider.webhook(raw, headers);
    if (!verified?.userId) return false;
    try {
      await this.fulfil(verified as VerifiedPayment & { userId: string });
    } catch (err) {
      if (err instanceof NotFoundError) {
        this.log.error({ provider: providerId, txn: verified.providerTxnId, userId: verified.userId }, 'paid order for a missing account — needs manual refund');
        return false;
      }
      throw err;
    }
    return true;
  }

  /**
   * Credits a verified payment exactly once.
   *  1. a purchase row is created under the unique (provider, txnId) index
   *  2. the gem credit is keyed by that purchase → the ledger refuses a second credit
   * Both happen in one transaction when available; if a previous attempt crashed between the two,
   * the retry finds the purchase and re-runs only the (idempotent) credit.
   */
  async fulfil(p: VerifiedPayment & { userId: string }): Promise<FulfilResult> {
    const existing = await PurchaseModel.findOne({ provider: p.provider, providerTxnId: p.providerTxnId }).lean();
    if (existing) return this.heal(existing, p.userId);

    if (p.receiptHash) {
      const sameReceipt = await PurchaseModel.findOne({ receiptHash: p.receiptHash }).lean();
      if (sameReceipt) return this.heal(sameReceipt, p.userId);
    }

    const user = await UserModel.findOne({ id: p.userId }, { username: 1, name: 1, email: 1 }).lean();
    if (!user) throw new NotFoundError('Account');

    const purchaseId = newId('txn');
    try {
      const balance = await this.gems.withTx(async (session) => {
        await PurchaseModel.create(
          [{
            id: purchaseId, userId: p.userId, username: user.username, provider: p.provider, providerTxnId: p.providerTxnId,
            ...(p.receiptHash ? { receiptHash: p.receiptHash } : {}),
            packId: p.packId, packName: p.packName, gems: p.gems, amount: p.amount, currency: p.currency, status: 'completed',
          }],
          session ? { session } : {},
        );
        return (await this.gems.credit(p.userId, p.gems, 'purchase', { type: 'purchase', id: purchaseId }, session)).balance;
      });
      this.events.emit('purchase.completed', { userId: p.userId, purchaseId, packName: p.packName, amount: p.amount, gems: p.gems });
      return { balance, gems: p.gems, purchaseId, alreadyProcessed: false };
    } catch (err) {
      if (isDuplicate(err)) {
        // lost a race with a concurrent verify/webhook for the same payment
        const winner = await PurchaseModel.findOne({ provider: p.provider, providerTxnId: p.providerTxnId }).lean()
          ?? (p.receiptHash ? await PurchaseModel.findOne({ receiptHash: p.receiptHash }).lean() : null);
        if (winner) return this.heal(winner, p.userId);
      }
      throw err;
    }
  }

  private async heal(existing: PurchaseDoc, claimantId: string): Promise<FulfilResult> {
    if (existing.userId !== claimantId) {
      throw new AppError(409, 'payment_already_used', 'Conflict', { detail: 'This payment was already used by another account' });
    }
    const credit = await this.gems.credit(existing.userId, existing.gems, 'purchase', { type: 'purchase', id: existing.id });
    if (credit.applied) {
      // an earlier attempt stored the purchase but crashed before crediting — now repaired
      this.events.emit('purchase.completed', { userId: existing.userId, purchaseId: existing.id, packName: existing.packName ?? '', amount: existing.amount, gems: existing.gems });
    }
    return { balance: credit.balance, gems: existing.gems, purchaseId: existing.id, alreadyProcessed: !credit.applied };
  }

  async listForUser(userId: string, q: { limit: number; cursor?: string | undefined }): Promise<Page<PurchaseDto>> {
    const page = await keysetPage<PurchaseDoc>(PurchaseModel, this.cursor, { filter: { userId }, ...q });
    return { items: page.items.map(toPurchaseDto), page: page.page };
  }
}
