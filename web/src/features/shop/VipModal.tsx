import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Crown } from 'lucide-react';
import { useState } from 'react';
import toast from 'react-hot-toast';
import { useUi } from '@/app/UiProvider';
import { useSession } from '@/features/session/SessionProvider';
import { client, idempotencyHeader, unwrap } from '@/shared/api/client';
import { isApiError, errorMessage } from '@/shared/api/errors';
import { useT } from '@/shared/i18n/I18nProvider';
import { Button } from '@/shared/ui/Button';
import { GemIcon } from '@/shared/ui/GemIcon';
import { Modal } from '@/shared/ui/Modal';

export function VipModal({ open, onClose }: { open: boolean; onClose(): void }) {
  const t = useT();
  const ui = useUi();
  const qc = useQueryClient();
  const { user, patchUser } = useSession();
  const plans = useQuery({ queryKey: ['vip-plans'], queryFn: () => unwrap(client.GET('/vip-plans')), enabled: open, staleTime: 60_000 });
  const [busy, setBusy] = useState<string | null>(null);

  const subscribe = async (id: string, price: number) => {
    if ((user?.gems ?? 0) < price) { onClose(); ui.open('shop'); return; }
    setBusy(id);
    try {
      const r = await unwrap(client.POST('/vip-plans/{planId}/subscribe', { params: { path: { planId: id }, header: idempotencyHeader() } }));
      patchUser({ gems: r.balance, isVip: true, vipExpiry: r.vipExpiry });
      void qc.invalidateQueries({ queryKey: ['me'] });
      toast.success(t('Welcome to VIP!'));
      onClose();
    } catch (e) {
      if (isApiError(e) && e.is('insufficient_gems')) { onClose(); ui.open('shop'); }
      else toast.error(errorMessage(e, t('Could not subscribe')));
    } finally { setBusy(null); }
  };

  return (
    <Modal open={open} onClose={onClose} title={t('Go VIP')} size="md" locked={busy !== null}>
      {user?.isVip && user.vipExpiry && <p className="text-sm text-[#00E676] mb-3">{t('VIP active until {d}', { d: new Date(user.vipExpiry).toLocaleDateString() })}</p>}
      <ul className="space-y-3">
        {(plans.data ?? []).map((p) => (
          <li key={p.id} className={`p-4 rounded-2xl bg-white/5 border ${p.popular ? 'border-[#00E676]' : 'border-white/10'} flex items-center gap-3`}>
            <Crown className="w-6 h-6 text-yellow-400 shrink-0" aria-hidden />
            <div className="flex-1 min-w-0"><b>{p.name}</b><p className="text-xs text-gray-400">{p.description || t('{n} days', { n: p.durationDays })}</p></div>
            <Button loading={busy === p.id} disabled={busy !== null} onClick={() => subscribe(p.id, p.priceGems)} aria-label={`${t('Subscribe to')} ${p.name}`}>
              <GemIcon className="w-4 h-4" />{p.priceGems}
            </Button>
          </li>
        ))}
        {plans.data?.length === 0 && <li className="text-center text-gray-500 py-6">{t('No plans available')}</li>}
      </ul>
    </Modal>
  );
}
