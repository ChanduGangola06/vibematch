import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbHealth } from '../../../src/infra/db/index.js';
import {
  FollowModel, GemLedgerModel, MessageModel, PurchaseModel, UserModel, allModels, syncIndexes,
  ApiKeyModel, PageModel,
} from '../../../src/infra/db/models/index.js';
import { startTestDb, stopTestDb } from '../../helpers/mongo.js';

describe('models & indexes', () => {
  beforeAll(async () => {
    await startTestDb();
    await syncIndexes();
  });
  afterAll(stopTestDb);

  it('creates every declared index without error', async () => {
    for (const m of allModels) {
      const idx = await m.collection.indexes();
      expect(idx.length).toBeGreaterThan(0);
    }
  });

  it('assigns ids and keeps passwordHash out of default queries', async () => {
    const u = await UserModel.create({ username: 'Bob', usernameLower: 'bob', passwordHash: 'h' });
    expect(u.id).toMatch(/^[0-9a-f-]{36}$/);
    const found = await UserModel.findOne({ usernameLower: 'bob' }).lean();
    expect(found).not.toHaveProperty('passwordHash');
    const withHash = (await UserModel.findOne({ usernameLower: 'bob' }).select('+passwordHash').lean()) as { passwordHash?: string } | null;
    expect(withHash?.passwordHash).toBe('h');
  });

  it('enforces unique username and (sparse) email', async () => {
    await expect(UserModel.create({ username: 'BOB', usernameLower: 'bob' })).rejects.toMatchObject({ code: 11000 });
    await UserModel.create({ username: 'a1', usernameLower: 'a1' });
    await UserModel.create({ username: 'a2', usernameLower: 'a2' }); // no email → not indexed
    await UserModel.create({ username: 'e1', usernameLower: 'e1', emailLower: 'x@y.z' });
    await expect(UserModel.create({ username: 'e2', usernameLower: 'e2', emailLower: 'x@y.z' })).rejects.toMatchObject({ code: 11000 });
  });

  it('validates fields', async () => {
    await expect(UserModel.create({ username: 'v', usernameLower: 'v', gems: -1 })).rejects.toThrow(/gems/);
    await expect(UserModel.create({ username: 'v2', usernameLower: 'v2', age: 5 })).rejects.toThrow(/age/);
    await expect(PageModel.create({ title: 't', slug: 'Bad Slug!' })).rejects.toThrow(/slug/);
  });

  it('prevents duplicate follows, purchases and ledger credits', async () => {
    await FollowModel.create({ followerId: 'a', followeeId: 'b' });
    await expect(FollowModel.create({ followerId: 'a', followeeId: 'b' })).rejects.toMatchObject({ code: 11000 });

    const p = { userId: 'u', provider: 'stripe', providerTxnId: 'cs_1', packId: 'p', gems: 10, amount: 1 } as const;
    await PurchaseModel.create(p);
    await expect(PurchaseModel.create(p)).rejects.toMatchObject({ code: 11000 });
    await PurchaseModel.create({ ...p, providerTxnId: 'cs_2', receiptHash: 'h1' });
    await expect(PurchaseModel.create({ ...p, providerTxnId: 'cs_3', receiptHash: 'h1' })).rejects.toMatchObject({ code: 11000 });

    const l = { userId: 'u', delta: 10, balanceAfter: 10, reason: 'purchase', refType: 'purchase', refId: 'cs_1' } as const;
    await GemLedgerModel.create(l);
    await expect(GemLedgerModel.create(l)).rejects.toMatchObject({ code: 11000 });
    await GemLedgerModel.create({ userId: 'u', delta: 1, balanceAfter: 11, reason: 'admin_adjust' });
    await GemLedgerModel.create({ userId: 'u', delta: 1, balanceAfter: 12, reason: 'admin_adjust' }); // no ref → allowed repeatedly
  });

  it('messages cap text length; api keys store only hashes', async () => {
    await expect(MessageModel.create({ senderId: 'a', receiverId: 'b', conversationKey: 'a:b', text: 'x'.repeat(2001) })).rejects.toThrow(/text/);
    const k = await ApiKeyModel.create({ name: 'n', prefix: 'abcdefgh', keyHash: 'deadbeef', level: 'mobile' });
    expect(JSON.stringify(k.toObject())).not.toMatch(/vm_mobile/);
    await expect(ApiKeyModel.create({ name: 'n2', prefix: 'abcdefgh', keyHash: 'deadbeef', level: 'mobile' })).rejects.toMatchObject({ code: 11000 });
    await expect(ApiKeyModel.create({ name: 'n3', prefix: 'abcdefgh', keyHash: 'x', level: 'root' as never })).rejects.toThrow(/level/);
  });

  it('reports database health', async () => {
    const h = await dbHealth(20);
    expect(h.state).toBe('connected');
    expect(h.pingMs).not.toBeNull();
    expect(h.poolMax).toBe(20);
    expect(mongoose.connection.readyState).toBe(1);
  });
});
