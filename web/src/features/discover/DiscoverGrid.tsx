import { useQuery } from '@tanstack/react-query';
import { client, unwrap } from '@/shared/api/client';
import { useT } from '@/shared/i18n/I18nProvider';
import { getFlagEmoji } from '@/shared/lib/countries';
import { Avatar } from '@/shared/ui/Avatar';

export function DiscoverGrid({ onPick }: { onPick?: () => void }) {
  const t = useT();
  const q = useQuery({ queryKey: ['discover'], queryFn: () => unwrap(client.GET('/discover')), staleTime: 30_000 });
  const people = q.data ?? [];
  if (q.isLoading || people.length === 0) return null;
  return (
    <section aria-label={t('People to meet')} className="w-full max-w-5xl mx-auto px-4">
      <h2 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-3">{t('People to meet')}</h2>
      <ul className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
        {people.map((p) => (
          <li key={p.id}>
            <button onClick={onPick} className="w-full premium-card !rounded-2xl p-3 flex flex-col items-center gap-2 hover:border-[#00E676]/40 text-center">
              <span className="relative">
                <Avatar src={p.avatar} name={p.name || p.username} className="w-16 h-16" />
                {p.isOnline && <span className="absolute bottom-0 right-0 w-3.5 h-3.5 bg-[#00E676] border-2 border-[#121212] rounded-full" aria-label={t('Online')} />}
              </span>
              <span className="text-sm font-bold truncate max-w-full">{p.name || p.username}{p.age ? `, ${p.age}` : ''}</span>
              <span className="text-xs text-gray-400">{p.countryCode ? getFlagEmoji(p.countryCode) : ''} {p.country}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
