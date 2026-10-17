import { Gift, Heart, Mic, MicOff, PhoneOff, SkipForward, SlidersHorizontal, UserCheck, UserPlus, Video, VideoOff, Flag, Send } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import toast from 'react-hot-toast';
import { useUi } from '@/app/UiProvider';
import { DiscoverGrid } from '@/features/discover/DiscoverGrid';
import { useSession } from '@/features/session/SessionProvider';
import { errorMessage } from '@/shared/api/errors';
import { useT } from '@/shared/i18n/I18nProvider';
import { getFlagEmoji } from '@/shared/lib/countries';
import { Avatar } from '@/shared/ui/Avatar';
import { Button } from '@/shared/ui/Button';
import { MediaView } from '@/shared/ui/MediaView';
import { callState } from './callState';
import { FilterModal } from './FilterModal';
import { GiftPicker } from './GiftPicker';
import { ReportDialog } from './ReportDialog';
import { DEFAULT_FILTERS, useMatching, type Filters, type MatchingDeps } from './useMatching';

export function VideoChatView({ deps }: { deps?: MatchingDeps }) {
  const t = useT();
  const ui = useUi();
  const { user } = useSession();
  const m = useMatching(deps);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [giftOpen, setGiftOpen] = useState(false);
  const [reportId, setReportId] = useState<string | null>(null);

  const inCall = m.phase === 'connected' || m.phase === 'searching' || m.phase === 'starting';
  useEffect(() => {
    callState.set(inCall);
    return () => callState.set(false);
  }, [inCall]);

  const guard = (fn: () => Promise<void> | void, failure: string) => async () => {
    try { await fn(); } catch (e) { toast.error(errorMessage(e, failure)); }
  };

  const onStart = () => ui.requireAuth(() => void m.start(filters), t('Sign in to start chatting'), { allowGuest: true });
  const onFilter = () => ui.requireAuth(() => ui.open('filter'), t('Sign in to set preferences'), { allowGuest: true });

  return (
    <div className="flex-1 flex flex-col">
      {m.phase === 'idle' || (m.phase === 'starting' && !m.localStream && m.error) ? (
        <Idle onStart={onStart} onFilter={onFilter} error={m.error} filters={filters} />
      ) : (
        <div className="flex-1 flex flex-col md:flex-row gap-3 p-3 md:p-4 min-h-0">
          <section aria-label={t('Video call')} className="relative flex-1 rounded-3xl overflow-hidden bg-black min-h-[50dvh]">
            {m.phase === 'connected' && m.partner ? (
              m.isDemo && m.videoUrl ? (
                <video src={m.videoUrl} autoPlay loop playsInline className="absolute inset-0 w-full h-full object-cover" aria-label={t('Video of {name}', { name: m.partner.name })} />
              ) : (
                <MediaView stream={m.remoteStream} className="absolute inset-0 w-full h-full object-cover" aria-label={t('Video of {name}', { name: m.partner.name })} />
              )
            ) : (
              <Searching text={m.phase === 'starting' ? t('Starting camera…') : t('Looking for someone…')} ignored={m.filtersIgnored} onUpgrade={() => ui.open('vip')} />
            )}

            {m.phase === 'connected' && m.partner && (
              <div className="absolute top-3 left-3 right-3 flex items-center justify-between">
                <div className="flex items-center gap-2 bg-black/50 backdrop-blur rounded-full pl-1 pr-3 py-1">
                  <Avatar src={m.partner.avatar} name={m.partner.name} className="w-8 h-8" />
                  <span className="text-sm font-bold">{m.partner.name}{m.partner.age ? `, ${m.partner.age}` : ''}</span>
                  <span className="text-xs text-gray-300">{getFlagEmoji(m.partner.countryCode)} {m.partner.country}</span>
                </div>
                <span className="flex items-center gap-1 bg-black/50 backdrop-blur rounded-full px-3 py-1 text-sm font-bold" aria-label={t('{n} likes', { n: m.partner.likesCount })}>
                  <Heart className="w-4 h-4 text-pink-400" aria-hidden="true" />{m.partner.likesCount}
                </span>
              </div>
            )}

            <MediaView stream={m.localStream} muted className="absolute bottom-24 right-3 w-28 h-40 sm:w-36 sm:h-48 object-cover rounded-2xl border-2 border-white/20 bg-gray-900 [transform:scaleX(-1)]" aria-label={t('Your camera')} />

            <div className="absolute bottom-4 inset-x-0 flex items-center justify-center gap-2 sm:gap-3 flex-wrap px-3" role="toolbar" aria-label={t('Call controls')}>
              <RoundBtn label={m.mic ? t('Mute microphone') : t('Unmute microphone')} onClick={m.toggleMic} active={!m.mic}>{m.mic ? <Mic className="w-5 h-5" /> : <MicOff className="w-5 h-5" />}</RoundBtn>
              <RoundBtn label={m.cam ? t('Turn camera off') : t('Turn camera on')} onClick={m.toggleCam} active={!m.cam}>{m.cam ? <Video className="w-5 h-5" /> : <VideoOff className="w-5 h-5" />}</RoundBtn>
              <RoundBtn label={t('Next person')} onClick={() => void m.next()} primary><SkipForward className="w-6 h-6" /></RoundBtn>
              <RoundBtn label={t('End call')} onClick={m.stop} danger><PhoneOff className="w-5 h-5" /></RoundBtn>
              {m.phase === 'connected' && m.partner && (
                <>
                  <RoundBtn label={m.liked ? t('Remove like') : t('Like')} onClick={() => ui.requireAuth(guard(m.toggleLike, t('Could not like')), t('Create an account to like people'))} active={m.liked}><Heart className={`w-5 h-5 ${m.liked ? 'fill-pink-400 text-pink-400' : ''}`} /></RoundBtn>
                  <RoundBtn label={m.following ? t('Unfollow') : t('Follow')} onClick={() => ui.requireAuth(guard(m.toggleFollow, t('Could not follow')), t('Create an account to follow people'))} active={m.following}>{m.following ? <UserCheck className="w-5 h-5" /> : <UserPlus className="w-5 h-5" />}</RoundBtn>
                  <RoundBtn label={t('Send a gift')} onClick={() => (user?.isGuest ? ui.openAuth(t('Create an account to send gifts')) : setGiftOpen(true))}><Gift className="w-5 h-5" /></RoundBtn>
                  <RoundBtn label={t('Report')} onClick={() => setReportId(m.partner!.id)}><Flag className="w-5 h-5" /></RoundBtn>
                </>
              )}
            </div>
          </section>

          {m.phase === 'connected' && <CallChat messages={m.messages} onSend={m.sendMessage} />}
        </div>
      )}

      <FilterModal filters={filters} onSave={setFilters} />
      <GiftPicker open={giftOpen} onClose={() => setGiftOpen(false)} onSend={m.sendGift} onNeedGems={() => { setGiftOpen(false); ui.open('shop'); }} />
      <ReportDialog userId={reportId} name={m.partner?.name ?? ''} onClose={() => setReportId(null)} />
    </div>
  );
}

