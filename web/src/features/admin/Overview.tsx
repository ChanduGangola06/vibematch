import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { errorMessage } from '@/shared/api/errors';
import { EmptyState } from '@/shared/ui/EmptyState';
import { PageSpinner } from '@/shared/ui/Spinner';
import { admin } from './adminApi';
import { PageTitle } from './ui';

interface Metrics { period: string; newUsers: number; totalUsers: number; videoChats: number; messagesSent: number; giftsSent: number; gemsSpentOnGifts: number; activeVips: number; purchases: number; revenue: { currency: string; amount: number }[] }
const PERIODS = [['today', 'Today'], ['yesterday', 'Yesterday'], ['7days', '7 days'], ['1month', '1 month'], ['3months', '3 months'], ['1year', '1 year'], ['alltime', 'All time']] as const;

export default function Overview() {
  const [period, setPeriod] = useState<string>('7days');
  const q = useQuery({ queryKey: ['admin-metrics', period], queryFn: () => admin.get<Metrics>('/admin/metrics', { period }) });
  if (q.isPending) return <PageSpinner />;
  if (q.isError) return <EmptyState title="Could not load metrics" text={errorMessage(q.error)} />;
  const m = q.data;
  const cards: [string, string][] = [
    ['New users', m.newUsers.toLocaleString()], ['Total users', m.totalUsers.toLocaleString()], ['Video chats', m.videoChats.toLocaleString()],
    ['Messages', m.messagesSent.toLocaleString()], ['Gifts sent', m.giftsSent.toLocaleString()], ['Gems spent on gifts', m.gemsSpentOnGifts.toLocaleString()],
    ['Active VIPs', m.activeVips.toLocaleString()], ['Purchases', m.purchases.toLocaleString()],
    ['Revenue', m.revenue.length ? m.revenue.map((r) => r.amount.toLocaleString(undefined, { style: 'currency', currency: r.currency })).join(' · ') : '—'],
  ];
  return (
    <>
      <PageTitle action={
        <select aria-label="Period" value={period} onChange={(e) => setPeriod(e.target.value)} className="bg-gray-900 border border-gray-800 rounded-xl px-3 py-2 text-sm">
          {PERIODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>}>Overview</PageTitle>
      <dl className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        {cards.map(([k, v]) => <div key={k} className="rounded-2xl bg-white/5 border border-white/10 p-4"><dt className="text-xs uppercase text-gray-400">{k}</dt><dd className="text-2xl font-bold mt-1">{v}</dd></div>)}
      </dl>
    </>
  );
}
