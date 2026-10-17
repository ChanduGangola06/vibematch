import mongoose, { type ClientSession } from 'mongoose';
import { AppError, NotFoundError, PaymentRequiredError } from '../../core/errors/index.js';
import type { Logger } from '../../core/logger/index.js';
import { GemLedgerModel, type LedgerReason } from '../../infra/db/models/commerce.js';
import { UserModel } from '../../infra/db/models/user.js';

export interface LedgerRef {
  type: string;
  id: string;
}

export interface GemResult {
  balance: number;
  /** False when a credit with the same ref was already applied (idempotent replay). */
  applied: boolean;
  ledgerId?: string;
}

const isDuplicate = (e: unknown) => (e as { code?: number })?.code === 11000;
const NO_TX = /replica set|Transaction numbers|transactions are not supported|IllegalOperation/i;

/**
 * Single place where gem balances change. Rules:
 *  - a debit is one guarded `$inc` (`gems >= cost`) — concurrent spends can never overdraw
 *  - every change writes an immutable ledger row with the resulting balance
 *  - a credit with a `ref` is applied at most once (unique ledger index) → safe to retry
 * Balance + ledger are committed in one MongoDB transaction when the deployment supports it
 * (replica set / Atlas); on a standalone server they fall back to ordered writes.
 */
export class GemService {
  private txSupported: boolean | undefined;

  constructor(private readonly log: Logger) {}

  /** Runs `fn` inside a transaction if available; callers pass the session into debit/credit. */
  async withTx<T>(fn: (session: ClientSession | undefined) => Promise<T>): Promise<T> {
    if (this.txSupported === false) return fn(undefined);
    const session = await mongoose.startSession();
    try {
      let result!: T;
      await session.withTransaction(async () => {
        result = await fn(session);
      });
      this.txSupported = true;
      return result;
    } catch (err) {
      if (this.txSupported === undefined && NO_TX.test((err as Error).message ?? '')) {
        this.txSupported = false;
        this.log.warn('MongoDB transactions unavailable (standalone server): gem updates use ordered writes. Use a replica set in production.');
        return fn(undefined);
      }
      throw err;
    } finally {
      await session.endSession();
    }
  }

  async debit(userId: string, amount: number, reason: LedgerReason, ref?: LedgerRef, session?: ClientSession): Promise<GemResult> {
    this.assertAmount(amount);
    if (amount === 0) return { balance: await this.balance(userId, session), applied: true };

    const updated = await UserModel.findOneAndUpdate(
      { id: userId, gems: { $gte: amount } },
      { $inc: { gems: -amount } },
      { returnDocument: 'after', projection: { gems: 1 }, ...(session ? { session } : {}) },
    ).lean();
    if (!updated) {
      const exists = await UserModel.exists({ id: userId }).session(session ?? null);
      if (!exists) throw new NotFoundError('Account');
      throw new PaymentRequiredError('Not enough gems', 'insufficient_gems');
    }
    const [row] = await GemLedgerModel.create(
      [{ userId, delta: -amount, balanceAfter: updated.gems, reason, ...(ref ? { refType: ref.type, refId: ref.id } : {}) }],
      session ? { session } : {},
    );
    return { balance: updated.gems, applied: true, ledgerId: row!.id };
  }

  async credit(userId: string, amount: number, reason: LedgerReason, ref?: LedgerRef, session?: ClientSession): Promise<GemResult> {
    this.assertAmount(amount);
    if (amount === 0) return { balance: await this.balance(userId, session), applied: true };

    if (ref) {
      // Claim the business event first: the unique (refType, refId, reason) index makes a second attempt a no-op.
      try {
        await GemLedgerModel.create(
          [{ userId, delta: amount, balanceAfter: 0, reason, refType: ref.type, refId: ref.id }],
          session ? { session } : {},
        );
      } catch (err) {
        if (isDuplicate(err)) return { balance: await this.balance(userId, session), applied: false };
        throw err;
      }
    }
    const updated = await UserModel.findOneAndUpdate(
      { id: userId },
      { $inc: { gems: amount } },
      { returnDocument: 'after', projection: { gems: 1 }, ...(session ? { session } : {}) },
    ).lean();
    if (!updated) throw new NotFoundError('Account');

    let ledgerId: string | undefined;
    if (ref) {
      const row = await GemLedgerModel.findOneAndUpdate(
        { refType: ref.type, refId: ref.id, reason },
        { $set: { balanceAfter: updated.gems } },
        { returnDocument: 'after', ...(session ? { session } : {}) },
      ).lean();
      ledgerId = row?.id;
    } else {
      const [row] = await GemLedgerModel.create(
        [{ userId, delta: amount, balanceAfter: updated.gems, reason }],
        session ? { session } : {},
      );
      ledgerId = row!.id;
    }
    return { balance: updated.gems, applied: true, ...(ledgerId ? { ledgerId } : {}) };
  }

  async balance(userId: string, session?: ClientSession): Promise<number> {
    const u = await UserModel.findOne({ id: userId }, { gems: 1 }).session(session ?? null).lean();
    return u?.gems ?? 0;
  }

  private assertAmount(n: number): void {
    if (!Number.isInteger(n) || n < 0) throw new AppError(500, 'invalid_gem_amount', 'Internal server error', { detail: `Invalid gem amount: ${n}` });
  }
}

/**
 * Command pattern: an undoable gem operation. A multi-step flow (debit → create message …) can
 * compensate by calling `undo()` when a later step fails.
 */
export interface GemCommand {
  execute(): Promise<GemResult>;
  undo(): Promise<void>;
}

export class DebitGemsCommand implements GemCommand {
  private done = false;
  constructor(
    private readonly gems: GemService,
    private readonly userId: string,
    private readonly amount: number,
    private readonly reason: LedgerReason,
    private readonly ref?: LedgerRef,
  ) {}

  async execute(): Promise<GemResult> {
    const r = await this.gems.debit(this.userId, this.amount, this.reason, this.ref);
    this.done = true;
    return r;
  }

  /** Refunds the debit (separate ledger row so history stays append-only). */
  async undo(): Promise<void> {
    if (!this.done || this.amount === 0) return;
    await this.gems.credit(this.userId, this.amount, 'refund', this.ref ? { type: `${this.ref.type}_refund`, id: this.ref.id } : undefined);
    this.done = false;
  }
}