function Idle({ onStart, onFilter, error, filters }: { onStart(): void; onFilter(): void; error: string | null; filters: Filters }) {
  const t = useT();
  const custom = filters.gender !== 'both' || filters.country !== 'All Countries' || filters.superMatch;
  return (
    <div className="flex-1 flex flex-col items-center gap-10 py-10">
      <div className="text-center space-y-4 px-4">
        <h1 className="text-4xl sm:text-5xl font-black tracking-tight">{t('Meet someone new')}</h1>
        <p className="text-gray-400 max-w-md mx-auto">{t('Start a random video chat with people from around the world.')}</p>
        {error && <p role="alert" className="max-w-md mx-auto p-3 rounded-xl bg-red-500/15 border border-red-500/30 text-red-200 text-sm font-semibold">{error}</p>}
        <div className="flex items-center justify-center gap-3 pt-2">
          <Button onClick={onStart} className="px-8 py-4 text-base">{t('Start video chat')}</Button>
          <button onClick={onFilter} aria-label={t('Match preferences')} className={`p-4 rounded-xl border ${custom ? 'border-[#00E676] text-[#00E676]' : 'border-white/10 text-gray-300'} hover:bg-white/5`}><SlidersHorizontal className="w-5 h-5" aria-hidden="true" /></button>
        </div>
      </div>
      <DiscoverGrid onPick={onStart} />
    </div>
  );
}

