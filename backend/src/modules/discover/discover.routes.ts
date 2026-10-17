import { z } from 'zod';
import type { ModuleRegistrar } from '../../app.js';
import { publicUserSchema } from '../users/user.schemas.js';
import type { DiscoverService } from './discover.service.js';

export const discoverRoutes = (discover: DiscoverService): ModuleRegistrar => ({ v1 }) => {
  v1.add({
    method: 'get', path: '/discover', summary: 'Random sample of people to show on the home grid', tags: ['discover'],
    auth: 'optional',
    schema: { response: z.array(publicUserSchema.extend({ videoUrl: z.string().optional() })) },
    handler: async ({ auth }) => ({ data: await discover.grid(auth?.userId) }),
  });
};
