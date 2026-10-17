import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { client, unwrap } from '@/shared/api/client';
import { isApiError } from '@/shared/api/errors';
import { useT } from '@/shared/i18n/I18nProvider';
import { EmptyState } from '@/shared/ui/EmptyState';
import { PageSpinner } from '@/shared/ui/Spinner';
import NotFoundPage from './NotFoundPage';

/** Admin-authored page. The API sanitises the HTML on write (allow-list), so it is safe to render as-is. */
export default function CmsPage() {
  const t = useT();
  const { slug = '' } = useParams();
  const q = useQuery({ queryKey: ['page', slug], queryFn: () => unwrap(client.GET('/pages/{slug}', { params: { path: { slug } } })), retry: false, staleTime: 5 * 60_000 });
  if (q.isPending) return <PageSpinner />;
  if (q.isError) return isApiError(q.error) && q.error.status === 404 ? <NotFoundPage /> : <EmptyState title={t('Could not load this page')} />;
  return (
    <article className="max-w-3xl mx-auto px-4 py-10">
      <h1 className="text-3xl font-bold mb-6">{q.data.title}</h1>
      <div className="prose prose-invert max-w-none text-gray-300 [&_a]:text-[#00E676] [&_h2]:text-xl [&_h2]:font-bold [&_h2]:mt-6 [&_p]:my-3 [&_ul]:list-disc [&_ul]:pl-6" dangerouslySetInnerHTML={{ __html: q.data.content }} />
    </article>
  );
}
