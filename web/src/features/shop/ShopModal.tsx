import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import toast from 'react-hot-toast';
import { useSession } from '@/features/session/SessionProvider';
import { useSiteSettings } from '@/features/settings/SettingsProvider';
import { client, idempotencyHeader, unwrap } from '@/shared/api/client';
import { errorMessage } from '@/shared/api/errors';
import { useT } from '@/shared/i18n/I18nProvider';
import { Button } from '@/shared/ui/Button';
import { GemIcon } from '@/shared/ui/GemIcon';
import { Modal } from '@/shared/ui/Modal';
import { openRazorpay } from './razorpay';

type Provider = 'stripe' | 'paypal' | 'razorpay';
const LABEL: Record<Provider, string> = { stripe: 'Card (Stripe)', paypal: 'PayPal', razorpay: 'Razorpay' };

export function ShopModal({ open, onClose }: { open: boolean; onClose(): void }) {
  const t = useT();
  const { user, patchUser } = useSession();
  const settings = useSiteSettings();
  const packs = useQuery({ queryKey: ['packs'], queryFn: () => unwrap(client.GET('/packs')), enabled: open, staleTime: 60_000 });
  const providers = (['stripe', 'paypal', 'razorpay'] as const).filter((p) => settings.get<boolean>('payments', `${p}Enabled`, false));
  const [provider, setProvider] = useState<Provider | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const chosen = provider ?? providers[0] ?? null;

  const buy = async (packId: string) => {
    if (!chosen) return;
    setBusy(packId);
    try {
      const returnUrl = window.location.origin;
      const co = await unwrap(client.POST(`/payments/${chosen}/checkout`, { body: { packId, returnUrl } }));
      if (chosen === 'razorpay') {
        const extra = co.extra as { keyId: string; amount: number; currency: string };
        const r = await openRazorpay({ key: extra.keyId, amount: extra.amount, currency: extra.currency, orderId: co.orderId, name: settings.siteName, email: user?.email });
        const done = await unwrap(client.POST('/payments/razorpay/verify', { body: { orderId: r.orderId, paymentId: r.paymentId, signature: r.signature }, headers: idempotencyHeader() }));
        patchUser({ gems: done.balance });
        toast.success(t('{n} gems added!', { n: done.gems }));
        onClose();
      } else if (co.url) {
        window.location.assign(co.url);
        return;
      }
    } catch (e) {
      if ((e as Error).message !== 'dismissed') toast.error(errorMessage(e, t('Payment could not be started')));
    }
    setBusy(null);
  };

  return (
    <Modal open={open} onClose={onClose} title={t('Get gems')} size="lg" locked={busy !== null}>
      {providers.length === 0 ? (
        <p className="text-gray-400 text-center py-8">{t('Payments are not available right now.')}</p>
      ) : (
        <>
          {providers.length > 1 && (
            <div role="radiogroup" aria-label={t('Payment method')} className="flex gap-2 mb-4">
              {providers.map((p) => (
                <button key={p} role="radio" aria-checked={chosen === p} onClick={() => setProvider(p)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-semibold ${chosen === p ? 'bg-[#00E676] text-black' : 'bg-white/10'}`}>{LABEL[p]}</button>
              ))}
            </div>
          )}
          <ul className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {(packs.data ?? []).map((p) => (
              <li key={p.id} className={`rounded-2xl p-4 bg-white/5 border ${p.popular ? 'border-[#00E676]' : 'border-white/10'} flex flex-col items-center gap-2`}>
                {p.popular && <span className="text-[10px] uppercase font-bold text-[#00E676]">{t('Most popular')}</span>}
                <GemIcon className="w-8 h-8" />
                <b className="text-xl">{p.gems.toLocaleString()}</b>
                <span className="text-xs text-gray-400 text-center">{p.name}</span>
                <Button className="w-full" loading={busy === p.id} disabled={busy !== null} onClick={() => buy(p.id)} aria-label={`${t('Buy')} ${p.name}`}>
                  {p.price.toLocaleString(undefined, { style: 'currency', currency: settings.get<string>('payments', 'currency', 'USD') })}
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Modal>
  );
}
