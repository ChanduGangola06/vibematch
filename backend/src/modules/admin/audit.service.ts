import type { Request } from 'express';
import type { Logger } from '../../core/logger/index.js';
import { AuditLogModel } from '../../infra/db/models/content.js';

export interface AuditEntry {
  action: string;
  target?: string | undefined;
  meta?: Record<string, unknown> | undefined;
}

/**
 * Append-only trail of privileged actions (who did what, from where). Writing never fails the
 * request: a broken audit sink is logged loudly instead of blocking an admin.
 */
export class AuditService {
  constructor(private readonly log: Logger) {}

  async record(req: Pick<Request, 'auth' | 'ip'>, entry: AuditEntry): Promise<void> {
    try {
      await AuditLogModel.create({
        actorId: req.auth?.userId ?? 'system',
        ...(req.auth?.username ? { actorName: req.auth.username } : {}),
        action: entry.action,
        ...(entry.target ? { target: entry.target } : {}),
        ...(entry.meta ? { meta: entry.meta } : {}),
        ...(req.ip ? { ip: req.ip } : {}),
      });
    } catch (err) {
      this.log.error({ err, action: entry.action }, 'audit write failed');
    }
  }
}
