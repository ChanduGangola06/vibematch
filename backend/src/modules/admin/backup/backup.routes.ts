import multer from 'multer';
import { z } from 'zod';
import type { ModuleRegistrar } from '../../../app.js';
import { BadRequestError } from '../../../core/errors/index.js';
import { streamNdjson } from '../../../core/pagination/index.js';
import { HANDLED } from '../../../gateway/index.js';
import type { AuditService } from '../audit.service.js';
import type { BackupService } from './backup.service.js';

const MAX_BACKUP_BYTES = 100 * 1024 * 1024;
const uploadBackup = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BACKUP_BYTES, files: 1, fields: 5 } }).single('backup');

export const backupRoutes = (backup: BackupService, audit: AuditService): ModuleRegistrar => ({ v1 }) => {
  v1.add({
    method: 'get', path: '/admin/backup', summary: 'Download a backup (NDJSON, streamed)', tags: ['admin', 'backup'],
    auth: 'admin', rateLimit: 'sensitive',
    schema: { query: z.object({ includeSecrets: z.enum(['true', 'false']).default('false').transform((v) => v === 'true') }) },
    handler: async ({ query, res, req }) => {
      await audit.record(req, { action: 'backup.export', meta: { includeSecrets: query.includeSecrets } });
      await streamNdjson(res, backup.export(query.includeSecrets), (x) => x, `vibematch-backup-${new Date().toISOString().slice(0, 10)}.ndjson`);
      return HANDLED;
    },
  });

  v1.add({
    method: 'post', path: '/admin/backup/restore', summary: 'Validate (default) or apply a backup. Applying needs confirm=RESTORE.', tags: ['admin', 'backup'],
    auth: 'admin', rateLimit: 'upload', body: 'none', middleware: [uploadBackup],
    docs: { requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', required: ['backup'], properties: { backup: { type: 'string', format: 'binary' }, mode: { type: 'string', enum: ['dry-run', 'merge', 'replace'], default: 'dry-run' }, confirm: { type: 'string', description: 'Must be RESTORE to apply' } } } } } } },
    handler: async ({ req }) => {
      const f = z
        .object({
          mode: z.enum(['dry-run', 'merge', 'replace']).default('dry-run'),
          confirm: z.string().optional(),
        })
        .safeParse(req.body ?? {});
      if (!f.success) throw new BadRequestError('mode must be dry-run, merge or replace');
      const file = (req as unknown as { file?: { buffer: Buffer } }).file?.buffer;
      if (!file) throw new BadRequestError('Upload the backup file in the "backup" field');
      if (f.data.mode !== 'dry-run' && f.data.confirm !== 'RESTORE') throw new BadRequestError('Send confirm=RESTORE to apply a restore');

      const report = await backup.restore(file, { mode: f.data.mode });
      await audit.record(req, {
        action: f.data.mode === 'dry-run' ? 'backup.validate' : 'backup.restore',
        meta: { mode: f.data.mode, collections: Object.fromEntries(Object.entries(report.collections).map(([k, v]) => [k, v.valid])) },
      });
      return { data: report };
    },
  });
};
