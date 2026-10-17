import { IdempotencyModel } from './models/auth.js';
import type { IdempotencyStore, StoredRecord } from '../../middleware/idempotency.js';

export class MongoIdempotencyStore implements IdempotencyStore {
  async claim(rec: { scope: string; key: string; route: string; requestHash: string; expiresAt: Date }): Promise<StoredRecord | null> {
    try {
      await IdempotencyModel.create({ ...rec, status: 'in_progress' });
      return null;
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
      const existing = await IdempotencyModel.findOne({ scope: rec.scope, key: rec.key, route: rec.route }).lean();
      if (!existing) return this.claim(rec); // expired between insert and read
      return {
        requestHash: existing.requestHash,
        status: existing.status,
        responseStatus: existing.responseStatus ?? undefined,
        responseBody: existing.responseBody,
      };
    }
  }

  async complete(scope: string, key: string, route: string, responseStatus: number, responseBody: unknown): Promise<void> {
    await IdempotencyModel.updateOne({ scope, key, route }, { $set: { status: 'completed', responseStatus, responseBody } });
  }

  async release(scope: string, key: string, route: string): Promise<void> {
    await IdempotencyModel.deleteOne({ scope, key, route, status: 'in_progress' });
  }
}
