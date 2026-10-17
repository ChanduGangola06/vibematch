import type { AppEventBus } from '../../core/events/index.js';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../core/errors/index.js';
import { newId } from '../../core/utils/id.js';
import type { ChatService, MessageDto } from '../chat/chat.service.js';
import { DebitGemsCommand, type GemService } from '../ledger/gem.service.js';
import type { UserRepository } from '../users/user.repository.js';
import type { GiftRepository } from './gift.repository.js';

export interface GiftDto {
  id: string;
  name: string;
  price: number;
  image: string;
}

type GiftReads = Pick<GiftRepository, 'list' | 'findById'>;

export class GiftService {
  constructor(
    private readonly gifts: GiftReads,
    private readonly gems: GemService,
    private readonly chat: ChatService,
    private readonly users: UserRepository,
    private readonly events: AppEventBus,
  ) {}

  async list(): Promise<GiftDto[]> {
    return (await this.gifts.list()).map((g) => ({ id: g.id, name: g.name, price: g.price, image: g.imagePath }));
  }

  /**
   * The price is read from the database, never from the request (v1 trusted a client-sent `cost`).
   * Debit → message; if the message cannot be stored the debit is compensated.
   */
  async send(
    senderId: string,
    receiverId: string,
    giftId: string,
    opts: { skipPermission?: boolean } = {},
  ): Promise<{ message: MessageDto; balance: number; gift: GiftDto }> {
    if (senderId === receiverId) throw new BadRequestError('You cannot send a gift to yourself');
    const gift = await this.gifts.findById(giftId);
    if (!gift) throw new NotFoundError('Gift');
    const [sender, receiver] = await Promise.all([this.users.findById(senderId), this.users.findById(receiverId)]);
    if (!sender) throw new NotFoundError('Sender');
    if (!receiver || receiver.isBanned) throw new NotFoundError('User');
    if (!opts.skipPermission && !(await this.chat.canMessage(sender, receiver))) {
      throw new ForbiddenError('You can only send gifts to people you follow each other with or have matched with', 'chat_not_allowed');
    }

    const messageId = newId('msg');
    const debit = new DebitGemsCommand(this.gems, senderId, gift.price, 'gift_sent', { type: 'gift', id: messageId });
    const { balance } = await debit.execute();
    try {
      const message = await this.chat.send(senderId, receiverId, '', {
        skipPermission: true,
        id: messageId,
        gift: { id: gift.id, name: gift.name, image: gift.imagePath, cost: gift.price },
      });
      this.events.emit('gift.sent', { fromId: senderId, toId: receiverId, giftId: gift.id, cost: gift.price });
      return { message, balance, gift: { id: gift.id, name: gift.name, price: gift.price, image: gift.imagePath } };
    } catch (err) {
      await debit.undo();
      throw err;
    }
  }
}
