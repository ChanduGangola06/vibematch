import { z } from 'zod';
import type { ModuleRegistrar } from '../../../app.js';
import { NotFoundError } from '../../../core/errors/index.js';
import { offsetMeta, offsetQuerySchema, toSkipLimit } from '../../../core/pagination/index.js';
import { ContactMessageModel, ReportModel } from '../../../infra/db/models/social.js';
import { UserModel } from '../../../infra/db/models/user.js';
import type { AuditService } from '../audit.service.js';

const idParam = z.object({ id: z.string().min(1).max(80) });

export const moderationRoutes = (audit: AuditService): ModuleRegistrar => ({ v1 }) => {
  // ---- reports ----------------------------------------------------------------------------------
  v1.add({
    method: 'get', path: '/admin/reports', summary: 'User reports', tags: ['admin', 'moderation'], auth: 'admin',
    schema: { query: offsetQuerySchema.extend({ status: z.enum(['pending', 'reviewed', 'resolved', 'dismissed']).optional() }) },
    handler: async ({ query }) => {
      const filter = query.status ? { status: query.status } : {};
      const { skip, limit } = toSkipLimit(query);
      const [rows, total] = await Promise.all([
        ReportModel.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
        ReportModel.countDocuments(filter),
      ]);
      // names in ONE query, not one per row
      const ids = [...new Set(rows.flatMap((r) => [r.reporterId, r.reportedUserId]))];
      const people = new Map((await UserModel.find({ id: { $in: ids } }, { id: 1, name: 1, username: 1, avatar: 1, isBanned: 1 }).lean()).map((u) => [u.id, u]));
      const who = (id: string) => {
        const u = people.get(id);
        return { id, name: u ? u.name || u.username : 'Deleted user', username: u?.username ?? '', avatar: u?.avatar ?? '', isBanned: Boolean(u?.isBanned), exists: Boolean(u) };
      };
      return {
        data: rows.map((r) => ({
          id: r.id, reason: r.reason, details: r.details ?? '', status: r.status, createdAt: (r.createdAt ?? new Date(0)).toISOString(),
          reporter: who(r.reporterId), reported: who(r.reportedUserId),
        })),
        page: offsetMeta(query, total),
      };
    },
  });
  v1.add({
    method: 'patch', path: '/admin/reports/:id', summary: 'Change a report\'s status', tags: ['admin', 'moderation'], auth: 'admin',
    schema: { params: idParam, body: z.object({ status: z.enum(['pending', 'reviewed', 'resolved', 'dismissed']) }) },
    handler: async ({ params, body, req }) => {
      const r = await ReportModel.findOneAndUpdate({ id: params.id }, { $set: { status: body.status } }, { returnDocument: 'after' }).lean();
      if (!r) throw new NotFoundError('Report');
      await audit.record(req, { action: 'report.status', target: params.id, meta: { status: body.status } });
      return { data: { id: r.id, status: r.status } };
    },
  });
  v1.add({
    method: 'delete', path: '/admin/reports/:id', summary: 'Delete a report', tags: ['admin', 'moderation'], auth: 'admin', schema: { params: idParam },
    handler: async ({ params, req }) => {
      if ((await ReportModel.deleteOne({ id: params.id })).deletedCount === 0) throw new NotFoundError('Report');
      await audit.record(req, { action: 'report.delete', target: params.id });
      return { status: 204 };
    },
  });

  // ---- contact mailbox --------------------------------------------------------------------------
  v1.add({
    method: 'get', path: '/admin/mailbox', summary: 'Messages sent through the contact form', tags: ['admin', 'moderation'], auth: 'admin',
    schema: { query: offsetQuerySchema.extend({ status: z.enum(['unread', 'read', 'archived']).optional() }) },
    handler: async ({ query }) => {
      const filter = query.status ? { status: query.status } : {};
      const { skip, limit } = toSkipLimit(query);
      const [rows, total] = await Promise.all([
        ContactMessageModel.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
        ContactMessageModel.countDocuments(filter),
      ]);
      return {
        data: rows.map((m) => ({ id: m.id, name: m.name, email: m.email, message: m.message, userId: m.userId ?? null, status: m.status, createdAt: (m.createdAt ?? new Date(0)).toISOString() })),
        page: offsetMeta(query, total),
      };
    },
  });
  v1.add({
    method: 'get', path: '/admin/mailbox/unread-count', summary: 'Unread contact messages', tags: ['admin', 'moderation'], auth: 'admin',
    handler: async () => ({ data: { count: await ContactMessageModel.countDocuments({ status: 'unread' }) } }),
  });
  v1.add({
    method: 'patch', path: '/admin/mailbox/:id', summary: 'Mark a message read / archived', tags: ['admin', 'moderation'], auth: 'admin',
    schema: { params: idParam, body: z.object({ status: z.enum(['unread', 'read', 'archived']) }) },
    handler: async ({ params, body }) => {
      const m = await ContactMessageModel.findOneAndUpdate({ id: params.id }, { $set: { status: body.status } }, { returnDocument: 'after' }).lean();
      if (!m) throw new NotFoundError('Message');
      return { data: { id: m.id, status: m.status } };
    },
  });
  v1.add({
    method: 'delete', path: '/admin/mailbox/:id', summary: 'Delete a message', tags: ['admin', 'moderation'], auth: 'admin', schema: { params: idParam },
    handler: async ({ params, req }) => {
      if ((await ContactMessageModel.deleteOne({ id: params.id })).deletedCount === 0) throw new NotFoundError('Message');
      await audit.record(req, { action: 'mailbox.delete', target: params.id });
      return { status: 204 };
    },
  });
};
