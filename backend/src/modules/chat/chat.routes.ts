import { z } from 'zod';
import type { ModuleRegistrar } from '../../app.js';
import { z as zod } from 'zod';
import { cursorQuerySchema } from '../../core/pagination/index.js';
import { conversationSchema, countSchema, messageSchema, updatedSchema } from '../dto.js';
import type { ChatService } from './chat.service.js';

const partnerParam = z.object({ partnerId: z.string().min(1).max(64) });
const ROLES = ['guest', 'user', 'admin'] as const;

export const chatRoutes = (chat: ChatService): ModuleRegistrar => ({ v1 }) => {
  v1.add({
    method: 'get', path: '/conversations', summary: 'My inbox (most recent first)', tags: ['chat'],
    auth: 'user', roles: [...ROLES], schema: { query: cursorQuerySchema, response: zod.array(conversationSchema) },
    handler: async ({ query, auth }) => {
      const page = await chat.listConversations(auth.userId, query);
      return { data: page.items, page: page.page };
    },
  });

  v1.add({
    method: 'get', path: '/conversations/unread-count', summary: 'Total unread messages', tags: ['chat'],
    auth: 'user', roles: [...ROLES], schema: { response: countSchema },
    handler: async ({ auth }) => ({ data: { count: await chat.unreadTotal(auth.userId) } }),
  });

  v1.add({
    method: 'get', path: '/conversations/:partnerId/messages', summary: 'Messages with one person (newest first; page backwards with the cursor)', tags: ['chat'],
    auth: 'user', roles: [...ROLES], schema: { params: partnerParam, query: cursorQuerySchema, response: zod.array(messageSchema) },
    handler: async ({ params, query, auth }) => {
      const page = await chat.listMessages(auth.userId, params.partnerId, query);
      return { data: page.items, page: page.page };
    },
  });

  v1.add({
    method: 'post', path: '/conversations/:partnerId/messages', summary: 'Send a text message', tags: ['chat'],
    auth: 'user', roles: [...ROLES], idempotent: 'optional',
    schema: { params: partnerParam, body: z.object({ text: z.string().min(1).max(2000) }), response: messageSchema },
    handler: async ({ params, body, auth }) => ({ status: 201, data: await chat.send(auth.userId, params.partnerId, body.text) }),
  });

  v1.add({
    method: 'post', path: '/conversations/:partnerId/read', summary: 'Mark everything from this person as read', tags: ['chat'],
    auth: 'user', roles: [...ROLES], body: 'none', schema: { params: partnerParam, response: updatedSchema },
    handler: async ({ params, auth }) => ({ data: { updated: await chat.markRead(auth.userId, params.partnerId) } }),
  });

  v1.add({
    method: 'delete', path: '/conversations/:partnerId', summary: 'Clear this chat for me (the other person keeps their copy)', tags: ['chat'],
    auth: 'user', roles: [...ROLES], schema: { params: partnerParam },
    handler: async ({ params, auth }) => {
      await chat.clear(auth.userId, params.partnerId);
      return { status: 204 };
    },
  });
};
