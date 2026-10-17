import { BadRequestError, NotFoundError } from '../../core/errors/index.js';
import { ReportModel } from '../../infra/db/models/social.js';
import type { UserRepository } from '../users/user.repository.js';

export interface ReportInput {
  reportedUserId: string;
  reason: string;
  details?: string | undefined;
}

export class ReportService {
  constructor(private readonly users: UserRepository) {}

  /**
   * Idempotent per (reporter, reported) within 24 h while still pending: re-reporting returns the
   * open report instead of flooding moderators. The reporter id comes from the token, never the body.
   */
  async submit(reporterId: string, input: ReportInput): Promise<{ id: string; status: string; duplicate: boolean }> {
    if (reporterId === input.reportedUserId) throw new BadRequestError('You cannot report yourself');
    const target = await this.users.findById(input.reportedUserId);
    if (!target) throw new NotFoundError('User');

    const open = await ReportModel.findOne({
      reporterId, reportedUserId: input.reportedUserId, status: 'pending',
      createdAt: { $gt: new Date(Date.now() - 24 * 3600_000) },
    }).lean();
    if (open) return { id: open.id, status: open.status, duplicate: true };

    const created = await ReportModel.create({
      reporterId, reportedUserId: input.reportedUserId, reason: input.reason, details: input.details ?? '',
    });
    return { id: created.id, status: created.status, duplicate: false };
  }
}
