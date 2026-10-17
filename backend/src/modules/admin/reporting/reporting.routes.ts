import { z } from 'zod';
import type { ModuleRegistrar } from '../../../app.js';
import { BadRequestError, ConflictError, UnauthorizedError } from '../../../core/errors/index.js';
import { offsetMeta, offsetQuerySchema, streamNdjson, toSkipLimit } from '../../../core/pagination/index.js';
import { verifyPassword } from '../../../core/security/index.js';
import { AuditLogModel } from '../../../infra/db/models/content.js';
import { PurchaseModel, PURCHASE_PROVIDERS } from '../../../infra/db/models/commerce.js';
import { UserModel } from '../../../infra/db/models/user.js';
import { HANDLED } from '../../../gateway/index.js';
import { toPurchaseDto } from '../../payments/payment.service.js';
import { emailSchema } from '../../users/user.schemas.js';
import type { UserRepository } from '../../users/user.repository.js';
import type { AuditService } from '../audit.service.js';
import { PERIODS, computeMetrics } from './reporting.service.js';

const purchaseFilter = z.object({
  provider: z.enum(PURCHASE_PROVIDERS).optional(),
  userId: z.string().max(64).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
const toFilter = (q: z.infer<typeof purchaseFilter>) => ({
  ...(q.provider ? { provider: q.provider } : {}),
  ...(q.userId ? { userId: q.userId } : {}),
  ...(q.from || q.to ? { createdAt: { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) } } : {}),
});

export const reportingRoutes = (users: UserRepository, audit: AuditService, bcryptCost: number): ModuleRegistrar => ({ v1 }) => {
  v1.add({
    method: 'get', path: '/admin/metrics', summary: 'Dashboard numbers for a period', tags: ['admin', 'reporting'], auth: 'admin',
    schema: { query: z.object({ period: z.enum(PERIODS).default('today') }) },
    handler: async ({ query }) => ({ data: await computeMetrics(query.period) }),
  });

  v1.add({
    method: 'get', path: '/admin/purchases', summary: 'All purchases', tags: ['admin', 'reporting'], auth: 'admin',
    schema: { query: offsetQuerySchema.merge(purchaseFilter) },
    handler: async ({ query }) => {
      const filter = toFilter(query);
      const { skip, limit } = toSkipLimit(query);
      const [rows, total] = await Promise.all([
        PurchaseModel.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
        PurchaseModel.countDocuments(filter),
      ]);
      return { data: rows.map((p) => ({ ...toPurchaseDto(p), userId: p.userId, username: p.username ?? '', providerTxnId: p.providerTxnId })), page: offsetMeta(query, total) };
    },
  });

  // Streams newline-delimited JSON straight from a Mongo cursor: constant memory for any number of rows.
  v1.add({
    method: 'get', path: '/admin/purchases/export', summary: 'Export purchases as NDJSON (streamed)', tags: ['admin', 'reporting'],
    auth: 'admin', rateLimit: 'sensitive', schema: { query: purchaseFilter },
    handler: async ({ query, res, req }) => {
      await audit.record(req, { action: 'purchases.export' });
      const cursor = PurchaseModel.find(toFilter(query)).sort({ createdAt: -1, _id: -1 }).lean().cursor();
      await streamNdjson(res, cursor, (p) => ({ ...toPurchaseDto(p), userId: p.userId, username: p.username ?? '', providerTxnId: p.providerTxnId }), 'purchases.ndjson');
      return HANDLED;
    },
  });

  v1.add({
    method: 'get', path: '/admin/audit-log', summary: 'Who did what', tags: ['admin', 'reporting'], auth: 'admin',
    schema: { query: offsetQuerySchema.extend({ actorId: z.string().max(64).optional(), action: z.string().max(60).optional() }) },
    handler: async ({ query }) => {
      const filter = { ...(query.actorId ? { actorId: query.actorId } : {}), ...(query.action ? { action: query.action } : {}) };
      const { skip, limit } = toSkipLimit(query);
      const [rows, total] = await Promise.all([
        AuditLogModel.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
        AuditLogModel.countDocuments(filter),
      ]);
      return {
        data: rows.map((a) => ({ id: String(a._id), actorId: a.actorId, actorName: a.actorName ?? '', action: a.action, target: a.target ?? '', meta: a.meta ?? null, ip: a.ip ?? '', createdAt: (a.createdAt ?? new Date(0)).toISOString() })),
        page: offsetMeta(query, total),
      };
    },
  });

  // E-mail is the one profile field that needs the password: it is the account-recovery channel.
  v1.add({
    method: 'put', path: '/admin/profile/email', summary: 'Change my e-mail (password required)', tags: ['admin'], auth: 'admin', rateLimit: 'sensitive',
    schema: { body: z.object({ email: emailSchema, password: z.string().min(1).max(200) }) },
    handler: async ({ body, auth, req }) => {
      const me = await users.findWithHashById(auth.userId);
      if (!me) throw new BadRequestError('Account not found');
      if (!(await verifyPassword(body.password, me.passwordHash, bcryptCost)).valid) throw new UnauthorizedError('Password is incorrect', 'invalid_credentials');
      try {
        await UserModel.updateOne({ id: me.id }, { $set: { email: body.email, emailLower: body.email } });
      } catch (err) {
        if ((err as { code?: number }).code === 11000) throw new ConflictError('This e-mail address is already registered', 'email_taken');
        throw err;
      }
      await audit.record(req, { action: 'admin.email_change' });
      return { data: { email: body.email } };
    },
  });
};
