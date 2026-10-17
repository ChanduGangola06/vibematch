import { Link } from 'react-router';
import { useT } from '@/shared/i18n/I18nProvider';
import { EmptyState } from '@/shared/ui/EmptyState';

export default function NotFoundPage() {
  const t = useT();
  return <EmptyState title={t('Page not found')} text={t('The page you are looking for does not exist.')} action={<Link to="/" className="px-4 py-2 rounded-xl bg-[#00E676] text-black font-bold text-sm">{t('Back to home')}</Link>} />;
}
