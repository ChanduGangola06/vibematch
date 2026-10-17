import { ArrowLeft, Gift, MessageSquare, Send, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import toast from 'react-hot-toast';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useUi } from '@/app/UiProvider';
import { GiftPicker } from '@/features/matching/GiftPicker';
import { useSession } from '@/features/session/SessionProvider';
import { client, idempotencyHeader, unwrap } from '@/shared/api/client';
import { errorMessage, isApiError } from '@/shared/api/errors';
import type { Conversation } from '@/shared/api/types';
import { useT } from '@/shared/i18n/I18nProvider';
import { timeAgo } from '@/shared/lib/format';
import { Avatar } from '@/shared/ui/Avatar';
import { Button } from '@/shared/ui/Button';
import { EmptyState } from '@/shared/ui/EmptyState';
import { InfiniteSentinel } from '@/shared/ui/InfiniteSentinel';
import { PageSpinner } from '@/shared/ui/Spinner';
import { useClearThread, useConversations, useMarkThreadRead, useRealtimeInbox, useSendMessage, useThread } from './hooks';

export default function MessagesPage() {
  const t = useT();
  const ui = useUi();
  const { status, user } = useSession();
  const [params, setParams] = useSearchParams();
  const partnerId = params.get('chat') ?? undefined;
  const convs = useConversations();
  useRealtimeInbox(partnerId);

  if (status === 'loading') return <PageSpinner />;
  if (status !== 'authenticated' || !user) {
    return <EmptyState icon={<MessageSquare className="w-8 h-8" />} title={t('Sign in to see your messages')} action={<Button onClick={() => ui.openAuth(t('Sign in to see your messages'))}>{t('Sign in')}</Button>} />;
  }

  const selected = convs.items.find((c) => c.partner.id === partnerId);
  return (
    <div className="flex-1 flex min-h-0 max-w-6xl w-full mx-auto md:p-4 gap-4">
      <aside aria-label={t('Conversations')} className={`${partnerId ? 'hidden md:flex' : 'flex'} flex-col w-full md:w-80 shrink-0 md:rounded-3xl bg-[#16181f] border border-white/5 overflow-hidden`}>
        <h1 className="px-5 py-4 font-black text-lg border-b border-white/5">{t('Messages')}</h1>
        {convs.isLoading ? <PageSpinner /> : convs.items.length === 0 ? (
          <EmptyState icon={<MessageSquare className="w-7 h-7" />} title={t('No messages yet')} text={t('Meet someone in a video chat, then follow each other to keep talking.')} action={<Link to="/" className="px-4 py-2 rounded-xl bg-[#00E676] text-black font-bold text-sm">{t('Meet someone new')}</Link>} />
        ) : (
          <ul className="flex-1 overflow-y-auto">
            {convs.items.map((c) => <ConversationRow key={c.partner.id} c={c} active={c.partner.id === partnerId} onOpen={() => setParams({ chat: c.partner.id })} />)}
            <InfiniteSentinel hasMore={Boolean(convs.hasNextPage)} loading={convs.isFetchingNextPage} onVisible={() => void convs.fetchNextPage()} />
          </ul>
        )}
      </aside>

      <section className={`${partnerId ? 'flex' : 'hidden md:flex'} flex-1 min-w-0`} aria-label={t('Conversation')}>
        {partnerId ? <Thread key={partnerId} partnerId={partnerId} partner={selected?.partner} onBack={() => setParams({})} /> : (
          <div className="flex-1 hidden md:flex items-center justify-center text-gray-500">{t('Select a conversation')}</div>
        )}
      </section>
    </div>
  );
}

function ConversationRow({ c, active, onOpen }: { c: Conversation; active: boolean; onOpen(): void }) {
  const t = useT();
  return (
    <li>
      <button onClick={onOpen} aria-current={active} className={`w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-white/5 ${active ? 'bg-white/10' : ''}`}>
        <Avatar src={c.partner.avatar} name={c.partner.name || c.partner.username} className="w-11 h-11" />
        <span className="flex-1 min-w-0">
          <span className="flex justify-between gap-2"><b className="truncate">{c.partner.name || c.partner.username}</b><time className="text-xs text-gray-500" dateTime={c.lastMessageAt}>{timeAgo(c.lastMessageAt)}</time></span>
          <span className={`block truncate text-sm ${c.unreadCount ? 'text-white font-semibold' : 'text-gray-400'}`}>{c.lastMessage.isGift ? `🎁 ${c.lastMessage.text}` : c.lastMessage.text}</span>
        </span>
        {c.unreadCount > 0 && <span className="min-w-5 h-5 px-1.5 rounded-full bg-[#00E676] text-black text-xs font-black flex items-center justify-center" aria-label={t('{n} unread', { n: c.unreadCount })}>{c.unreadCount}</span>}
      </button>
    </li>
  );
}

