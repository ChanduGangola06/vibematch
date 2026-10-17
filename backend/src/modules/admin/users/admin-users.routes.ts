import { z } from 'zod';
import type { ModuleRegistrar } from '../../../app.js';
import { offsetQuerySchema } from '../../../core/pagination/index.js';
import { emailSchema, genderSchema } from '../../users/user.schemas.js';
import type { AuditService } from '../audit.service.js';
import type { AdminUserService } from './admin-users.service.js';

const idParam = z.object({ id: z.string().min(1).max(64) });
const boolStr = z.enum(['true', 'false']).transform((v) => v === 'true');

const patchBody = z
  .object({
    name: z.string().trim().min(1).max(60),
    email: emailSchema,
    phone: z.string().trim().max(30).regex(/^[+\d\s().-]*$/),
    address: z.string().trim().max(200),
    bio: z.string().trim().max(500),
    gender: genderSchema,
    age: z.number().int().min(13).max(120),
    country: z.string().trim().max(60),
    countryCode: z.string().regex(/^[A-Za-z]{2}$/).transform((s) => s.toUpperCase()),
    avatar: z.string().regex(/^\/images\/(avatars|users)\/[\w.-]+$/),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field');

export const adminUserRoutes = (svc: AdminUserService, audit: AuditService): ModuleRegistrar => ({ v1 }) => {
  v1.add({
    method: 'get', path: '/admin/users', summary: 'Search and page through users', tags: ['admin', 'users'], auth: 'admin',
    schema: {
      query: offsetQuerySchema.extend({
        q: z.string().trim().max(80).optional(),
        role: z.enum(['guest', 'user', 'admin']).optional(),
        banned: boolStr.optional(),
        vip: boolStr.optional(),
      }),
    },
    handler: async ({ query }) => {
      const r = await svc.list(query);
      return { data: r.items, page: r.page };
    },
  });

  v1.add({
    method: 'get', path: '/admin/users/:id', summary: 'One user', tags: ['admin', 'users'], auth: 'admin',
    schema: { params: idParam },
    handler: async ({ params }) => ({ data: await svc.get(params.id) }),
  });

  v1.add({
    method: 'patch', path: '/admin/users/:id', summary: 'Edit a user\'s profile', tags: ['admin', 'users'], auth: 'admin',
    schema: { params: idParam, body: patchBody },
    handler: async ({ params, body, req }) => {
      const u = await svc.patch(params.id, body);
      await audit.record(req, { action: 'user.update', target: params.id, meta: { fields: Object.keys(body) } });
      return { data: u };
    },
  });

  v1.add({
    method: 'post', path: '/admin/users/:id/gems', summary: 'Add or remove gems (negative amount removes)', tags: ['admin', 'users'],
    auth: 'admin', rateLimit: 'sensitive',
    schema: { params: idParam, body: z.object({ amount: z.number().int().min(-10_000_000).max(10_000_000), note: z.string().trim().max(200).optional() }) },
    handler: async ({ params, body, req }) => {
      const r = await svc.adjustGems(params.id, body.amount);
      await audit.record(req, { action: 'user.gems', target: params.id, meta: { amount: body.amount, note: body.note, balance: r.balance } });
      return { data: r };
    },
  });

  v1.add({
    method: 'post', path: '/admin/users/:id/ban', summary: 'Ban a user (ends their sessions and sockets)', tags: ['admin', 'users'],
    auth: 'admin', rateLimit: 'sensitive', body: 'none', schema: { params: idParam },
    handler: async ({ params, auth, req }) => {
      const u = await svc.setBanned(auth.userId, params.id, true);
      await audit.record(req, { action: 'user.ban', target: params.id });
      return { data: u };
    },
  });
  v1.add({
    method: 'delete', path: '/admin/users/:id/ban', summary: 'Lift a ban', tags: ['admin', 'users'], auth: 'admin', schema: { params: idParam },
    handler: async ({ params, auth, req }) => {
      const u = await svc.setBanned(auth.userId, params.id, false);
      await audit.record(req, { action: 'user.unban', target: params.id });
      return { data: u };
    },
  });

  v1.add({
    method: 'put', path: '/admin/users/:id/role', summary: 'Promote to / demote from administrator', tags: ['admin', 'users'],
    auth: 'admin', rateLimit: 'sensitive',
    schema: { params: idParam, body: z.object({ role: z.enum(['user', 'admin']) }) },
    handler: async ({ params, body, auth, req }) => {
      const u = await svc.setRole(auth.userId, params.id, body.role);
      await audit.record(req, { action: 'user.role', target: params.id, meta: { role: body.role } });
      return { data: u };
    },
  });

  v1.add({
    method: 'delete', path: '/admin/users/:id', summary: 'Delete a user and their personal data', tags: ['admin', 'users'],
    auth: 'admin', rateLimit: 'sensitive', schema: { params: idParam },
    handler: async ({ params, auth, req }) => {
      await svc.remove(auth.userId, params.id);
      await audit.record(req, { action: 'user.delete', target: params.id });
      return { status: 204 };
    },
  });
};
