import type { AppEventBus } from '../../core/events/index.js';
import { BadRequestError, NotFoundError } from '../../core/errors/index.js';
import { keysetPage, type CursorCodec, type Page } from '../../core/pagination/index.js';
import { FollowModel, type FollowDoc } from '../../infra/db/models/social.js';
import type { UserRepository } from '../users/user.repository.js';
import { toPublicUser } from '../users/user.mapper.js';
import type { PublicUser } from '../users/user.schemas.js';
import type { SocialRepository } from './social.repository.js';

export interface FollowState {
  isFollowing: boolean;
  followersCount: number;
  followingCount: number;
}

export type PublicUserWithRelation = PublicUser & { isFollowing: boolean; isMutualFollow: boolean };

export class SocialService {
  constructor(
    private readonly repo: SocialRepository,
    private readonly users: UserRepository,
    private readonly events: AppEventBus,
    private readonly cursor: CursorCodec,
  ) {}

  private async requireTarget(id: string) {
    const target = await this.users.findById(id);
    if (!target || target.isBanned) throw new NotFoundError('User');
    return target;
  }

  async follow(me: string, targetId: string): Promise<FollowState> {
    if (me === targetId) throw new BadRequestError('You cannot follow yourself');
    const target = await this.requireTarget(targetId);
    const created = await this.repo.follow(me, targetId);
    if (created) this.events.emit('follow.created', { followerId: me, followeeId: targetId });
    const mine = await this.users.findById(me);
    return {
      isFollowing: true,
      followersCount: (target.followersCount ?? 0) + (created ? 1 : 0),
      followingCount: mine?.followingCount ?? 0,
    };
  }

  async unfollow(me: string, targetId: string): Promise<FollowState> {
    const removed = await this.repo.unfollow(me, targetId);
    if (removed) this.events.emit('follow.removed', { followerId: me, followeeId: targetId });
    const [target, mine] = await Promise.all([this.users.findById(targetId), this.users.findById(me)]);
    return { isFollowing: false, followersCount: target?.followersCount ?? 0, followingCount: mine?.followingCount ?? 0 };
  }

  async like(me: string, targetId: string): Promise<{ liked: true; likesCount: number }> {
    if (me === targetId) throw new BadRequestError('You cannot like yourself');
    await this.requireTarget(targetId);
    const created = await this.repo.like(me, targetId);
    const target = await this.incLikes(targetId, created ? 1 : 0);
    if (created) this.events.emit('user.liked', { targetId, likesCount: target });
    return { liked: true, likesCount: target };
  }

  async unlike(me: string, targetId: string): Promise<{ liked: false; likesCount: number }> {
    const removed = await this.repo.unlike(me, targetId);
    const count = await this.incLikes(targetId, removed ? -1 : 0);
    return { liked: false, likesCount: count };
  }

  private async incLikes(targetId: string, delta: number): Promise<number> {
    if (delta === 0) return (await this.users.findById(targetId))?.likesCount ?? 0;
    const updated = await this.users.update(
      targetId,
      delta > 0 ? { $inc: { likesCount: 1 } } : { $inc: { likesCount: -1 } },
    );
    return Math.max(0, updated?.likesCount ?? 0);
  }

  async view(me: string, role: string, targetId: string): Promise<void> {
    if (me === targetId || role === 'admin') return;
    const [viewer, target] = await Promise.all([this.users.findById(me), this.users.findById(targetId)]);
    if (!viewer || !target) return;
    await this.repo.recordView(me, targetId, {
      name: viewer.name ?? '', username: viewer.username, avatar: viewer.avatar ?? '', country: viewer.country ?? '', ...(viewer.age != null ? { age: viewer.age } : {}),
    });
  }

  /** Decorates users with the viewer's relationship to each (batch, no N+1). */
  async withRelations(viewerId: string | undefined, users: Parameters<typeof toPublicUser>[0][]): Promise<PublicUserWithRelation[]> {
    const rel = viewerId ? await this.repo.relationships(viewerId, users.map((u) => u.id)) : undefined;
    return users.map((u) => {
      const r = rel?.get(u.id);
      return { ...toPublicUser(u), isFollowing: r?.isFollowing ?? false, isMutualFollow: Boolean(r?.isFollowing && r.followsMe) };
    });
  }

  async list(viewerId: string | undefined, userId: string, direction: 'followers' | 'following', q: { limit: number; cursor?: string | undefined }): Promise<Page<PublicUserWithRelation>> {
    const page = await keysetPage<FollowDoc>(FollowModel, this.cursor, {
      filter: this.repo.followFilter(userId, direction), limit: q.limit, cursor: q.cursor,
    });
    const ids = page.items.map((e) => (direction === 'followers' ? e.followerId : e.followeeId));
    const found = await this.users.findByIds(ids);
    const byId = new Map(found.map((u) => [u.id, u]));
    const ordered = ids.flatMap((id) => {
      const u = byId.get(id);
      return u && !u.isBanned ? [u] : [];
    });
    return { items: await this.withRelations(viewerId, ordered), page: page.page };
  }
}
