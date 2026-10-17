import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useSiteSettings } from '@/features/settings/SettingsProvider';
import { client, unwrap } from '@/shared/api/client';
import { useT } from '@/shared/i18n/I18nProvider';

const SOCIAL = [['facebookUrl', 'Facebook'], ['instagramUrl', 'Instagram'], ['twitterUrl', 'X'], ['tiktokUrl', 'TikTok']] as const;

export function Footer() {
  const t = useT();
  const s = useSiteSettings();
  const pages = useQuery({ queryKey: ['pages'], queryFn: () => unwrap(client.GET('/pages')), staleTime: 5 * 60_000 });
  const links = SOCIAL.map(([k, label]) => [s.get<string>('general', k, ''), label] as const).filter(([url]) => url);
  const stores = [[s.get<string>('general', 'playStoreUrl', ''), '/images/google-play-badge.png', 'Google Play'], [s.get<string>('general', 'appStoreUrl', ''), '/images/app-store-badge.png', 'App Store']] as const;

  return (
    <footer className="border-t border-white/5 bg-black/30 px-6 py-8 mt-auto">
      <div className="max-w-6xl mx-auto flex flex-col md:flex-row gap-6 md:items-start md:justify-between">
        <div className="max-w-sm space-y-2">
          <p className="font-black text-lg">{s.siteName}</p>
          <p className="text-sm text-gray-400">{s.get<string>('general', 'footerDescription', '')}</p>
        </div>
        <nav aria-label={t('Footer')} className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-gray-400">
          {(pages.data ?? []).map((p) => <Link key={p.slug} to={`/${p.slug}`} className="hover:text-white">{p.title}</Link>)}
          <Link to="/contact" className="hover:text-white">{t('Contact')}</Link>
        </nav>
        <div className="flex flex-col gap-3 items-start md:items-end">
          <div className="flex gap-3 text-sm text-gray-400">{links.map(([url, label]) => <a key={label} href={url} target="_blank" rel="noopener noreferrer" className="hover:text-white">{label}</a>)}</div>
          <div className="flex gap-2">{stores.filter(([url]) => url).map(([url, img, alt]) => <a key={alt} href={url} target="_blank" rel="noopener noreferrer"><img src={img} alt={alt} className="h-9" /></a>)}</div>
        </div>
      </div>
      <p className="max-w-6xl mx-auto mt-6 text-xs text-gray-600">{s.get<string>('general', 'footerCopyright', '')}</p>
    </footer>
  );
}