function Searching({ text, ignored, onUpgrade }: { text: string; ignored: boolean; onUpgrade(): void }) {
  const t = useT();
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 bg-[#0a0a0a]" role="status">
      <div className="relative w-28 h-28 flex items-center justify-center" aria-hidden="true">
        <span className="absolute inset-0 rounded-full bg-emerald-500/20 animate-radar-pulse" />
        <span className="absolute inset-0 rounded-full overflow-hidden"><span className="radar-sweep" /></span>
        <span className="relative w-6 h-6 rounded-full bg-[#00E676]" />
      </div>
      <p className="font-bold text-lg">{text}</p>
      {ignored && (
        <button onClick={onUpgrade} className="text-sm text-amber-300 underline underline-offset-2">{t('Your filters need VIP — searching everyone instead. Upgrade')}</button>
      )}
    </div>
  );
}

function RoundBtn({ label, onClick, children, active, primary, danger }: { label: string; onClick(): void; children: React.ReactNode; active?: boolean; primary?: boolean; danger?: boolean }) {
  const tone = danger ? 'bg-red-500 text-white' : primary ? 'bg-[#00E676] text-black' : active ? 'bg-white text-black' : 'bg-black/60 text-white hover:bg-black/80';
  return (
    <button onClick={onClick} aria-label={label} title={label} aria-pressed={active} className={`${primary ? 'w-14 h-14' : 'w-11 h-11'} rounded-full flex items-center justify-center backdrop-blur ${tone}`}>
      {children}
    </button>
  );
}

function CallChat({ messages, onSend }: { messages: ReturnType<typeof useMatching>['messages']; onSend(text: string): Promise<void> }) {
  const t = useT();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ block: 'end' }), [messages.length]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    try { await onSend(text); setText(''); } catch (err) { toast.error(errorMessage(err, t('Message not sent'))); } finally { setBusy(false); }
  };

  return (
    <aside aria-label={t('Chat')} className="md:w-80 flex flex-col rounded-3xl bg-[#16181f] border border-white/5 max-h-[40dvh] md:max-h-none">
      <div role="log" aria-live="polite" className="flex-1 overflow-y-auto p-3 space-y-2">
        {messages.length === 0 && <p className="text-center text-sm text-gray-500 py-6">{t('Say hi 👋')}</p>}
        {messages.map((msg) => (
          <div key={msg.id} className={`flex ${msg.mine ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] px-3 py-2 rounded-2xl text-sm ${msg.mine ? 'bg-[#00E676] text-black' : 'bg-white/10'}`}>
              {msg.gift ? <span className="flex items-center gap-2"><img src={msg.gift.image} alt="" className="w-8 h-8" />{msg.gift.name}</span> : msg.text}
            </div>
          </div>
        ))}
        <div ref={end} />
      </div>
      <form onSubmit={submit} className="p-2 flex gap-2 border-t border-white/5">
        <input value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} placeholder={t('Type a message')} aria-label={t('Message')} className="flex-1 bg-gray-900 rounded-xl px-3 py-2 text-sm border border-gray-800 outline-none focus:border-[#00E676]" />
        <button type="submit" aria-label={t('Send')} disabled={busy || !text.trim()} className="w-10 h-10 rounded-xl bg-[#00E676] text-black flex items-center justify-center disabled:opacity-50"><Send className="w-4 h-4" aria-hidden="true" /></button>
      </form>
    </aside>
  );
}