function Thread({ partnerId, partner, onBack }: { partnerId: string; partner: Conversation['partner'] | undefined; onBack(): void }) {
  const t = useT();
  const ui = useUi();
  const nav = useNavigate();
  const { user, patchUser } = useSession();
  const thread = useThread(partnerId);
  const send = useSendMessage(partnerId);
  const clear = useClearThread();
  const [text, setText] = useState('');
  const [giftOpen, setGiftOpen] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  useMarkThreadRead(partnerId, thread.items.length > 0);

  // newest-first from the API → oldest-first on screen
  const ordered = [...thread.items].reverse();
  const newestId = thread.items[0]?.id;
  useEffect(() => bottom.current?.scrollIntoView({ block: 'end' }), [newestId]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = text.trim();
    if (!body) return;
    try {
      await send.mutateAsync(body);
      setText('');
    } catch (err) {
      toast.error(isApiError(err) && err.is('chat_not_allowed') ? t('You can message each other once you both follow each other or have matched.') : errorMessage(err, t('Message not sent')));
    }
  };

  const sendGift = async (giftId: string) => {
    const r = await unwrap(client.POST('/gifts/{giftId}/send', { params: { path: { giftId }, header: idempotencyHeader() }, body: { receiverId: partnerId } }));
    patchUser({ gems: r.balance });
    void thread.refetch();
  };

  return (
    <div className="flex-1 flex flex-col md:rounded-3xl bg-[#16181f] border border-white/5 overflow-hidden min-w-0">
      <header className="flex items-center gap-3 px-4 py-3 border-b border-white/5">
        <button onClick={onBack} aria-label={t('Back')} className="md:hidden p-2 -ml-2"><ArrowLeft className="w-5 h-5" aria-hidden="true" /></button>
        {partner ? (
          <Link to={`/u/${partner.username}`} className="flex items-center gap-3 min-w-0"><Avatar src={partner.avatar} name={partner.name || partner.username} className="w-9 h-9" /><b className="truncate">{partner.name || partner.username}</b></Link>
        ) : <b>{t('Conversation')}</b>}
        <div className="ml-auto flex gap-1">
          <button onClick={() => (user?.isGuest ? ui.openAuth(t('Create an account to send gifts')) : setGiftOpen(true))} aria-label={t('Send a gift')} className="p-2 rounded-full hover:bg-white/10"><Gift className="w-5 h-5" aria-hidden="true" /></button>
          <button onClick={() => { if (confirm(t('Clear this chat for you? The other person keeps their copy.'))) clear.mutate(partnerId, { onSuccess: () => { onBack(); nav('/messages'); } }); }} aria-label={t('Clear chat')} className="p-2 rounded-full hover:bg-white/10 text-red-300"><Trash2 className="w-5 h-5" aria-hidden="true" /></button>
        </div>
      </header>

      <div role="log" aria-live="polite" className="flex-1 overflow-y-auto p-4 space-y-2">
        {thread.hasNextPage && <button onClick={() => void thread.fetchNextPage()} disabled={thread.isFetchingNextPage} className="mx-auto block text-xs text-gray-400 hover:text-white">{t('Load earlier messages')}</button>}
        {thread.isLoading && <PageSpinner />}
        {ordered.map((m) => {
          const mine = m.senderId === user?.id;
          return (
            <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[80%] px-3.5 py-2 rounded-2xl text-sm break-words ${mine ? 'bg-[#00E676] text-black' : 'bg-white/10'}`}>
                {m.gift ? <span className="flex items-center gap-2"><img src={m.gift.image} alt="" className="w-9 h-9" />{m.gift.name}</span> : m.text}
                <time dateTime={m.createdAt} className={`block text-[10px] mt-0.5 ${mine ? 'text-black/60' : 'text-gray-400'}`}>{timeAgo(m.createdAt)}{mine && m.isRead ? ' ✓✓' : ''}</time>
              </div>
            </div>
          );
        })}
        <div ref={bottom} />
      </div>

      <form onSubmit={submit} className="p-3 flex gap-2 border-t border-white/5">
        <input value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} aria-label={t('Message')} placeholder={t('Type a message')} className="flex-1 bg-gray-900 rounded-xl px-4 py-3 text-sm border border-gray-800 outline-none focus:border-[#00E676]" />
        <button type="submit" aria-label={t('Send')} disabled={send.isPending || !text.trim()} className="w-12 rounded-xl bg-[#00E676] text-black flex items-center justify-center disabled:opacity-50"><Send className="w-5 h-5" aria-hidden="true" /></button>
      </form>
      <GiftPicker open={giftOpen} onClose={() => setGiftOpen(false)} onSend={sendGift} onNeedGems={() => { setGiftOpen(false); ui.open('shop'); }} />
    </div>
  );
}
