import { z } from 'zod';
import type { ModuleRegistrar } from '../../../app.js';
import { NotFoundError } from '../../../core/errors/index.js';
import { offsetMeta, offsetQuerySchema, toSkipLimit } from '../../../core/pagination/index.js';
import { newId } from '../../../core/utils/id.js';
import { UserModel, type UserDoc } from '../../../infra/db/models/user.js';
import type { AppEventBus } from '../../../core/events/index.js';
import { toAdminUser } from '../../users/user.mapper.js';
import type { AuditService } from '../audit.service.js';

/** Demo personas keep the discover grid and the match screen alive on a young platform. */
const videoUrl = z.string().max(500).refine((v) => v === '' || /^(https:\/\/|\/videos\/)/.test(v), 'Use https://… or /videos/…');
const body = z.object({
  name: z.string().trim().min(1).max(60),
  gender: z.enum(['male', 'female', 'other']),
  age: z.number().int().min(18).max(99),
  country: z.string().trim().max(60),
  countryCode: z.string().regex(/^[A-Za-z]{2}$/).transform((s) => s.toUpperCase()).optional(),
  videoUrl: videoUrl.optional(),
  isOnline: z.boolean().optional(),
  avatar: z.string().regex(/^\/images\/(avatars|users)\/[\w.-]+$/).optional(),
  likesCount: z.number().int().min(0).max(10_000_000).optional(),
});
const idParam = z.object({ id: z.string().min(1).max(64) });

export const demoUserRoutes = (audit: AuditService, events: AppEventBus): ModuleRegistrar => ({ v1 }) => {
  v1.add({
    method: 'get', path: '/admin/demo-users', summary: 'List demo profiles', tags: ['admin', 'demo'], auth: 'admin',
    schema: { query: offsetQuerySchema },
    handler: async ({ query }) => {
      const { skip, limit } = toSkipLimit(query);
      const [rows, total] = await Promise.all([
        UserModel.find({ isDemo: true }).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
        UserModel.countDocuments({ isDemo: true }),
      ]);
      return { data: rows.map((r) => toAdminUser(r as UserDoc)), page: offsetMeta(query, total) };
    },
  });

  v1.add({
    method: 'post', path: '/admin/demo-users', summary: 'Create a demo profile', tags: ['admin', 'demo'], auth: 'admin',
    schema: { body },
    handler: async ({ body: b, req }) => {
      const id = newId('demo');
      const u = await UserModel.create({
        id, username: id.replace(/-/g, '').slice(0, 20), usernameLower: id.replace(/-/g, '').slice(0, 20), name: b.name, gender: b.gender, age: b.age,
        country: b.country, countryCode: b.countryCode ?? '', videoUrl: b.videoUrl ?? '', isOnline: b.isOnline ?? true,
        avatar: b.avatar ?? `/images/avatars/${b.gender === 'male' ? 'male' : 'female'}-1.svg`,
        likesCount: b.likesCount ?? Math.floor(Math.random() * 500), isDemo: true, role: 'user', gems: 0,
      });
      events.emit('content.changed', { kind: 'discover' });
      await audit.record(req, { action: 'demo.create', target: id });
      return { status: 201, data: toAdminUser(u.toObject() as UserDoc) };
    },
  });

  v1.add({
    method: 'patch', path: '/admin/demo-users/:id', summary: 'Edit a demo profile', tags: ['admin', 'demo'], auth: 'admin',
    schema: { params: idParam, body: body.partial().refine((v) => Object.keys(v).length > 0, 'Provide at least one field') },
    handler: async ({ params, body: b, req }) => {
      const u = await UserModel.findOneAndUpdate({ id: params.id, isDemo: true }, { $set: b }, { returnDocument: 'after', runValidators: true }).lean();
      if (!u) throw new NotFoundError('Demo user');
      events.emit('content.changed', { kind: 'discover' });
      await audit.record(req, { action: 'demo.update', target: params.id });
      return { data: toAdminUser(u as UserDoc) };
    },
  });

  v1.add({
    method: 'delete', path: '/admin/demo-users/:id', summary: 'Delete a demo profile', tags: ['admin', 'demo'], auth: 'admin',
    schema: { params: idParam },
    handler: async ({ params, req }) => {
      if ((await UserModel.deleteOne({ id: params.id, isDemo: true })).deletedCount === 0) throw new NotFoundError('Demo user');
      events.emit('content.changed', { kind: 'discover' });
      await audit.record(req, { action: 'demo.delete', target: params.id });
      return { status: 204 };
    },
  });
};
