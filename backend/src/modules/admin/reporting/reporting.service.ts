import { GemLedgerModel, PurchaseModel } from '../../../infra/db/models/commerce.js';
import { MatchModel, MessageModel } from '../../../infra/db/models/social.js';
import { UserModel } from '../../../infra/db/models/user.js';

export const PERIODS = ['today', 'yesterday', '7days', '1month', '3months', '1year', 'alltime'] as const;
export type Period = (typeof PERIODS)[number];

export interface DateRange {
  from?: Date;
  to?: Date;
}

/** Calendar-aware window for a dashboard period. */
export function periodRange(period: Period, now = new Date()): DateRange {
  const start = new Date(now);
  switch (period) {
    case 'today':
      start.setHours(0, 0, 0, 0);
      return { from: start };
    case 'yesterday': {
      start.setDate(start.getDate() - 1);
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setHours(23, 59, 59, 999);
      return { from: start, to: end };
    }
    case '7days': start.setDate(start.getDate() - 7); return { from: start };
    case '1month': start.setMonth(start.getMonth() - 1); return { from: start };
    case '3months': start.setMonth(start.getMonth() - 3); return { from: start };
    case '1year': start.setFullYear(start.getFullYear() - 1); return { from: start };
    case 'alltime': return {};
  }
}

const within = (r: DateRange, field = 'createdAt') =>
  r.from || r.to ? { [field]: { ...(r.from ? { $gte: r.from } : {}), ...(r.to ? { $lte: r.to } : {}) } } : {};

export interface Metrics {
  period: Period;
  newUsers: number;
  totalUsers: number;
  videoChats: number;
  messagesSent: number;
  giftsSent: number;
  gemsSpentOnGifts: number;
  activeVips: number;
  purchases: number;
  revenue: { currency: string; amount: number }[];
}

/**
 * Dashboard numbers. Eight independent aggregates run in parallel, each backed by an index,
 * instead of v1's "load every gift row into memory and sum in JavaScript".
 */
export async function computeMetrics(period: Period, now = new Date()): Promise<Metrics> {
  const range = periodRange(period, now);
  const real = { isDemo: { $ne: true } };
  const [newUsers, totalUsers, videoChats, messagesSent, gifts, activeVips, purchases, revenue] = await Promise.all([
    UserModel.countDocuments({ ...real, ...within(range) }),
    UserModel.countDocuments(real),
    MatchModel.countDocuments({ type: 'video_chat', ...within(range) }),
    MessageModel.countDocuments(within(range)),
    GemLedgerModel.aggregate<{ n: number; gems: number }>([
      { $match: { reason: 'gift_sent', ...within(range) } },
      { $group: { _id: null, n: { $sum: 1 }, gems: { $sum: { $multiply: ['$delta', -1] } } } },
    ]),
    UserModel.countDocuments({ vipExpiry: { $gt: now } }),
    PurchaseModel.countDocuments({ status: 'completed', ...within(range) }),
    PurchaseModel.aggregate<{ _id: string; amount: number }>([
      { $match: { status: 'completed', ...within(range) } },
      { $group: { _id: '$currency', amount: { $sum: '$amount' } } },
      { $sort: { _id: 1 } },
    ]),
  ]);
  return {
    period, newUsers, totalUsers, videoChats, messagesSent,
    giftsSent: gifts[0]?.n ?? 0, gemsSpentOnGifts: gifts[0]?.gems ?? 0, activeVips, purchases,
    revenue: revenue.map((r) => ({ currency: r._id, amount: Math.round(r.amount * 100) / 100 })),
  };
}
