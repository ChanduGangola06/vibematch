import type { AppEventBus } from '../../core/events/index.js';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../core/errors/index.js';
import { keysetPage, type CursorCodec, type Page } from '../../core/pagination/index.js';
import {
  ConversationModel, MatchModel, MessageModel, type ConversationDoc, type MessageDoc,
} from '../../infra/db/models/social.js';
import type { SocialRepository } from '../social/social.repository.js';
import type { SocialService, PublicUserWithRelation } from '../social/social.service.js';
import type { UserRecord, UserRepository } from '../users/user.repository.js';

export interface GiftRef {
  id: string;
  name: string;
  image: string;
  cost: number;
}

export interface MessageDto {
  id: string;
  senderId: string;
  receiverId: string;
  text: string;
  gift?: GiftRef;
  isRead: boolean;
  createdAt: string;
}

export interface ConversationDto {
  partner: PublicUserWithRelation;
  lastMessage: { id: string; senderId: string; text: string; isGift: boolean };
  lastMessageAt: string;
  unreadCount: number;
}

/** Stable id of the 1:1 thread between two users. */
export const conversationKey = (a: string, b: string): string => (a < b ? `${a}:${b}` : `${b}:${a}`);

export const toMessageDto = (m: Pick<MessageDoc, 'id' | 'senderId' | 'receiverId' | 'text' | 'gift' | 'isRead' | 'createdAt'>): MessageDto => ({
  id: m.id,
  senderId: m.senderId,
  receiverId: m.receiverId,
  text: m.text ?? '',
  ...(m.gift?.id ? { gift: { id: m.gift.id, name: m.gift.name ?? '', image: m.gift.image ?? '', cost: m.gift.cost ?? 0 } } : {}),
  isRead: Boolean(m.isRead),
  createdAt: (m.createdAt ?? new Date(0)).toISOString(),
});

const MAX_TEXT = 2000;
/** Control characters (except newline/tab) have no place in chat text and can break clients/logs. */
// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const cleanText = (t: string): string => t.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();

export interface SendOptions {
  /** Live-call chat between matched peers: the match itself is the permission. */
  skipPermission?: boolean;
  gift?: GiftRef;
  /** Pre-allocated message id (lets a caller reference the message in the gem ledger). */
  id?: string;
}

export class ChatService {
  constructor(
    private readonly users: UserRepository,
    private readonly socialRepo: SocialRepository,
    private readonly social: SocialService,
    private readonly events: AppEventBus,
    private readonly cursor: CursorCodec,
  ) {}

  /** Mutual follow, a previous match, or a special account (admin / demo) allows messaging. */
  async canMessage(sender: UserRecord, receiver: UserRecord): Promise<boolean> {
    if (sender.role === 'admin' || receiver.role === 'admin' || sender.isDemo || receiver.isDemo) return true;
    if (await this.socialRepo.isMutual(sender.id, receiver.id)) return true;
    const matched = await MatchModel.exists({
      type: 'video_chat',
      $or: [{ userId: sender.id, partnerId: receiver.id }, { userId: receiver.id, partnerId: sender.id }],
    });
    return matched !== null;
  }

  async send(senderId: string, receiverId: string, rawText: string, opts: SendOptions = {}): Promise<MessageDto> {
    if (senderId === receiverId) throw new BadRequestError('You cannot message yourself');
    const text = cleanText(rawText);
    if (!text && !opts.gift) throw new BadRequestError('Message text is required');
    if (text.length > MAX_TEXT) throw new BadRequestError(`Message is limited to ${MAX_TEXT} characters`);

    const [sender, receiver] = await Promise.all([this.users.findById(senderId), this.users.findById(receiverId)]);
    if (!sender) throw new NotFoundError('Sender');
    if (!receiver || receiver.isBanned) throw new NotFoundError('User');
    if (!opts.skipPermission && !(await this.canMessage(sender, receiver))) {
      throw new ForbiddenError('You can only message people you follow each other with or have matched with', 'chat_not_allowed');
    }

    const key = conversationKey(senderId, receiverId);
    const msg = await MessageModel.create({
      ...(opts.id ? { id: opts.id } : {}),
      senderId, receiverId, conversationKey: key, text,
      ...(opts.gift ? { gift: opts.gift } : {}),
    });
    await ConversationModel.updateOne(
      { key },
      {
        $set: {
          lastMessage: { id: msg.id, senderId, text: text || opts.gift?.name || '', isGift: Boolean(opts.gift) },
          lastMessageAt: msg.createdAt,
          participants: [senderId, receiverId].sort(),
        },
        $inc: { [`unread.${receiverId}`]: 1 },
      },
      { upsert: true },
    );
    this.events.emit('message.sent', {
      messageId: msg.id, senderId, receiverId, text, isGift: Boolean(opts.gift),
      createdAt: (msg.createdAt ?? new Date()).toISOString(), ...(opts.gift ? { gift: opts.gift } : {}),
    });
    return toMessageDto(msg.toObject());
  }

