import type { Cache } from '../../core/cache/index.js';
import type { ApiKeyVerifier, VerifiedApiKey } from '../../middleware/authenticate.js';
import { ApiKeyModel } from './models/auth.js';

/** Looks keys up by SHA-256 hash; revoked/expired keys fail. Positive and negative results are cached briefly. */
export class MongoApiKeyVerifier implements ApiKeyVerifier {
  private lastTouched = new Map<string, number>();

  constructor(
    private readonly cache: Cache,
    private readonly ttlSeconds = 30,
  ) {}

  async verify(hash: string): Promise<VerifiedApiKey | null> {
    const found = await this.cache.wrap<VerifiedApiKey | null>(
      `apikey:${hash}`,
      async () => {
        const k = await ApiKeyModel.findOne({ keyHash: hash, revokedAt: { $exists: false } }).lean();
        if (!k) return null;
        if (k.expiresAt && k.expiresAt.getTime() <= Date.now()) return null;
        return { id: k.id, level: k.level, scopes: k.scopes ?? [] };
      },
      { ttl: this.ttlSeconds, tags: ['apikeys'] },
    );
    if (found) this.touch(found.id);
    return found;
  }

  /** `lastUsedAt` is best-effort and throttled to one write per key per minute. */
  private touch(id: string): void {
    const now = Date.now();
    if ((this.lastTouched.get(id) ?? 0) > now - 60_000) return;
    this.lastTouched.set(id, now);
    void ApiKeyModel.updateOne({ id }, { $set: { lastUsedAt: new Date(now) } }).catch(() => {});
  }
}
