import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearTestDb, startTestDb, stopTestDb } from '../helpers/mongo.js';

describe('test harness', () => {
  beforeAll(async () => {
    await startTestDb();
  });
  afterAll(stopTestDb);

  it('connects to an in-memory replica set and can clear data', async () => {
    const col = mongoose.connection.collection('smoke');
    await col.insertOne({ a: 1 });
    expect(await col.countDocuments()).toBe(1);
    await clearTestDb();
    expect(await col.countDocuments()).toBe(0);
  });

  it('supports transactions (replica set)', async () => {
    const session = await mongoose.connection.startSession();
    await session.withTransaction(async () => {
      await mongoose.connection.collection('smoke').insertOne({ b: 1 }, { session });
    });
    await session.endSession();
    expect(await mongoose.connection.collection('smoke').countDocuments()).toBe(1);
  });
});
