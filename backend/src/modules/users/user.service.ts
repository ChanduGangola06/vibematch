import { randomBytes } from 'node:crypto';
import type { Cache } from '../../core/cache/index.js';
import type { AppEventBus } from '../../core/events/index.js';
import { BadRequestError, ConflictError, NotFoundError, UnauthorizedError } from '../../core/errors/index.js';
import { verifyPassword } from '../../core/security/index.js';
import type { Env } from '../../config/env.js';
import { sniffImage } from '../../middleware/upload.js';
import type { StoragePort } from '../../infra/storage/index.js';
import {
  ConversationModel, FollowModel, LikeModel, MatchModel, MessageModel, NotificationModel, ReportModel,
} from '../../infra/db/models/social.js';
import { AuthCredentialModel, RefreshTokenModel } from '../../infra/db/models/auth.js';
import { UserModel } from '../../infra/db/models/user.js';
import type { SessionService } from '../auth/session.service.js';
import type { SocialService, PublicUserWithRelation } from '../social/social.service.js';
import { toSelfUser } from './user.mapper.js';
import type { UserRepository, UserRecord } from './user.repository.js';
import { USERNAME_RE, usernameSchema, type SelfUser } from './user.schemas.js';
import type { UpdateProfileInput } from './user.http-schemas.js';

export interface StorageProvider {
  get(): Promise<StoragePort>;
}

const DEFAULT_AVATAR = /^\/images\/avatars\//;
const OWN_UPLOAD = /^\/images\/users\//;
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

export class UserService {
  constructor(
    private readonly env: Env,
    private readonly users: UserRepository,
    private readonly social: SocialService,
    private readonly sessions: SessionService,
    private readonly storage: StorageProvider,
    private readonly events: AppEventBus,
    private readonly cache: Cache,
  ) {}

  async checkUsername(raw: string): Promise<{ available: boolean; reason?: 'invalid' | 'reserved' | 'taken' }> {
    if (!USERNAME_RE.test(raw)) return { available: false, reason: 'invalid' };
    const parsed = usernameSchema.safeParse(raw);
    if (!parsed.success) return { available: false, reason: 'reserved' };
    return (await this.users.usernameExists(parsed.data)) ? { available: false, reason: 'taken' } : { available: true };
  }

  /** Public profile by id or username, decorated with the viewer's relationship. */
  async profile(viewerId: string | undefined, key: { id: string } | { username: string }): Promise<PublicUserWithRelation> {
    const user = 'id' in key ? await this.users.findById(key.id) : await this.users.findByUsername(key.username);
    if (!user || user.isBanned) throw new NotFoundError('User');
    const [withRel] = await this.social.withRelations(viewerId, [user]);
    return withRel!;
  }

  async updateMe(userId: string, input: UpdateProfileInput): Promise<SelfUser> {
    const current = await this.users.findById(userId);
    if (!current) throw new NotFoundError('Account');

    const $set: Record<string, unknown> = {};
    for (const key of ['name', 'bio', 'age', 'gender', 'phone', 'address', 'country', 'countryCode', 'avatar'] as const) {
      if (input[key] !== undefined) $set[key] = input[key];
    }
    if (input.username !== undefined && input.username !== current.username) {
      $set.username = input.username;
      $set.usernameLower = input.username;
    }
    // Switching gender swaps a *default* avatar for one of the matching gender (uploaded photos are kept).
    if (input.gender && input.avatar === undefined && DEFAULT_AVATAR.test(current.avatar ?? '') && input.gender !== current.gender) {
      const g = input.gender === 'male' || input.gender === 'female' ? input.gender : (Math.random() < 0.5 ? 'male' : 'female');
      $set.avatar = `/images/avatars/${g}-${Math.floor(Math.random() * 10) + 1}.svg`;
    }
    if (input.avatar !== undefined) await this.dropUploadedAvatar(current);

    try {
      const updated = await this.users.update(userId, { $set });
      if (!updated) throw new NotFoundError('Account');
      return toSelfUser(updated);
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw new ConflictError('This username is already taken', 'username_taken');
      throw err;
    }
  }

