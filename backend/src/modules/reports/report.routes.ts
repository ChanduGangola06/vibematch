import { z } from 'zod';
import type { ModuleRegistrar } from '../../app.js';
import type { ReportService } from './report.service.js';

export const reportRoutes = (reports: ReportService): ModuleRegistrar => ({ v1 }) => {
  v1.add({
    method: 'post', path: '/reports', summary: 'Report a user', tags: ['moderation'],
    auth: 'user', roles: ['guest', 'user', 'admin'], rateLimit: 'sensitive',
    schema: {
      body: z.object({
        reportedUserId: z.string().min(1).max(64),
        reason: z.string().trim().min(2).max(120),
        details: z.string().trim().max(2000).optional(),
      }),
    },
    handler: async ({ body, auth }) => {
      const r = await reports.submit(auth.userId, body);
      return { status: r.duplicate ? 200 : 201, data: { id: r.id, status: r.status } };
    },
  });
};
