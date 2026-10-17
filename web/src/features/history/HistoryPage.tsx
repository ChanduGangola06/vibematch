import { Clock, Eye, MessageCircle, UserCheck, UserPlus } from 'lucide-react';
import { useState } from 'react';
import toast from 'react-hot-toast';
import { Link } from 'react-router';
import { useUi } from '@/app/UiProvider';
import { useSession } from '@/features/session/SessionProvider';
import { client, unwrap, unwrapPage } from '@/shared/api/client';
import { errorMessage } from '@/shared/api/errors';
import { useCursorList } from '@/shared/api/infinite';
import type { HistoryEntry } from '@/shared/api/types';
import { useT } from '@/shared/i18n/I18nProvider';
import { formatDuration, timeAgo } from '@/shared/lib/format';
import { Avatar } from '@/shared/ui/Avatar';
import { Button } from '@/shared/ui/Button';
import { EmptyState } from '@/shared/ui/EmptyState';
import { InfiniteSentinel } from '@/shared/ui/InfiniteSentinel';
import { PageSpinner } from '@/shared/ui/Spinner';

type Tab = 'calls' | 'views';

export default function HistoryPage() {
  const t = useT();
  const ui = useUi();
  const { status } = useSession();
  const [tab, setTab] = useState<Tab>('calls');
  const authed = status === 'authenticated';
  const list = useCursorList<HistoryEntry>(['history', tab], (cursor) =>
    unwrapPage(tab === 'calls' ? client.GET('/matches', { params: { query: { limit: 20, ...(cursor ? { cursor } : {}) } } }) : client.GET('/matches/viewed-me', { params: { query: { limit: 20, ...(cursor ? { cursor } : {}) } } })), authed);

  if (status === 'loading') return <PageSpinner />;
  if (!authed) return <EmptyState icon={<Clock className="w-8 h-8" />} title={t('Sign in to see your history')} action={<Button onClick={() => ui.openAuth(t('Sign in to see your history'))}>{t('Sign in')}</Button>} />;

  return (
    <div className="flex-1 max-w-3xl w-full mx-auto p-4 space-y-4">
      <div role="tablist" aria-label={t('History')} className="grid grid-cols-2 gap-1 p-1 rounded-xl bg-black/30">
        {([['calls', t('Video chats'), Clock], ['views', t('Viewed me'), Eye]] as const).map(([id, label, Icon]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={`py-2 rounded-lg text-sm font-bold flex items-center justify-center gap-2 ${tab === id ? 'bg-[#00E676] text-black' : 'text-gray-400'}`}><Icon className="w-4 h-4" aria-hidden="true" />{label}</button>
        ))}
      </div>
      {list.isLoading ? <PageSpinner /> : list.items.length === 0 ? (
        <EmptyState icon={<Clock className="w-8 h-8" />} title={tab === 'calls' ? t('No video chats yet') : t('Nobody has viewed your profile yet')} action={tab === 'calls' ? <Link to="/" className="px-4 py-2 rounded-xl bg-[#00E676] text-black font-bold text-sm">{t('Start chatting')}</Link> : undefined} />
      ) : (
        <ul className="space-y-2">
          {list.items.map((h) => <Row key={h.id} h={h} />)}
          <InfiniteSentinel hasMore={Boolean(list.hasNextPage)} loading={list.isFetchingNextPage} onVisible={() => void list.fetchNextPage()} />
        </ul>
      )}
    </div>
  );
}

function Row({ h }: { h: HistoryEntry }) {
  const t = useT();
  const { user } = useSession();
  const [following, setFollowing] = useState(h.partner.isFollowing);
  const [busy, setBusy] = useState(false);
  const p = h.partner;

  const toggle = async () => {
    setBusy(true);
    try {
      const r = following ? await unwrap(client.DELETE('/users/{id}/follow', { params: { path: { id: p.id } } })) : await unwrap(client.PUT('/users/{id}/follow', { params: { path: { id: p.id } } }));
      setFollowing(r.isFollowing);
    } catch (e) {
      toast.error(errorMessage(e, t('Action failed')));
    } finally { setBusy(false); }
  };

  return (
    <li className="flex items-center gap-3 p-3 rounded-2xl bg-[#16181f] border border-white/5">
      <Avatar src={p.avatar} name={p.name || p.username} className="w-12 h-12" />
      <div className="flex-1 min-w-0">
        {p.exists ? <Link to={`/u/${p.username}`} className="font-bold hover:underline truncate block">{p.name || p.username}{p.age ? `, ${p.age}` : ''}</Link> : <span className="font-bold text-gray-400">{t('Deleted user')}</span>}
        <p className="text-xs text-gray-400">{p.country} · {timeAgo(h.createdAt)}{h.type === 'video_chat' && h.durationSec > 0 ? ` · ${formatDuration(h.durationSec)}` : ''}</p>
      </div>
      {p.exists && user && !user.isGuest && (
        <div className="flex gap-1">
          <button onClick={toggle} disabled={busy} aria-label={following ? t('Unfollow') : t('Follow')} aria-pressed={following} className="p-2 rounded-full hover:bg-white/10 disabled:opacity-50">{following ? <UserCheck className="w-5 h-5 text-[#00E676]" aria-hidden="true" /> : <UserPlus className="w-5 h-5" aria-hidden="true" />}</button>
          {(p.isMutualFollow || h.type === 'video_chat') && <Link to={`/messages?chat=${p.id}`} aria-label={t('Message')} className="p-2 rounded-full hover:bg-white/10"><MessageCircle className="w-5 h-5" aria-hidden="true" /></Link>}
        </div>
      )}
    </li>
  );
}
