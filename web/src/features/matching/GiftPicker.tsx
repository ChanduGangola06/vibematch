import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import toast from 'react-hot-toast';
import { useSession } from '@/features/session/SessionProvider';
import { client, unwrap } from '@/shared/api/client';
import { errorMessage } from '@/shared/api/errors';
import { useT } from '@/shared/i18n/I18nProvider';
import { GemIcon } from '@/shared/ui/GemIcon';
import { Modal } from '@/shared/ui/Modal';

interface Props {
  open: boolean;
  onClose(): void;
  /** Sends the gift; resolves when the server accepted it. */
  onSend(giftId: string): Promise<void>;
  onNeedGems(): void;
}

export function GiftPicker({ open, onClose, onSend, onNeedGems }: Props) {
  const t = useT();
  const { user } = useSession();
  const gifts = useQuery({ queryKey: ['gifts'], queryFn: () => unwrap(client.GET('/gifts')), staleTime: 5 * 60_000, enabled: open });
  const [busy, setBusy] = useState<string | null>(null);
  const balance = user?.gems ?? 0;

  const send = async (id: string, price: number) => {
    if (balance < price) return onNeedGems();
    setBusy(id);
    try {
      await onSend(id);
      toast.success(t('Gift sent!'));
      onClose();
    } catch (e) {
      if ((e as { code?: string }).code === 'insufficient_gems') onNeedGems();
      else toast.error(errorMessage(e, t('Could not send the gift')));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={t('Send a gift')} size="md" locked={busy !== null}>
      <p className="flex items-center gap-1.5 text-sm text-gray-400 mb-4">{t('Your balance')}: <GemIcon className="w-4 h-4" /><b className="text-white">{balance.toLocaleString()}</b></p>
      {gifts.isLoading ? null : (
        <ul className="grid grid-cols-3 sm:grid-cols-4 gap-3">
          {(gifts.data ?? []).map((g) => (
            <li key={g.id}>
              <button onClick={() => send(g.id, g.price)} disabled={busy !== null} aria-label={`${g.name}, ${g.price} gems`}
                className={`w-full p-3 rounded-2xl bg-white/5 hover:bg-white/10 flex flex-col items-center gap-1 disabled:opacity-50 ${balance < g.price ? 'opacity-60' : ''}`}>
                <img src={g.image} alt="" className="w-12 h-12 object-contain" />
                <span className="text-xs font-semibold truncate max-w-full">{g.name}</span>
                <span className="flex items-center gap-1 text-xs text-[#00E676] font-bold"><GemIcon className="w-3 h-3" />{g.price}</span>
              </button>
            </li>
          ))}
          {(gifts.data ?? []).length === 0 && <li className="col-span-full text-center text-gray-500 py-6">{t('No gifts available')}</li>}
        </ul>
      )}
    </Modal>
  );
}
