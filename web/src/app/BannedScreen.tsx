import { Link } from 'react-router';
import { useSession } from '@/features/session/SessionProvider';
import { useT } from '@/shared/i18n/I18nProvider';
import { Button } from '@/shared/ui/Button';

export function BannedScreen() {
  const t = useT();
  const { signOut } = useSession();
  return (
    <div className="min-h-screen bg-[#0a0a0f] flex items-center justify-center p-4">
      <div role="alert" className="bg-[#16181f] border border-red-500/30 p-8 rounded-3xl max-w-md w-full text-center shadow-2xl space-y-4">
        <div className="w-20 h-20 bg-red-500/10 rounded-full flex items-center justify-center mx-auto text-4xl text-red-500" aria-hidden="true">⚠</div>
        <h1 className="text-2xl font-black">{t('Account suspended')}</h1>
        <p className="text-gray-400">{t('Your account has been suspended.')} <Link to="/contact" className="text-[#00E676] hover:underline">{t('Contact support')}</Link></p>
        <Button variant="danger" className="w-full" onClick={() => void signOut()}>{t('Log out')}</Button>
      </div>
    </div>
  );
}
