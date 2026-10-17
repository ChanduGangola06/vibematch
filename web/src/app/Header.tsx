import { Clock, MessageSquare, Shield, Video } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, NavLink } from 'react-router';
import { useUi } from '@/app/UiProvider';
import { NotificationBell } from '@/features/notifications/NotificationBell';
import { useOnlineUsers } from '@/features/notifications/hooks';
import { useSession } from '@/features/session/SessionProvider';
import { useSiteSettings } from '@/features/settings/SettingsProvider';
import { flagUrl, useI18n } from '@/shared/i18n/I18nProvider';
import { Avatar } from '@/shared/ui/Avatar';
import { GemIcon } from '@/shared/ui/GemIcon';

export function Header() {
  const { user, status } = useSession();
  const ui = useUi();
  const settings = useSiteSettings();
  const { languages, current, setLang, t } = useI18n();
  const online = useOnlineUsers(settings.get<boolean>('general', 'showOnlineUsers', true) !== false);
  const [langOpen, setLangOpen] = useState(false);
  const langRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!langOpen) return;
    const away = (e: MouseEvent) => !langRef.current?.contains(e.target as Node) && setLangOpen(false);
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [langOpen]);

  const tab = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-2 px-3 sm:px-4 py-2 rounded-xl text-sm font-bold transition-colors ${isActive ? 'bg-[#00E676]/15 text-[#00E676]' : 'text-gray-400 hover:text-white hover:bg-white/5'}`;

  return (
    <header className="glass-dark sticky top-0 z-40 px-3 sm:px-6 h-16 flex items-center justify-between gap-2 shrink-0">
      <div className="flex items-center gap-2 sm:gap-4 min-w-0">
        <Link to="/" className="flex items-center gap-2 shrink-0" aria-label={settings.siteName}>
          <span className="w-9 h-9 rounded-xl bg-gradient-to-br from-[#10b981] to-[#047857] overflow-hidden flex items-center justify-center text-black font-black">
            {settings.logoUrl.length > 3 ? <img src={settings.logoUrl} alt="" className="w-full h-full object-cover" /> : settings.logoUrl || '⚡'}
          </span>
          <span className="hidden sm:block text-xl font-black tracking-tight">{settings.siteName}</span>
        </Link>
        {online.data != null && (
          <span className="hidden lg:flex items-center gap-1.5 bg-[#00E676]/10 border border-[#00E676]/20 px-3 py-1 rounded-full text-xs font-bold text-[#00E676]" data-testid="online-count">
            <span className="w-2 h-2 bg-[#00E676] rounded-full animate-pulse" aria-hidden="true" />
            {t('{n} Online', { n: online.data.toLocaleString() })}
          </span>
        )}
        <nav aria-label={t('Main')} className="flex items-center gap-1">
          <NavLink to="/" end className={tab}><Video className="w-4 h-4" aria-hidden="true" /><span className="hidden md:inline">{t('Video Chat')}</span></NavLink>
          <NavLink to="/history" className={tab}><Clock className="w-4 h-4" aria-hidden="true" /><span className="hidden md:inline">{t('History')}</span></NavLink>
          <NavLink to="/messages" className={tab}><MessageSquare className="w-4 h-4" aria-hidden="true" /><span className="hidden md:inline">{t('Messages')}</span></NavLink>
        </nav>
      </div>

      <div className="flex items-center gap-1.5 sm:gap-3">
        {languages.length > 1 && current && (
          <div className="relative" ref={langRef}>
            <button onClick={() => setLangOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={langOpen} aria-label={t('Language')} className="flex items-center gap-1.5 p-2 rounded-full hover:bg-white/10">
              <img src={flagUrl(current)} alt="" className="w-5 h-5 rounded-full object-cover" />
            </button>
            {langOpen && (
              <ul role="listbox" className="absolute right-0 mt-2 w-44 rounded-2xl bg-[#16181f] border border-white/10 shadow-2xl z-50 py-1">
                {languages.map((l) => (
                  <li key={l.code} role="option" aria-selected={l.code === current.code}>
                    <button onClick={() => { setLang(l.code); setLangOpen(false); }} className="w-full flex items-center gap-2 px-4 py-2 text-sm text-left hover:bg-white/5">
                      <img src={flagUrl(l)} alt="" className="w-5 h-5 rounded-full object-cover" />{l.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {status === 'authenticated' && user ? (
          <>
            {user.role === 'admin' && <Link to="/admin" aria-label={t('Admin')} className="p-2 rounded-full text-gray-300 hover:text-white hover:bg-white/10"><Shield className="w-5 h-5" aria-hidden="true" /></Link>}
            <NotificationBell />
            <button onClick={() => ui.open('shop')} className="flex items-center gap-1.5 bg-white/5 hover:bg-white/10 border border-white/10 px-3 py-1.5 rounded-full font-bold text-sm" aria-label={t('Open shop, {n} gems', { n: user.gems })}>
              <GemIcon className="w-4 h-4" /><span data-testid="gem-balance">{user.gems.toLocaleString()}</span>
            </button>
            <button onClick={() => ui.open('drawer')} aria-label={t('Open profile menu')} className="rounded-full ring-2 ring-transparent hover:ring-[#00E676]/60">
              <Avatar src={user.avatar} name={user.name || user.username} className="w-9 h-9" />
            </button>
          </>
        ) : status === 'loading' ? (
          <span className="w-9 h-9 rounded-full bg-white/10 animate-pulse" aria-hidden="true" />
        ) : (
          <button onClick={() => ui.openAuth()} className="px-4 py-2 rounded-xl bg-[#00E676] text-black font-bold text-sm hover:bg-[#00c853]">{t('Sign in')}</button>
        )}
      </div>
    </header>
  );
}
