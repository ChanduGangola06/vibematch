import { Bell, CheckCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useT } from '@/shared/i18n/I18nProvider';
import { Avatar } from '@/shared/ui/Avatar';
import { useMarkAllRead, useMarkRead, useNotifications, useUnreadCount } from './hooks';

export function NotificationBell() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const list = useNotifications();
  const unread = useUnreadCount().data ?? 0;
  const markRead = useMarkRead();
  const markAll = useMarkAllRead();

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);

  const text = (n: { type: string; from?: { name: string } | undefined }) => {
    const who = n.from?.name || t('Someone');
    return n.type === 'follow' ? t('{name} started following you', { name: who }) : n.type === 'gift' ? t('{name} sent you a gift', { name: who }) : t('New notification');
  };

  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((o) => !o)} aria-label={unread ? t('Notifications ({n} unread)', { n: unread }) : t('Notifications')} aria-expanded={open} aria-haspopup="true"
        className="relative p-2 rounded-full text-gray-300 hover:text-white hover:bg-white/10">
        <Bell className="w-5 h-5" aria-hidden="true" />
        {unread > 0 && <span className="absolute top-0.5 right-0.5 min-w-4 h-4 px-1 rounded-full bg-red-500 text-[10px] font-black flex items-center justify-center">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && (
        <div role="menu" className="absolute right-0 mt-2 w-80 max-w-[90vw] rounded-2xl bg-[#16181f] border border-white/10 shadow-2xl z-50 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
            <span className="font-bold text-sm">{t('Notifications')}</span>
            {unread > 0 && <button onClick={() => markAll.mutate()} className="text-xs text-[#00E676] flex items-center gap-1"><CheckCheck className="w-3.5 h-3.5" aria-hidden="true" />{t('Mark all read')}</button>}
          </div>
          <ul className="max-h-80 overflow-y-auto">
            {(list.data ?? []).length === 0 && <li className="px-4 py-8 text-center text-sm text-gray-500">{t('No notifications yet')}</li>}
            {(list.data ?? []).map((n) => (
              <li key={n.id}>
                <Link to={n.from ? `/u/${n.from.username}` : '/'} onClick={() => { if (!n.isRead) markRead.mutate(n.id); setOpen(false); }}
                  className={`flex items-center gap-3 px-4 py-3 hover:bg-white/5 ${n.isRead ? 'opacity-60' : ''}`}>
                  <Avatar src={n.from?.avatar} name={n.from?.name ?? '?'} className="w-9 h-9" />
                  <span className="text-sm text-gray-200 flex-1">{text(n)}</span>
                  {!n.isRead && <span className="w-2 h-2 rounded-full bg-[#00E676]" aria-label={t('Unread')} />}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
