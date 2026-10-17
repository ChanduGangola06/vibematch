import { z } from 'zod';
import type { ModuleRegistrar } from '../../app.js';
import { NotFoundError } from '../../core/errors/index.js';
import { cursorQuerySchema } from '../../core/pagination/index.js';
import { countSchema, notificationSchema, updatedSchema } from '../dto.js';
import type { NotificationService } from './notification.service.js';
import type { PushService } from './push.service.js';

const idParam = z.object({ id: z.string().min(1).max(80) });
const tokenBody = z.object({ token: z.string().min(20).max(4096) });

export const notificationRoutes = (svc: NotificationService, push: PushService): ModuleRegistrar => ({ v1 }) => {
  v1.add({
    method: 'get', path: '/notifications', summary: 'My notifications (newest first)', tags: ['notifications'],
    auth: 'user', roles: ['guest', 'user', 'admin'], schema: { query: cursorQuerySchema, response: z.array(notificationSchema) },
    handler: async ({ query, auth }) => {
      const page = await svc.list(auth.userId, query);
      return { data: page.items, page: page.page };
    },
  });
  v1.add({
    method: 'get', path: '/notifications/unread-count', summary: 'Number of unread notifications', tags: ['notifications'],
    auth: 'user', roles: ['guest', 'user', 'admin'], schema: { response: countSchema },
    handler: async ({ auth }) => ({ data: { count: await svc.unreadCount(auth.userId) } }),
  });
  v1.add({
    method: 'post', path: '/notifications/read-all', summary: 'Mark every notification as read', tags: ['notifications'],
    auth: 'user', roles: ['guest', 'user', 'admin'], body: 'none', schema: { response: updatedSchema },
    handler: async ({ auth }) => ({ data: { updated: await svc.markAllRead(auth.userId) } }),
  });
  v1.add({
    method: 'post', path: '/notifications/:id/read', summary: 'Mark a notification as read', tags: ['notifications'],
    auth: 'user', roles: ['guest', 'user', 'admin'], body: 'none', schema: { params: idParam },
    handler: async ({ params, auth }) => {
      if (!(await svc.markRead(auth.userId, params.id))) throw new NotFoundError('Notification');
      return { status: 204 };
    },
  });

  v1.add({
    method: 'put', path: '/users/me/push-token', summary: 'Register this device for push notifications', tags: ['notifications'],
    auth: 'user', roles: ['guest', 'user', 'admin'], schema: { body: tokenBody },
    handler: async ({ body, auth }) => {
      await push.registerToken(auth.userId, body.token);
      return { status: 204 };
    },
  });
  v1.add({
    method: 'post', path: '/users/me/push-token/revoke', summary: 'Unregister this device (call on logout)', tags: ['notifications'],
    auth: 'user', roles: ['guest', 'user', 'admin'], schema: { body: tokenBody },
    handler: async ({ body, auth }) => {
      await push.removeToken(auth.userId, body.token);
      return { status: 204 };
    },
  });
};
