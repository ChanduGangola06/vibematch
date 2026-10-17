import { useEffect, useRef } from 'react';
import { Spinner } from './Spinner';

/** Triggers `onVisible` when scrolled into view — used for cursor-paginated lists. */
export function InfiniteSentinel({ onVisible, loading, hasMore }: { onVisible(): void; loading: boolean; hasMore: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !hasMore || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => entries[0]?.isIntersecting && !loading && onVisible(), { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [onVisible, loading, hasMore]);
  if (!hasMore) return null;
  return (
    <div ref={ref} className="flex justify-center py-4" data-testid="infinite-sentinel">
      {loading ? <Spinner /> : <button onClick={onVisible} className="text-xs text-gray-400 hover:text-white">Load more</button>}
    </div>
  );
}
