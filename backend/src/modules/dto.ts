import { z } from 'zod';
import { PURCHASE_PROVIDERS } from '../infra/db/models/commerce.js';
import { publicUserSchema } from './users/user.schemas.js';

/**
 * Wire contract of the user-facing responses. These schemas are used three ways:
 *  - documented in docs/openapi.json (and turned into typed clients for web/mobile),
 *  - validated against real responses in every non-production run, so the code can't drift from the docs.
 */
export const giftRefSchema = z.object({ id: z.string(), name: z.string(), image: z.string(), cost: z.number() });

export const messageSchema = z.object({
  id: z.string(), senderId: z.string(), receiverId: z.string(), text: z.string(),
  gift: giftRefSchema.optional(), isRead: z.boolean(), createdAt: z.string(),
});

export const relationUserSchema = publicUserSchema.extend({ isFollowing: z.boolean(), isMutualFollow: z.boolean() });

export const conversationSchema = z.object({
  partner: relationUserSchema,
  lastMessage: z.object({ id: z.string(), senderId: z.string(), text: z.string(), isGift: z.boolean() }),
  lastMessageAt: z.string(),
  unreadCount: z.number(),
});

export const countSchema = z.object({ count: z.number() });
export const updatedSchema = z.object({ updated: z.number() });

export const notificationSchema = z.object({
  id: z.string(), type: z.enum(['follow', 'gift', 'message', 'system']),
  from: z.object({ id: z.string(), name: z.string(), username: z.string(), avatar: z.string() }).optional(),
  isRead: z.boolean(), createdAt: z.string(),
});

export const historyEntrySchema = z.object({
  id: z.string(), type: z.enum(['video_chat', 'view']), durationSec: z.number(), createdAt: z.string(),
  partner: z.object({
    id: z.string(), name: z.string(), username: z.string(), avatar: z.string(), country: z.string(), age: z.number().optional(),
    isFollowing: z.boolean(), isMutualFollow: z.boolean(), exists: z.boolean(),
  }),
});

export const followStateSchema = z.object({ isFollowing: z.boolean(), followersCount: z.number(), followingCount: z.number() });
export const likeStateSchema = z.object({ liked: z.boolean(), likesCount: z.number() });

export const giftSchema = z.object({ id: z.string(), name: z.string(), price: z.number(), image: z.string() });
export const giftSendResultSchema = z.object({ message: messageSchema, balance: z.number(), gift: giftSchema });

export const packSchema = z.object({
  id: z.string(), name: z.string(), description: z.string(), price: z.number(), gems: z.number(), popular: z.boolean(),
  googlePayId: z.string().optional(), applePayId: z.string().optional(),
});
export const vipPlanSchema = z.object({
  id: z.string(), name: z.string(), description: z.string(), priceGems: z.number(), durationDays: z.number(), popular: z.boolean(),
});
export const vipSubscribeResultSchema = z.object({ balance: z.number(), vipExpiry: z.string() });

export const checkoutResultSchema = z.object({ url: z.string().optional(), orderId: z.string(), extra: z.record(z.string(), z.unknown()).optional() });
export const fulfilResultSchema = z.object({ balance: z.number(), gems: z.number(), purchaseId: z.string(), alreadyProcessed: z.boolean() });
export const purchaseSchema = z.object({
  id: z.string(), provider: z.enum(PURCHASE_PROVIDERS), packId: z.string(), packName: z.string(), gems: z.number(), amount: z.number(),
  currency: z.string(), status: z.enum(['completed', 'refunded']), createdAt: z.string(),
});

/** The public settings bundle: groups of loosely typed values (see settings.groups.ts publicFields). */
export const publicSettingsSchema = z.object({
  general: z.record(z.string(), z.unknown()).optional(),
  seo: z.record(z.string(), z.unknown()).optional(),
  auth: z.record(z.string(), z.unknown()).optional(),
  payments: z.record(z.string(), z.unknown()).optional(),
  plugins: z.record(z.string(), z.unknown()).optional(),
  pwa: z.record(z.string(), z.unknown()).optional(),
  mobile: z.record(z.string(), z.unknown()).optional(),
  demoMode: z.boolean(),
});

export const footerPageSchema = z.object({ title: z.string(), slug: z.string() });
export const pageSchema = z.object({ title: z.string(), slug: z.string(), content: z.string(), updatedAt: z.string() });
export const languageSchema = z.object({ code: z.string(), name: z.string(), flag: z.string(), rtl: z.boolean() });
export const languageWithTranslationsSchema = languageSchema.extend({ translations: z.record(z.string(), z.string()) });

export const iceServersSchema = z.object({
  iceServers: z.array(z.object({ urls: z.union([z.string(), z.array(z.string())]), username: z.string().optional(), credential: z.string().optional() })),
});
export const onlineSchema = z.object({ onlineUsers: z.number().nullable() });
export const usernameCheckSchema = z.object({ available: z.boolean(), reason: z.enum(['invalid', 'reserved', 'taken']).optional() });
export const installStatusSchema = z.object({ installed: z.boolean(), database: z.object({ connected: z.boolean(), transactions: z.boolean() }) });