  async uploadAvatar(userId: string, file: Buffer | undefined): Promise<SelfUser> {
    if (!file) throw new BadRequestError('An image file is required (field "avatar", png/jpeg/webp/gif, max 2 MB)');
    if (file.length > MAX_AVATAR_BYTES) throw new BadRequestError('Image is too large');
    const kind = sniffImage(file);
    if (!kind) throw new BadRequestError('File content is not a supported image (png, jpeg, webp, gif)');

    const current = await this.users.findById(userId);
    if (!current) throw new NotFoundError('Account');
    const store = await this.storage.get();
    const key = `users/${userId}-${randomBytes(6).toString('hex')}.${kind.ext}`;
    const stored = await store.put(key, file, kind.mime);

    await this.dropUploadedAvatar(current);
    const updated = await this.users.update(userId, { $set: { avatar: stored.url } });
    return toSelfUser(updated!);
  }

  private async dropUploadedAvatar(user: UserRecord): Promise<void> {
    if (!user.avatar || !OWN_UPLOAD.test(user.avatar)) return;
    try {
      await (await this.storage.get()).delete(user.avatar.replace(/^\/images\//, '').split('?')[0]!);
    } catch {
      /* orphaned file is harmless; do not fail the request */
    }
  }

  /**
   * GDPR-style erasure: removes the account and everything that identifies it. Financial records
   * (purchases, gem ledger) are retained for accounting under the user id only.
   */
  async deleteMe(userId: string, password?: string): Promise<void> {
    const user = await this.users.findWithHashById(userId);
    if (!user) throw new NotFoundError('Account');
    if (user.passwordHash) {
      if (!password) throw new BadRequestError('Password confirmation is required to delete this account');
      const check = await verifyPassword(password, user.passwordHash, this.env.BCRYPT_COST);
      if (!check.valid) throw new UnauthorizedError('Password is incorrect', 'invalid_credentials');
    }

    await this.erase(user);
  }

  /** Removes an account and its personal data. Used by self-service deletion and by admins. */
  async erase(user: UserRecord): Promise<void> {
    const userId = user.id;
    await this.sessions.revokeAllForUser(userId);
    await this.dropUploadedAvatar(user);

    const following = await FollowModel.find({ followerId: userId }, { followeeId: 1 }).lean();
    const followers = await FollowModel.find({ followeeId: userId }, { followerId: 1 }).lean();
    const likes = await LikeModel.find({ likerId: userId }, { targetId: 1 }).lean();

    await Promise.all([
      FollowModel.deleteMany({ $or: [{ followerId: userId }, { followeeId: userId }] }),
      LikeModel.deleteMany({ $or: [{ likerId: userId }, { targetId: userId }] }),
      NotificationModel.deleteMany({ $or: [{ userId }, { fromUserId: userId }] }),
      MessageModel.deleteMany({ $or: [{ senderId: userId }, { receiverId: userId }] }),
      ConversationModel.deleteMany({ participants: userId }),
      MatchModel.deleteMany({ $or: [{ userId }, { partnerId: userId }] }),
      ReportModel.deleteMany({ reporterId: userId }),
      RefreshTokenModel.deleteMany({ userId }),
      AuthCredentialModel.deleteMany({ userId }),
    ]);

    // Keep other people's counters honest.
    await Promise.all([
      following.length ? UserModel.updateMany({ id: { $in: following.map((f) => f.followeeId) }, followersCount: { $gt: 0 } }, { $inc: { followersCount: -1 } }) : null,
      followers.length ? UserModel.updateMany({ id: { $in: followers.map((f) => f.followerId) }, followingCount: { $gt: 0 } }, { $inc: { followingCount: -1 } }) : null,
      likes.length ? UserModel.updateMany({ id: { $in: likes.map((l) => l.targetId) }, likesCount: { $gt: 0 } }, { $inc: { likesCount: -1 } }) : null,
    ]);

    await UserModel.deleteOne({ id: userId });
    await this.cache.invalidateTag(`user:${userId}`);
    this.events.emit('user.deleted', { userId });
  }
}
