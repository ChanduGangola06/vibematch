import { useInfiniteQuery, type QueryKey } from '@tanstack/react-query';
import type { unwrapPage} from './client';
import { type PageMeta } from './client';

type Cursor = { limit: number; hasMore: boolean; nextCursor: string | null };
const isCursor = (p: PageMeta): p is Cursor => 'nextCursor' in p;

/** Cursor-paginated list: `fetchPage(cursor)` returns one page; pages are flattened for the UI. */
export function useCursorList<T>(key: QueryKey, fetchPage: (cursor: string | undefined) => Promise<ReturnType<typeof unwrapPage<T>> extends Promise<infer R> ? R : never>, enabled = true) {
  const q = useInfiniteQuery({
    queryKey: key,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => fetchPage(pageParam),
    getNextPageParam: (last) => (isCursor(last.page) && last.page.hasMore ? (last.page.nextCursor ?? undefined) : undefined),
    enabled,
  });
  return { ...q, items: q.data?.pages.flatMap((p) => p.items) ?? [] };
}
