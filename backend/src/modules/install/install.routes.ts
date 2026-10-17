import { z } from 'zod';
import type { ModuleRegistrar } from '../../app.js';
import { emailSchema, passwordSchema } from '../users/user.schemas.js';
import { installStatusSchema } from '../dto.js';
import type { InstallService } from './install.service.js';

export const installRoutes = (install: InstallService): ModuleRegistrar => ({ v1 }) => {
  v1.add({
    method: 'get', path: '/install/status', summary: 'Is the application installed? (drives the setup wizard)', tags: ['install'], auth: 'public', schema: { response: installStatusSchema },
    handler: async () => ({ data: await install.status() }),
  });

  v1.add({
    method: 'post', path: '/install/complete', summary: 'Create the first administrator and seed defaults (only while uninstalled)', tags: ['install'],
    auth: 'public', rateLimit: 'sensitive',
    schema: {
      body: z.object({
        adminUsername: z.string().regex(/^[a-zA-Z0-9_]{3,20}$/, 'Username must be 3-20 characters: letters, numbers and underscores'),
        adminEmail: emailSchema,
        adminPassword: passwordSchema,
        siteName: z.string().trim().min(1).max(80),
        siteUrl: z.string().url().max(300).refine((u) => /^https?:\/\//.test(u)),
      }),
    },
    handler: async ({ body }) => ({ status: 201, data: await install.install(body) }),
  });
};
