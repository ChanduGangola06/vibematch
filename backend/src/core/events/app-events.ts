import { EventBus } from './event-bus.js';

/** Contract of every domain event in the system (payloads are plain, serialisable data). */
export interface AppEvents {
  'user.registered': { userId: string; email?: string; name: string; isGuest: boolean };
  'user.deleted': { userId: string };
  'follow.created': { followerId: string; followeeId: string };
  'follow.removed': { followerId: string; followeeId: string };
  'user.liked': { targetId: string; likesCount: number };
  'message.sent': {
    messageId: string;
    senderId: string;
    receiverId: string;
    text: string;
    isGift: boolean;
    createdAt: string;
    gift?: { id: string; name: string; image: string; cost: number };
  };
  'gift.sent': { fromId: string; toId: string; giftId: string; cost: number };
  'purchase.completed': { userId: string; purchaseId: string; packName: string; amount: number; gems: number };
  'vip.activated': { userId: string; planId: string; expiresAt: string };
  'match.ended': { userIds: [string, string]; durationSec: number };
  'settings.changed': { group: string };
  'content.changed': { kind: 'packs' | 'vip' | 'gifts' | 'pages' | 'languages' | 'discover' };
  'user.banned': { userId: string; banned: boolean };
  /** A login session (refresh-token family) was ended: its sockets must be dropped. */
  'session.revoked': { sessionId: string };
}

export type AppEventBus = EventBus<AppEvents>;
export const createEventBus = (log?: { error(obj: unknown, msg?: string): void }): AppEventBus =>
  new EventBus<AppEvents>(log);
