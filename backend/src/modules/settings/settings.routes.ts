import { z } from 'zod';
import type { ModuleRegistrar } from '../../app.js';
import { BadRequestError } from '../../core/errors/index.js';
import type { AuditService } from '../admin/audit.service.js';
import { publicSettingsSchema } from '../dto.js';
import { GROUP_NAMES, GROUPS, isGroupName, type GroupName } from './settings.groups.js';
import type { MailService } from './settings.providers.js';
import { settingsStorageProbe } from './storage-probe.js';
import type { SettingsService } from './settings.service.js';
import type { StorageProvider } from '../users/user.service.js';

const groupParam = z.object({ group: z.string().refine(isGroupName, `Unknown settings group (one of: ${GROUP_NAMES.join(', ')})`) });

export const settingsRoutes = (
  settings: SettingsService,
  audit: AuditService,
  mail: MailService,
  storage: StorageProvider,
): ModuleRegistrar => ({ v1, deps }) => {
  v1.add({
    method: 'get', path: '/settings/public', summary: 'Public site configuration (branding, login methods, public keys)', tags: ['settings'],
    auth: 'public', schema: { response: publicSettingsSchema },
    handler: async ({ res }) => {
      res.setHeader('Cache-Control', 'public, max-age=30');
      return { data: { ...(await settings.publicBundle()), demoMode: deps.env.DEMO_MODE } };
    },
  });

  // Replaces v1's x-api-key check on /api/init: a *mobile-level* key from the admin panel is required.
  v1.add({
    method: 'get', path: '/init', summary: 'Mobile app bootstrap', tags: ['settings'],
    auth: 'public', apiKey: 'mobile',
    handler: async () => ({
      data: { settings: await settings.publicBundle(), demoMode: deps.env.DEMO_MODE, apiVersion: 1, serverTime: new Date().toISOString() },
    }),
  });

  v1.add({
    method: 'get', path: '/admin/settings', summary: 'List settings groups', tags: ['admin', 'settings'], auth: 'admin',
    handler: async () => ({ data: GROUP_NAMES.map((g) => ({ group: g, secrets: GROUPS[g].secrets })) }),
  });

  v1.add({
    method: 'get', path: '/admin/settings/:group', summary: 'One settings group (secrets masked)', tags: ['admin', 'settings'], auth: 'admin',
    schema: { params: groupParam },
    handler: async ({ params }) => ({ data: await settings.getMasked(params.group as GroupName) }),
  });

  v1.add({
    method: 'put', path: '/admin/settings/:group', summary: 'Update a settings group (partial; unknown fields rejected)', tags: ['admin', 'settings'],
    auth: 'admin', rateLimit: 'sensitive',
    schema: { params: groupParam, body: z.record(z.string(), z.unknown()) },
    handler: async ({ params, body, auth, req }) => {
      const group = params.group as GroupName;
      const result = await settings.update(group, body, auth.userId);
      // Which fields changed — never their values (they may be secrets).
      await audit.record(req, { action: 'settings.update', target: group, meta: { changed: result.changed, version: result.version } });
      return { data: { ...(await settings.getMasked(group)), _changed: result.changed } };
    },
  });

  v1.add({
    method: 'get', path: '/admin/settings/:group/revisions', summary: 'Settings history', tags: ['admin', 'settings'], auth: 'admin',
    schema: { params: groupParam },
    handler: async ({ params }) => ({ data: await settings.revisions(params.group as GroupName) }),
  });

  v1.add({
    method: 'post', path: '/admin/settings/:group/restore', summary: 'Restore a previous revision', tags: ['admin', 'settings'],
    auth: 'admin', rateLimit: 'sensitive',
    schema: { params: groupParam, body: z.object({ version: z.number().int().min(1) }) },
    handler: async ({ params, body, auth, req }) => {
      const r = await settings.restore(params.group as GroupName, body.version, auth.userId);
      await audit.record(req, { action: 'settings.restore', target: params.group, meta: { from: body.version, version: r.version } });
      return { data: await settings.getMasked(params.group as GroupName) };
    },
  });

  v1.add({
    method: 'post', path: '/admin/mail/test', summary: 'Send a test e-mail with the saved mail settings', tags: ['admin', 'settings'],
    auth: 'admin', rateLimit: 'sensitive',
    schema: { body: z.object({ email: z.email() }) },
    handler: async ({ body }) => {
      if (!(await mail.sendTest(body.email))) throw new BadRequestError('Could not send the test e-mail. Check the mail settings and server logs.');
      return { data: { sent: true } };
    },
  });

  v1.add({
    method: 'post', path: '/admin/storage/test', summary: 'Write and delete a probe file with the saved storage settings', tags: ['admin', 'settings'],
    auth: 'admin', rateLimit: 'sensitive', body: 'none',
    handler: async () => ({ data: await settingsStorageProbe(storage) }),
  });
};
