import { Suspense } from 'react';
import { Outlet } from 'react-router';
import { AuthModal } from '@/features/auth/AuthModal';
import { useInCall } from '@/features/matching/callState';
import { useSession } from '@/features/session/SessionProvider';
import { PageSpinner } from '@/shared/ui/Spinner';
import { BannedScreen } from './BannedScreen';
import { Footer } from './Footer';
import { Header } from './Header';
import { GlobalOverlays } from './GlobalOverlays';

/** Chrome shared by every public page. A call in progress hides it on small screens (see `data-in-call`). */
export function AppLayout() {
  const { status } = useSession();
  const inCall = useInCall();
  if (status === 'banned') return <BannedScreen />;
  return (
    <div className="min-h-[100dvh] flex flex-col font-sans selection:bg-[#00E676] selection:text-black overflow-x-hidden">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-[100] focus:top-2 focus:left-2 focus:bg-[#00E676] focus:text-black focus:px-3 focus:py-2 focus:rounded-lg">Skip to content</a>
      <div className={inCall ? 'hidden md:block' : undefined}><Header /></div>
      <main id="main" className="flex-1 flex flex-col relative min-h-0">
        <Suspense fallback={<PageSpinner />}><Outlet /></Suspense>
      </main>
      {!inCall && <Footer />}
      <AuthModal />
      <GlobalOverlays />
    </div>
  );
}
