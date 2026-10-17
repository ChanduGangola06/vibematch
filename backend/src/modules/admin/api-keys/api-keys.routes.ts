import { z } from 'zod';
import type { ModuleRegistrar } from '../../../app.js';
import { API_KEY_LEVELS } from '../../../core/security/api-key.js';
import { offsetQuerySchema } from '../../../core/pagination/index.js';
import type { AuditService } from '../audit.service.js';
import type { ApiKeyService } from './api-keys.service.js';

const scopeSchema = z.string().regex(/^[a-z][a-z0-9:_-]{1,40}$/);

export const apiKeyRoutes = (keys: ApiKeyService, audit: AuditService): ModuleRegistrar => ({ v1 }) => {
  v1.add({
    method: 'get', path: '/admin/api-keys', summary: 'List API keys (masked)', tags: ['admin', 'api-keys'], auth: 'admin',
    schema: { query: offsetQuerySchema.extend({ includeRevoked: z.enum(['true', 'false']).default('false') }) },
    handler: async ({ query }) => {
      const { includeRevoked, ...paging } = query;
      const r = await keys.list(paging, includeRevoked === 'true');
      return { data: r.items, page: r.page };
    },
  });

  v1.add({
    method: 'post', path: '/admin/api-keys', summary: 'Create an API key (the secret is shown once)', tags: ['admin', 'api-keys'],
    auth: 'admin', rateLimit: 'sensitive',
    schema: {
      body: z.object({
        name: z.string().trim().min(1).max(80),
        level: z.enum(API_KEY_LEVELS),
        scopes: z.array(scopeSchema).max(20).optional(),
        expiresInDays: z.number().int().min(1).max(3650).optional(),
      }),
    },
    handler: async ({ body, auth, req }) => {
      const created = await keys.create({ ...body, createdBy: auth.userId });
      await audit.record(req, { action: 'api_key.create', target: created.key.id, meta: { level: body.level, name: body.name } });
      return { status: 201, data: { ...created.key, key: created.plain }, headers: { 'Cache-Control': 'no-store' } };
    },
  });

  v1.add({
    method: 'post', path: '/admin/api-keys/:id/rotate', summary: 'Replace a key with a fresh secret and revoke the old one', tags: ['admin', 'api-keys'],
    auth: 'admin', rateLimit: 'sensitive',
    schema: { params: z.object({ id: z.string().min(1).max(80) }) },
    handler: async ({ params, auth, req }) => {
      const r = await keys.rotate(params.id, auth.userId);
      await audit.record(req, { action: 'api_key.rotate', target: params.id, meta: { newId: r.key.id } });
      return { status: 201, data: { ...r.key, key: r.plain, revokedId: r.revokedId }, headers: { 'Cache-Control': 'no-store' } };
    },
  });

  v1.add({
    method: 'delete', path: '/admin/api-keys/:id', summary: 'Revoke an API key', tags: ['admin', 'api-keys'], auth: 'admin',
    schema: { params: z.object({ id: z.string().min(1).max(80) }) },
    handler: async ({ params, req }) => {
      await keys.revoke(params.id);
      await audit.record(req, { action: 'api_key.revoke', target: params.id });
      return { status: 204 };
    },
  });
};
