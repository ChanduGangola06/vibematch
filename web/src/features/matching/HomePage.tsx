import { DiscoverGrid } from '@/features/discover/DiscoverGrid';
import { useUi } from '@/app/UiProvider';
import { useInCall } from './callState';
import { VideoChatView } from './VideoChatView';

export default function HomePage() {
  const inCall = useInCall();
  const ui = useUi();
  return (
    <>
      <VideoChatView />
      {!inCall && <div className="py-8"><DiscoverGrid onPick={() => ui.requireAuth(() => {}, 'Sign in to meet people', { allowGuest: true })} /></div>}
    </>
  );
}
