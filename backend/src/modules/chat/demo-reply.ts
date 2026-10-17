import type { AppEventBus } from '../../core/events/index.js';
import type { Logger } from '../../core/logger/index.js';
import type { UserRepository } from '../users/user.repository.js';
import type { ChatService } from './chat.service.js';

const REPLIES = [
  'Hey! Nice to meet you 😊',
  'Thank you so much! ❤️',
  'Where are you from?',
  'You seem really cool! ✨',
  'Haha that\'s awesome! 😄',
  'How are you doing today? ✨',
  'Aww that\'s so sweet of you! 🥰',
];
const GIFT_REPLY = 'Thanks for the gift! You\'re so sweet! 🎁✨';

/**
 * Demo profiles (admin-created, used to keep the grid alive) answer messages after a short delay.
 * Pure Observer: nothing else in chat knows about it.
 */
export class DemoReplyService {
  constructor(
    private readonly events: AppEventBus,
    private readonly users: UserRepository,
    private readonly chat: ChatService,
    private readonly log: Logger,
    private readonly delayMs = 1800,
  ) {}

  listen(): void {
    this.events.on('message.sent', async ({ senderId, receiverId, isGift }) => {
      const receiver = await this.users.findById(receiverId);
      if (!receiver?.isDemo) return;
      const text = isGift ? GIFT_REPLY : REPLIES[Math.floor(Math.random() * REPLIES.length)]!;
      const timer = setTimeout(() => {
        this.chat.send(receiverId, senderId, text, { skipPermission: true }).catch((err) => this.log.warn({ err }, 'demo reply failed'));
      }, this.delayMs);
      timer.unref();
    });
  }
}
