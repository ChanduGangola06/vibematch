import { z } from 'zod';
import type { ModuleRegistrar } from '../../app.js';
import { UnauthorizedError } from '../../core/errors/index.js';
import { cursorQuerySchema } from '../../core/pagination/index.js';
import { followStateSchema, likeStateSchema, relationUserSchema } from '../dto.js';
import type { SocialService } from './social.service.js';

/** `me` is accepted as an alias for the caller on read endpoints. */
const resolveId = (id: string, auth: { userId: string } | undefined): string => {
  if (id !== 'me') return id;
  if (!auth) throw new UnauthorizedError();
  return auth.userId;
};

const userIdParam = z.object({ id: z.string().min(1).max(64) });


export const socialRoutes = (social: SocialService): ModuleRegistrar => ({ v1 }) => {
  v1.add({
    method: 'put', path: '/users/:id/follow', summary: 'Follow a user (idempotent)', tags: ['social'],
    auth: 'user', rateLimit: 'sensitive', schema: { params: userIdParam, response: followStateSchema },
    handler: async ({ params, auth }) => ({ data: await social.follow(auth.userId, params.id) }),
  });
  v1.add({
    method: 'delete', path: '/users/:id/follow', summary: 'Unfollow a user (idempotent)', tags: ['social'],
    auth: 'user', schema: { params: userIdParam, response: followStateSchema },
    handler: async ({ params, auth }) => ({ data: await social.unfollow(auth.userId, params.id) }),
  });

  v1.add({
    method: 'put', path: '/users/:id/like', summary: 'Like a user (one like per person)', tags: ['social'],
    auth: 'user', rateLimit: 'sensitive', schema: { params: userIdParam, response: likeStateSchema },
    handler: async ({ params, auth }) => ({ data: await social.like(auth.userId, params.id) }),
  });
  v1.add({
    method: 'delete', path: '/users/:id/like', summary: 'Remove my like', tags: ['social'],
    auth: 'user', schema: { params: userIdParam, response: likeStateSchema },
    handler: async ({ params, auth }) => ({ data: await social.unlike(auth.userId, params.id) }),
  });

  v1.add({
    method: 'post', path: '/users/:id/views', summary: 'Record a profile view (deduplicated per 24 h)', tags: ['social'],
    auth: 'user', body: 'none', schema: { params: userIdParam },
    handler: async ({ params, auth }) => {
      await social.view(auth.userId, auth.role, params.id);
      return { status: 204 };
    },
  });

  for (const direction of ['followers', 'following'] as const) {
    v1.add({
      method: 'get', path: `/users/:id/${direction}`, summary: `List a user's ${direction}`, tags: ['social'],
      auth: 'optional', schema: { params: userIdParam, query: cursorQuerySchema, response: z.array(relationUserSchema) },
      handler: async ({ params, query, auth }) => {
        const page = await social.list(auth?.userId, resolveId(params.id, auth), direction, query);
        return { data: page.items, page: page.page };
      },
    });
  }
};