  async listMessages(me: string, partnerId: string, q: { limit: number; cursor?: string | undefined }): Promise<Page<MessageDto>> {
    const key = conversationKey(me, partnerId);
    const conv = await ConversationModel.findOne({ key }, { clearedAt: 1 }).lean();
    const cleared = (conv?.clearedAt as Record<string, Date> | undefined)?.[me];
    const page = await keysetPage<MessageDoc>(MessageModel, this.cursor, {
      filter: { conversationKey: key, ...(cleared ? { createdAt: { $gt: new Date(cleared) } } : {}) },
      ...q,
    });
    return { items: page.items.map(toMessageDto), page: page.page };
  }

  async listConversations(me: string, q: { limit: number; cursor?: string | undefined }): Promise<Page<ConversationDto>> {
    const page = await keysetPage<ConversationDoc>(ConversationModel, this.cursor, {
      sortField: 'lastMessageAt',
      limit: q.limit,
      cursor: q.cursor,
      filter: {
        participants: me,
        // hide threads the user cleared, until a newer message arrives
        $or: [{ [`clearedAt.${me}`]: { $exists: false } }, { $expr: { $gt: ['$lastMessageAt', `$clearedAt.${me}`] } }],
      },
    });
    const partnerIds = page.items.map((c) => c.participants.find((p) => p !== me)!);
    const partners = await this.users.findByIds(partnerIds);
    const byId = new Map(partners.map((p) => [p.id, p]));
    const present = partnerIds.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
    const decorated = new Map((await this.social.withRelations(me, present)).map((u) => [u.id, u]));

    const items: ConversationDto[] = page.items.flatMap((c, i) => {
      const partner = decorated.get(partnerIds[i]!);
      if (!partner) return []; // partner deleted their account
      const unread = (c.unread as Record<string, number> | undefined)?.[me] ?? 0;
      return [{
        partner,
        lastMessage: {
          id: c.lastMessage?.id ?? '', senderId: c.lastMessage?.senderId ?? '', text: c.lastMessage?.text ?? '', isGift: Boolean(c.lastMessage?.isGift),
        },
        lastMessageAt: c.lastMessageAt.toISOString(),
        unreadCount: Math.max(0, unread),
      }];
    });
    return { items, page: page.page };
  }

  async unreadTotal(me: string): Promise<number> {
    const convs = await ConversationModel.find({ participants: me }, { unread: 1 }).lean();
    return convs.reduce((sum, c) => sum + Math.max(0, (c.unread as Record<string, number> | undefined)?.[me] ?? 0), 0);
  }

  async markRead(me: string, partnerId: string): Promise<number> {
    const key = conversationKey(me, partnerId);
    const res = await MessageModel.updateMany({ conversationKey: key, receiverId: me, isRead: false }, { $set: { isRead: true } });
    await ConversationModel.updateOne({ key }, { $set: { [`unread.${me}`]: 0 } });
    return res.modifiedCount;
  }

  /** "Delete chat" only hides history for the caller; the other person keeps theirs. */
  async clear(me: string, partnerId: string): Promise<void> {
    const key = conversationKey(me, partnerId);
    await ConversationModel.updateOne({ key }, { $set: { [`clearedAt.${me}`]: new Date(), [`unread.${me}`]: 0 } });
  }
}
