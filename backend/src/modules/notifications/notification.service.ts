import type { AppEventBus } from '../../core/events/index.js';
import { keysetPage, type CursorCodec, type Page } from '../../core/pagination/index.js';
import { NotificationModel, type NotificationDoc } from '../../infra/db/models/social.js';
import type { UserRepository } from '../users/user.repository.js';
import type { PushService } from './push.service.js';

export interface NotificationDto {
  id: string;
  type: 'follow' | 'gift' | 'message' | 'system';
  from?: { id: string; name: string; username: string; avatar: string };
  isRead: boolean;
  createdAt: string;
}

const toDto = (n: NotificationDoc): NotificationDto => ({
  id: n.id,
  type: n.type,
  ...(n.fromUserId
    ? { from: { id: n.fromUserId, name: n.fromUserName ?? '', username: n.fromUserUsername ?? '', avatar: n.fromUserAvatar ?? '' } }
    : {}),
  isRead: Boolean(n.isRead),
  createdAt: (n.createdAt ?? new Date(0)).toISOString(),
});

export class NotificationService {
  constructor(
    private readonly events: AppEventBus,
    private readonly users: UserRepository,
    private readonly push: PushService,
    private readonly cursor: CursorCodec,
  ) {}

  /** Observer: translates domain events into notifications (+ push). */
  listen(): void {
    this.events.on('follow.created', ({ followerId, followeeId }) => this.onFollow(followerId, followeeId));
    this.events.on('gift.sent', ({ fromId, toId }) => this.onGift(fromId, toId));
  }

  private async onFollow(followerId: string, followeeId: string): Promise<void> {
    const from = await this.users.findById(followerId);
    if (!from) return;
    // A follow/unfollow loop must not spam the target: one unread follow notice per follower.
    const dup = await NotificationModel.exists({ userId: followeeId, fromUserId: followerId, type: 'follow', isRead: false });
    if (dup) return;
    await NotificationModel.create({
      userId: followeeId, type: 'follow', fromUserId: from.id, fromUserName: from.name || from.username,
      fromUserUsername: from.username, fromUserAvatar: from.avatar ?? '',
    });
    await this.push.sendToUser(followeeId, { title: 'New follower', body: `${from.name || from.username} started following you`, data: { type: 'follow', userId: from.id } });
  }

  private async onGift(fromId: string, toId: string): Promise<void> {
    const from = await this.users.findById(fromId);
    if (!from) return;
    await NotificationModel.create({
      userId: toId, type: 'gift', fromUserId: from.id, fromUserName: from.name || from.username,
      fromUserUsername: from.username, fromUserAvatar: from.avatar ?? '',
    });
    await this.push.sendToUser(toId, { title: 'You received a gift', body: `${from.name || from.username} sent you a gift`, data: { type: 'gift', userId: from.id } });
  }

  async list(userId: string, q: { limit: number; cursor?: string | undefined }): Promise<Page<NotificationDto>> {
    const page = await keysetPage<NotificationDoc>(NotificationModel, this.cursor, { filter: { userId }, ...q });
    return { items: page.items.map(toDto), page: page.page };
  }

  unreadCount(userId: string): Promise<number> {
    return NotificationModel.countDocuments({ userId, isRead: false });
  }

  /** Scoped by owner: another user's notification id is indistinguishable from a missing one (BOLA-safe). */
  async markRead(userId: string, id: string): Promise<boolean> {
    return (await NotificationModel.updateOne({ id, userId }, { $set: { isRead: true } })).matchedCount === 1;
  }

  async markAllRead(userId: string): Promise<number> {
    return (await NotificationModel.updateMany({ userId, isRead: false }, { $set: { isRead: true } })).modifiedCount;
  }
}
