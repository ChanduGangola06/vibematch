import type { UpdateQuery } from 'mongoose';
import { GemLedgerModel } from '../../infra/db/models/commerce.js';
import { UserModel, type UserDoc } from '../../infra/db/models/user.js';

export type UserRecord = UserDoc;

export interface NewUser {
  id?: string;
  username: string;
  name: string;
  email?: string | undefined;
  passwordHash?: string | undefined;
  role: 'guest' | 'user' | 'admin';
  avatar: string;
  gender?: 'male' | 'female' | 'other' | '' | undefined;
  country?: string | undefined;
  countryCode?: string | undefined;
  age?: number | undefined;
  gems?: number;
  isDemo?: boolean;
  authProviders?: { provider: string; providerUid: string }[];
}

/** Persistence for users. Returns plain (lean) records; mapping to DTOs happens in the mapper. */
export class UserRepository {
  async findById(id: string): Promise<UserRecord | null> {
    return UserModel.findOne({ id }).lean<UserRecord>();
  }

  async findByIds(ids: string[]): Promise<UserRecord[]> {
    if (ids.length === 0) return [];
    return UserModel.find({ id: { $in: ids } }).lean<UserRecord[]>();
  }

  async findByUsername(username: string): Promise<UserRecord | null> {
    return UserModel.findOne({ usernameLower: username.toLowerCase() }).lean<UserRecord>();
  }

  async usernameExists(username: string): Promise<boolean> {
    return (await UserModel.exists({ usernameLower: username.toLowerCase() })) !== null;
  }

  /** Includes the password hash — only the auth service should call this. */
  async findForLogin(identifier: string): Promise<UserRecord | null> {
    const id = identifier.toLowerCase();
    return UserModel.findOne({ $or: [{ usernameLower: id }, { emailLower: id }] })
      .select('+passwordHash')
      .lean<UserRecord>();
  }

  async findWithHashById(id: string): Promise<UserRecord | null> {
    return UserModel.findOne({ id }).select('+passwordHash').lean<UserRecord>();
  }

  async findByProvider(provider: string, providerUid: string): Promise<UserRecord | null> {
    return UserModel.findOne({ authProviders: { $elemMatch: { provider, providerUid } } }).lean<UserRecord>();
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    return UserModel.findOne({ emailLower: email.toLowerCase() }).lean<UserRecord>();
  }

  /**
   * Creates the account. The signup bonus is written to the gem ledger in the same call so balance and
   * ledger can never disagree. Throws Mongo duplicate-key errors (code 11000) for taken username/email.
   */
  async create(input: NewUser): Promise<UserRecord> {
    const doc = await UserModel.create({
      ...(input.id ? { id: input.id } : {}),
      username: input.username,
      usernameLower: input.username.toLowerCase(),
      name: input.name,
      ...(input.email ? { email: input.email, emailLower: input.email.toLowerCase() } : {}),
      ...(input.passwordHash ? { passwordHash: input.passwordHash } : {}),
      role: input.role,
      avatar: input.avatar,
      gender: input.gender ?? '',
      country: input.country ?? '',
      countryCode: input.countryCode ?? '',
      ...(input.age != null ? { age: input.age } : {}),
      gems: input.gems ?? 0,
      isDemo: input.isDemo ?? false,
      authProviders: input.authProviders ?? [],
    });
    if ((input.gems ?? 0) > 0) {
      await GemLedgerModel.create({
        userId: doc.id,
        delta: input.gems,
        balanceAfter: input.gems,
        reason: 'signup_bonus',
        refType: 'user',
        refId: doc.id,
      });
    }
    const { passwordHash: _omit, ...rest } = doc.toObject();
    return rest as UserRecord;
  }

  async update(id: string, patch: UpdateQuery<UserDoc>): Promise<UserRecord | null> {
    return UserModel.findOneAndUpdate({ id }, patch, { returnDocument: 'after', runValidators: true }).lean<UserRecord>();
  }

  /** Atomic: increments the counter and sets the lock in one write so concurrent guesses cannot slip past the limit. */
  async recordFailedLogin(id: string, maxAttempts: number, lockMinutes: number): Promise<UserRecord | null> {
    const lockUntil = new Date(Date.now() + lockMinutes * 60_000);
    return UserModel.findOneAndUpdate(
      { id },
      [
        {
          $set: {
            failedLogins: { $add: [{ $ifNull: ['$failedLogins', 0] }, 1] },
            lockedUntil: {
              $cond: [{ $gte: [{ $add: [{ $ifNull: ['$failedLogins', 0] }, 1] }, maxAttempts] }, lockUntil, '$lockedUntil'],
            },
          },
        },
      ],
      { returnDocument: 'after', updatePipeline: true },
    ).lean<UserRecord>();
  }

  async recordSuccessfulLogin(id: string, rehash?: string): Promise<void> {
    await UserModel.updateOne(
      { id },
      { $set: { failedLogins: 0, lastLoginAt: new Date(), isOnline: true, ...(rehash ? { passwordHash: rehash } : {}) }, $unset: { lockedUntil: 1 } },
    );
  }

  async setPasswordHash(id: string, hash: string): Promise<void> {
    await UserModel.updateOne({ id }, { $set: { passwordHash: hash, failedLogins: 0 }, $unset: { lockedUntil: 1 } });
  }

  async addProvider(id: string, provider: string, providerUid: string): Promise<void> {
    await UserModel.updateOne({ id, 'authProviders.provider': { $ne: provider } }, { $push: { authProviders: { provider, providerUid } } });
  }
}
