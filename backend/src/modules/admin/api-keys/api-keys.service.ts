import type { Cache } from '../../../core/cache/index.js';
import { NotFoundError } from '../../../core/errors/index.js';
import type { OffsetQuery } from '../../../core/pagination/index.js';
import { toSkipLimit, offsetMeta } from '../../../core/pagination/index.js';
import { generateApiKey, type ApiKeyLevel } from '../../../core/security/api-key.js';
import { ApiKeyModel, type ApiKeyDoc } from '../../../infra/db/models/auth.js';

export interface ApiKeyDto {
  id: string;
  name: string;
  level: ApiKeyLevel;
  scopes: string[];
  /** Safe-to-display hint, e.g. `vm_mobile_Ab3dEf9h_••••` */
  hint: string;
  createdAt: string;
  expiresAt?: string;
  revokedAt?: string;
  lastUsedAt?: string;
}

const toDto = (k: Pick<ApiKeyDoc, 'id' | 'name' | 'level' | 'scopes' | 'prefix' | 'createdAt' | 'expiresAt' | 'revokedAt' | 'lastUsedAt'>): ApiKeyDto => ({
  id: k.id,
  name: k.name,
  level: k.level,
  scopes: k.scopes ?? [],
  hint: `vm_${k.level}_${k.prefix}_••••`,
  createdAt: (k.createdAt ?? new Date(0)).toISOString(),
  ...(k.expiresAt ? { expiresAt: k.expiresAt.toISOString() } : {}),
  ...(k.revokedAt ? { revokedAt: k.revokedAt.toISOString() } : {}),
  ...(k.lastUsedAt ? { lastUsedAt: k.lastUsedAt.toISOString() } : {}),
});

export interface CreateKeyInput {
  name: string;
  level: ApiKeyLevel;
  scopes?: string[] | undefined;
  expiresInDays?: number | undefined;
  createdBy: string;
}

export class ApiKeyService {
  constructor(private readonly cache: Cache) {}

  /** The only time the plain key exists in memory outside the caller's hands. */
  async create(input: CreateKeyInput): Promise<{ key: ApiKeyDto; plain: string }> {
    const gen = generateApiKey(input.level);
    const doc = await ApiKeyModel.create({
      name: input.name,
      prefix: gen.prefix,
      keyHash: gen.hash,
      level: input.level,
      scopes: input.scopes ?? [],
      createdBy: input.createdBy,
      ...(input.expiresInDays ? { expiresAt: new Date(Date.now() + input.expiresInDays * 86_400_000) } : {}),
    });
    return { key: toDto(doc.toObject()), plain: gen.plain };
  }

  async list(q: OffsetQuery, includeRevoked = false) {
    const filter = includeRevoked ? {} : { revokedAt: { $exists: false } };
    const { skip, limit } = toSkipLimit(q);
    const [rows, total] = await Promise.all([
      ApiKeyModel.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
      ApiKeyModel.countDocuments(filter),
    ]);
    return { items: rows.map(toDto), page: offsetMeta(q, total) };
  }

  /** Issues a replacement with identical level/scopes/expiry window and revokes the old key. */
  async rotate(id: string, by: string): Promise<{ key: ApiKeyDto; plain: string; revokedId: string }> {
    const old = await ApiKeyModel.findOne({ id, revokedAt: { $exists: false } }).lean();
    if (!old) throw new NotFoundError('API key');
    const remainingDays = old.expiresAt ? Math.max(1, Math.ceil((old.expiresAt.getTime() - Date.now()) / 86_400_000)) : undefined;
    const created = await this.create({ name: old.name, level: old.level, scopes: old.scopes ?? [], expiresInDays: remainingDays, createdBy: by });
    await this.revoke(id);
    return { ...created, revokedId: id };
  }

  async revoke(id: string): Promise<void> {
    const res = await ApiKeyModel.updateOne({ id, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date() } });
    if (res.matchedCount === 0) throw new NotFoundError('API key');
    await this.cache.invalidateTag('apikeys');
  }
}
