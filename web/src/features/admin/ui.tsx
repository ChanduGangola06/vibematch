import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import toast from 'react-hot-toast';
import { errorMessage } from '@/shared/api/errors';
import { Button } from '@/shared/ui/Button';
import { EmptyState } from '@/shared/ui/EmptyState';
import { PageSpinner } from '@/shared/ui/Spinner';
import { admin, type Listing, type Row } from './adminApi';

export interface Column<T> { header: string; cell(row: T): ReactNode; className?: string }

/** Server-paged table. Filters live in the caller's `query`; changing them resets to page 1 via the key. */
export function PagedTable<T extends { id: string }>({ queryKey, path, query, columns, actions, empty = 'Nothing here yet' }: {
  queryKey: string; path: string; query?: Record<string, string | number | boolean | undefined>;
  columns: Column<T>[]; actions?(row: T, reload: () => void): ReactNode; empty?: string;
}) {
  const [page, setPage] = useState(1);
  const qc = useQueryClient();
  const key = [queryKey, query, page];
  const q = useQuery<Listing<T>>({ queryKey: key, queryFn: () => admin.list<T>(path, { ...query, page, pageSize: 20 }), placeholderData: keepPreviousData });
  const reload = () => void qc.invalidateQueries({ queryKey: [queryKey] });
  if (q.isPending) return <PageSpinner />;
  if (q.isError) return <EmptyState title="Could not load" text={errorMessage(q.error)} action={<Button onClick={() => void q.refetch()}>Retry</Button>} />;
  const { items, page: meta } = q.data;
  return (
    <div>
      <div className="overflow-x-auto rounded-2xl border border-white/10">
        <table className="w-full text-sm">
          <thead className="bg-white/5 text-left text-xs uppercase text-gray-400">
            <tr>{columns.map((c) => <th key={c.header} scope="col" className="px-3 py-2 font-semibold">{c.header}</th>)}{actions && <th scope="col" className="px-3 py-2"><span className="sr-only">Actions</span></th>}</tr>
          </thead>
          <tbody>
            {items.map((r) => (
              <tr key={r.id} className="border-t border-white/5 hover:bg-white/[.03]">
                {columns.map((c) => <td key={c.header} className={`px-3 py-2 align-middle ${c.className ?? ''}`}>{c.cell(r)}</td>)}
                {actions && <td className="px-3 py-2 text-right whitespace-nowrap">{actions(r, reload)}</td>}
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={columns.length + 1} className="px-3 py-10 text-center text-gray-500">{empty}</td></tr>}
          </tbody>
        </table>
      </div>
      <nav aria-label="Pagination" className="flex items-center justify-end gap-3 mt-3 text-sm text-gray-400">
        <span>{meta.total.toLocaleString()} total · page {meta.page} of {meta.totalPages}</span>
        <button aria-label="Previous page" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="p-1.5 rounded-lg bg-white/10 disabled:opacity-30"><ChevronLeft className="w-4 h-4" /></button>
        <button aria-label="Next page" disabled={page >= meta.totalPages} onClick={() => setPage((p) => p + 1)} className="p-1.5 rounded-lg bg-white/10 disabled:opacity-30"><ChevronRight className="w-4 h-4" /></button>
      </nav>
    </div>
  );
}

/** Runs an admin mutation with a confirm step, toast feedback and a table reload. */
export async function act(fn: () => Promise<unknown>, ok: string, reload?: () => void, confirmText?: string) {
  if (confirmText && !window.confirm(confirmText)) return;
  try { await fn(); toast.success(ok); reload?.(); } catch (e) { toast.error(errorMessage(e, 'Action failed')); }
}

export const PageTitle = ({ children, action }: { children: ReactNode; action?: ReactNode }) => (
  <div className="flex items-center justify-between gap-3 mb-5"><h1 className="text-2xl font-bold">{children}</h1>{action}</div>
);

export const Badge = ({ tone = 'gray', children }: { tone?: 'gray' | 'green' | 'red' | 'yellow'; children: ReactNode }) => {
  const c = { gray: 'bg-white/10 text-gray-300', green: 'bg-[#00E676]/15 text-[#00E676]', red: 'bg-red-500/15 text-red-400', yellow: 'bg-yellow-500/15 text-yellow-400' }[tone];
  return <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${c}`}>{children}</span>;
};

export const LinkButton = ({ onClick, children, danger, label }: { onClick(): void; children: ReactNode; danger?: boolean; label?: string }) => (
  <button onClick={onClick} aria-label={label} className={`px-2 py-1 rounded-lg text-xs font-semibold hover:bg-white/10 ${danger ? 'text-red-400' : 'text-gray-300'}`}>{children}</button>
);

export type { Row };
