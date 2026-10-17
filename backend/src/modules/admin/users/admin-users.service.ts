import type { Cache } from '../../../core/cache/index.js';
import type { AppEventBus } from '../../../core/events/index.js';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../../../core/errors/index.js';
import { offsetMeta, toSkipLimit, type OffsetQuery } from '../../../core/pagination/index.js';
import { UserModel, type UserDoc } from '../../../infra/db/models/user.js';
import type { GemService } from '../../ledger/gem.service.js';
import type { SessionService } from '../../auth/session.service.js';
import { escapeRegex } from '../../content/page.service.js';
import { toAdminUser } from '../../users/user.mapper.js';
import type { UserRepository } from '../../users/user.repository.js';
import type { AdminUser } from '../../users/user.schemas.js';
import type { UserService } from '../../users/user.service.js';

export interface AdminUserFilter {
  q?: string | undefined;
  role?: 'guest' | 'user' | 'admin' | undefined;
  banned?: boolean | undefined;
  vip?: boolean | undefined;
}

const SAFE_PATCH = ['name', 'email', 'phone', 'address', 'bio', 'gender', 'age', 'country', 'countryCode', 'avatar'] as const;
export type AdminUserPatch = Partial<Record<(typeof SAFE_PATCH)[number], string | number>>;

export class AdminUserService {
  constructor(
    private readonly users: UserRepository,
    private readonly userService: UserService,
    private readonly sessions: SessionService,
    private readonly gems: GemService,
    private readonly events: AppEventBus,
    private readonly cache: Cache,
  ) {}

  async list(q: OffsetQuery & AdminUserFilter): Promise<{ items: AdminUser[]; page: ReturnType<typeof offsetMeta> }> {
    // Demo personas have their own screen; they are never listed with real people.
    const filter: Record<string, unknown> = { isDemo: { $ne: true } };
    if (q.role) filter.role = q.role;
    if (q.banned !== undefined) filter.isBanned = q.banned;
    if (q.vip !== undefined) filter.vipExpiry = q.vip ? { $gt: new Date() } : { $not: { $gt: new Date() } };
    if (q.q) {
      const rx = { $regex: escapeRegex(q.q), $options: 'i' };
      filter.$or = [{ username: rx }, { name: rx }, { email: rx }, { id: q.q }];
    }
    const { skip, limit } = toSkipLimit(q);
    const [rows, total] = await Promise.all([
      UserModel.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
      UserModel.countDocuments(filter),
    ]);
    return { items: rows.map((r) => toAdminUser(r as UserDoc)), page: offsetMeta(q, total) };
  }

  async get(id: string): Promise<AdminUser> {
    const u = await this.users.findById(id);
    if (!u) throw new NotFoundError('User');
    return toAdminUser(u);
  }

  async patch(id: string, patch: AdminUserPatch): Promise<AdminUser> {
    const $set: Record<string, unknown> = {};
    for (const k of SAFE_PATCH) if (patch[k] !== undefined) $set[k] = patch[k];
    if (typeof patch.email === 'string') {
      $set.email = patch.email;
      $set.emailLower = patch.email.toLowerCase();
    }
    try {
      const updated = await this.users.update(id, { $set });
      if (!updated) throw new NotFoundError('User');
      return toAdminUser(updated);
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw new ConflictError('This e-mail address is already registered', 'email_taken');
      throw err;
    }
  }

  async adjustGems(id: string, amount: number): Promise<{ balance: number }> {
    if (amount === 0) throw new BadRequestError('Amount must not be zero');
    const r = amount > 0 ? await this.gems.credit(id, amount, 'admin_adjust') : await this.gems.debit(id, -amount, 'admin_adjust');
    return { balance: r.balance };
  }

  async setBanned(actorId: string, id: string, banned: boolean): Promise<AdminUser> {
    const target = await this.guardTarget(actorId, id, 'ban');
    const updated = await this.users.update(target.id, { $set: { isBanned: banned, ...(banned ? { isOnline: false } : {}) } });
    if (banned) await this.sessions.revokeAllForUser(id);
    await this.cache.invalidateTag(`user:${id}`);
    this.events.emit('user.banned', { userId: id, banned });
    return toAdminUser(updated!);
  }

  async setRole(actorId: string, id: string, role: 'user' | 'admin'): Promise<AdminUser> {
    if (actorId === id) throw new ForbiddenError('You cannot change your own role', 'self_action');
    const target = await this.users.findById(id);
    if (!target) throw new NotFoundError('User');
    if (target.role === 'guest') throw new BadRequestError('Guest accounts cannot be promoted');
    const updated = await this.users.update(id, { $set: { role } });
    // Existing sessions keep their id but the role is read from the DB (cached ≤ 15 s); drop the cache for immediacy.
    await this.cache.invalidateTag(`user:${id}`);
    await this.sessions.revokeAllForUser(id);
    return toAdminUser(updated!);
  }

  async remove(actorId: string, id: string): Promise<void> {
    const target = await this.guardTarget(actorId, id, 'delete');
    await this.userService.erase(target);
    await this.cache.invalidateTag(`user:${id}`);
    this.events.emit('user.deleted', { userId: id });
  }

  /** Admins cannot act on themselves or on other admins (demote first). */
  private async guardTarget(actorId: string, id: string, what: string) {
    if (actorId === id) throw new ForbiddenError(`You cannot ${what} your own account`, 'self_action');
    const target = await this.users.findById(id);
    if (!target) throw new NotFoundError('User');
    if (target.role === 'admin') throw new ForbiddenError(`Administrators cannot be ${what === 'ban' ? 'banned' : 'deleted'}; remove the admin role first`, 'admin_protected');
    return target;
  }
}
