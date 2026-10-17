import { FollowModel, LikeModel, MatchModel, type FollowDoc } from '../../infra/db/models/social.js';
import { UserModel } from '../../infra/db/models/user.js';

export interface Relationship {
  /** The viewer follows this user. */
  isFollowing: boolean;
  /** This user follows the viewer. */
  followsMe: boolean;
}

const isDuplicate = (err: unknown) => (err as { code?: number })?.code === 11000;

export class SocialRepository {
  /** @returns true when the edge was created, false when it already existed (idempotent). */
  async follow(followerId: string, followeeId: string): Promise<boolean> {
    try {
      await FollowModel.create({ followerId, followeeId });
    } catch (err) {
      if (isDuplicate(err)) return false;
      throw err;
    }
    await Promise.all([
      UserModel.updateOne({ id: followeeId }, { $inc: { followersCount: 1 } }),
      UserModel.updateOne({ id: followerId }, { $inc: { followingCount: 1 } }),
    ]);
    return true;
  }

  async unfollow(followerId: string, followeeId: string): Promise<boolean> {
    const res = await FollowModel.deleteOne({ followerId, followeeId });
    if (res.deletedCount === 0) return false;
    await Promise.all([
      UserModel.updateOne({ id: followeeId, followersCount: { $gt: 0 } }, { $inc: { followersCount: -1 } }),
      UserModel.updateOne({ id: followerId, followingCount: { $gt: 0 } }, { $inc: { followingCount: -1 } }),
    ]);
    return true;
  }

  /** Two indexed queries for any number of users — replaces the per-row lookups of the legacy code. */
  async relationships(viewerId: string, userIds: string[]): Promise<Map<string, Relationship>> {
    const out = new Map<string, Relationship>(userIds.map((id) => [id, { isFollowing: false, followsMe: false }]));
    if (!viewerId || userIds.length === 0) return out;
    const [following, followers] = await Promise.all([
      FollowModel.find({ followerId: viewerId, followeeId: { $in: userIds } }, { followeeId: 1 }).lean(),
      FollowModel.find({ followeeId: viewerId, followerId: { $in: userIds } }, { followerId: 1 }).lean(),
    ]);
    for (const f of following) out.get(f.followeeId)!.isFollowing = true;
    for (const f of followers) out.get(f.followerId)!.followsMe = true;
    return out;
  }

  async isMutual(a: string, b: string): Promise<boolean> {
    const n = await FollowModel.countDocuments({
      $or: [{ followerId: a, followeeId: b }, { followerId: b, followeeId: a }],
    });
    return n === 2;
  }

  async like(likerId: string, targetId: string): Promise<boolean> {
    try {
      await LikeModel.create({ likerId, targetId });
    } catch (err) {
      if (isDuplicate(err)) return false;
      throw err;
    }
    return true;
  }

  async unlike(likerId: string, targetId: string): Promise<boolean> {
    return (await LikeModel.deleteOne({ likerId, targetId })).deletedCount === 1;
  }

  async likedSet(likerId: string, targetIds: string[]): Promise<Set<string>> {
    if (targetIds.length === 0) return new Set();
    const rows = await LikeModel.find({ likerId, targetId: { $in: targetIds } }, { targetId: 1 }).lean();
    return new Set(rows.map((r) => r.targetId));
  }

  /** Records a profile view at most once per viewer/target per 24 h. */
  async recordView(viewerId: string, targetId: string, snapshot: { name?: string; username?: string; avatar?: string; country?: string; age?: number }): Promise<boolean> {
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const recent = await MatchModel.exists({ userId: targetId, partnerId: viewerId, type: 'view', createdAt: { $gt: since } });
    if (recent) return false;
    await MatchModel.create({ userId: targetId, partnerId: viewerId, type: 'view', partner: snapshot });
    return true;
  }

  /** Raw keyset page of follow edges; the service maps ids → users. */
  followFilter(userId: string, direction: 'followers' | 'following'): Record<string, unknown> {
    return direction === 'followers' ? { followeeId: userId } : { followerId: userId };
  }
}

export type { FollowDoc };
