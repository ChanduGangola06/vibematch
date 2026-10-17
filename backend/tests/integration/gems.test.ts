import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAsyncLogger } from '../../src/core/logger/index.js';
import { GemLedgerModel, UserModel, syncIndexes } from '../../src/infra/db/models/index.js';
import { DebitGemsCommand, GemService } from '../../src/modules/ledger/gem.service.js';
import { clearTestDb, startTestDb, stopTestDb } from '../helpers/mongo.js';

describe('GemService (atomic balance + ledger)', () => {
  const gems = new GemService(createAsyncLogger({ level: 'silent', flushMs: 1000 }).logger);
  beforeAll(async () => {
    await startTestDb();
    await syncIndexes();
  });
  afterAll(stopTestDb);
  beforeEach(clearTestDb);

  const user = (id: string, gems = 100) => UserModel.create({ id, username: id, usernameLower: id, gems });
  const balance = async (id: string) => (await UserModel.findOne({ id }).lean())!.gems;

  it('debits atomically and records the balance after each change', async () => {
    await user('u1', 100);
    const r = await gems.debit('u1', 30, 'gift_sent', { type: 'gift', id: 'm1' });
    expect(r).toMatchObject({ balance: 70, applied: true });
    const rows = await GemLedgerModel.find({ userId: 'u1' }).lean();
    expect(rows).toEqual([expect.objectContaining({ delta: -30, balanceAfter: 70, reason: 'gift_sent', refType: 'gift', refId: 'm1' })]);
  });

  it('rejects overdrafts without touching the balance or the ledger', async () => {
    await user('u1', 10);
    await expect(gems.debit('u1', 11, 'gift_sent')).rejects.toMatchObject({ status: 402, code: 'insufficient_gems' });
    await expect(gems.debit('ghost', 1, 'gift_sent')).rejects.toMatchObject({ status: 404 });
    expect(await balance('u1')).toBe(10);
    expect(await GemLedgerModel.countDocuments()).toBe(0);
  });

  it('race: 20 parallel spends of 10 against a balance of 100 succeed exactly 10 times (no double spend)', async () => {
    await user('u1', 100);
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => gems.debit('u1', 10, 'gift_sent', { type: 'gift', id: `m${i}` })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(10);
    expect(await balance('u1')).toBe(0);
    const rows = await GemLedgerModel.find({ userId: 'u1' }).sort({ balanceAfter: -1 }).lean();
    expect(rows).toHaveLength(10);
    expect(rows.map((r) => r.balanceAfter)).toEqual([90, 80, 70, 60, 50, 40, 30, 20, 10, 0]); // ledger is a consistent chain
  });

  it('credits with a ref are idempotent: the same business event can never pay twice', async () => {
    await user('u1', 0);
    const first = await gems.credit('u1', 500, 'purchase', { type: 'purchase', id: 'txn1' });
    expect(first).toMatchObject({ balance: 500, applied: true });
    const again = await gems.credit('u1', 500, 'purchase', { type: 'purchase', id: 'txn1' });
    expect(again).toMatchObject({ balance: 500, applied: false });
    const parallel = await Promise.all(Array.from({ length: 10 }, () => gems.credit('u1', 500, 'purchase', { type: 'purchase', id: 'txn1' })));
    expect(parallel.every((r) => !r.applied)).toBe(true);
    expect(await balance('u1')).toBe(500);
    expect(await GemLedgerModel.countDocuments()).toBe(1);
    expect((await GemLedgerModel.findOne().lean())!.balanceAfter).toBe(500);
  });

  it('credits without a ref always apply (admin adjustments) and need an existing account', async () => {
    await user('u1', 0);
    await gems.credit('u1', 5, 'admin_adjust');
    await gems.credit('u1', 5, 'admin_adjust');
    expect(await balance('u1')).toBe(10);
    await expect(gems.credit('ghost', 5, 'admin_adjust')).rejects.toMatchObject({ status: 404 });
  });

  it('rejects invalid amounts and treats 0 as a no-op', async () => {
    await user('u1', 5);
    for (const bad of [-1, 1.5, Number.NaN]) {
      await expect(gems.debit('u1', bad, 'gift_sent')).rejects.toMatchObject({ code: 'invalid_gem_amount' });
      await expect(gems.credit('u1', bad, 'refund')).rejects.toMatchObject({ code: 'invalid_gem_amount' });
    }
    expect(await gems.debit('u1', 0, 'gift_sent')).toMatchObject({ balance: 5 });
    expect(await GemLedgerModel.countDocuments()).toBe(0);
  });

  it('withTx commits both writes together, and rolls both back on failure', async () => {
    await user('u1', 100);
    await gems.withTx(async (s) => {
      await gems.debit('u1', 40, 'vip_subscribe', { type: 'vip', id: 'v1' }, s);
    });
    expect(await balance('u1')).toBe(60);

    await expect(
      gems.withTx(async (s) => {
        await gems.debit('u1', 10, 'vip_subscribe', { type: 'vip', id: 'v2' }, s);
        throw new Error('later step failed');
      }),
    ).rejects.toThrow('later step failed');
    expect(await balance('u1')).toBe(60); // rolled back (replica-set test DB)
    expect(await GemLedgerModel.countDocuments()).toBe(1);
  });

  it('DebitGemsCommand can compensate: undo refunds once and leaves an audit trail', async () => {
    await user('u1', 50);
    const cmd = new DebitGemsCommand(gems, 'u1', 20, 'gift_sent', { type: 'gift', id: 'm9' });
    await cmd.execute();
    expect(await balance('u1')).toBe(30);
    await cmd.undo();
    await cmd.undo(); // second undo is a no-op
    expect(await balance('u1')).toBe(50);
    const rows = await GemLedgerModel.find({ userId: 'u1' }).sort({ createdAt: 1 }).lean();
    expect(rows.map((r) => [r.reason, r.delta])).toEqual([['gift_sent', -20], ['refund', 20]]);

    const notRun = new DebitGemsCommand(gems, 'u1', 5, 'gift_sent');
    await notRun.undo(); // never executed → nothing to undo
    expect(await balance('u1')).toBe(50);
  });
});
