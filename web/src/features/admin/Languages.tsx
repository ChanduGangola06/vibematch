import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { errorMessage } from '@/shared/api/errors';
import type { Language } from '@/shared/api/types';
import { Button } from '@/shared/ui/Button';
import { EmptyState } from '@/shared/ui/EmptyState';
import { PageSpinner } from '@/shared/ui/Spinner';
import { admin } from './adminApi';
import { ResourceEditor } from './ResourceEditor';
import { act, Badge, LinkButton, PageTitle } from './ui';

export default function Languages() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin-languages'], queryFn: () => admin.get<Language[]>('/languages') });
  const [editing, setEditing] = useState<{ lang?: Language; translations?: Record<string, string> } | null>(null);
  const reload = () => { void qc.invalidateQueries({ queryKey: ['admin-languages'] }); void qc.invalidateQueries({ queryKey: ['languages'] }); };
  if (q.isPending) return <PageSpinner />;
  if (q.isError) return <EmptyState title="Could not load" text={errorMessage(q.error)} />;

  const edit = async (lang: Language) => {
    const pack = await admin.get<{ translations: Record<string, string> }>(`/languages/${lang.code}`);
    setEditing({ lang, translations: pack.translations });
  };
  return (
    <>
      <PageTitle action={<Button onClick={() => setEditing({})}>Add language</Button>}>Languages</PageTitle>
      <ul className="divide-y divide-white/5 rounded-2xl border border-white/10">
        {q.data.map((l) => (
          <li key={l.code} className="flex items-center gap-3 px-3 py-2 text-sm"><b className="w-12">{l.code}</b><span className="flex-1">{l.name}</span>{l.rtl && <Badge>RTL</Badge>}
            <LinkButton onClick={() => void edit(l)}>Edit</LinkButton>
            {l.code !== 'en' && <LinkButton danger onClick={() => act(() => admin.del(`/admin/languages/${l.code}`), 'Deleted', reload, `Delete ${l.name}?`)}>Delete</LinkButton>}</li>
        ))}
      </ul>
      {editing && (
        <ResourceEditor title={editing.lang ? `Edit ${editing.lang.name}` : 'Add language'} onClose={() => setEditing(null)}
          fields={[...(editing.lang ? [] : [{ name: 'code', label: 'Code', required: true, hint: 'e.g. fr' }]), { name: 'name', label: 'Name', required: true }, { name: 'flag', label: 'Flag file', hint: 'e.g. fr.svg' }, { name: 'rtl', label: 'Right-to-left', type: 'checkbox' as const },
            ...(editing.lang ? [{ name: 'translations', label: 'Translations (JSON: English → translated)', type: 'textarea' as const }] : [])]}
          initial={{ ...(editing.lang ?? {}), ...(editing.translations ? { translations: JSON.stringify(editing.translations, null, 2) } : {}) } as unknown as Record<string, string | number | boolean>}
          onSubmit={async (v) => {
            if (!editing.lang) { await admin.post('/admin/languages', v); reload(); return; }
            const { translations, ...rest } = v;
            let parsed: unknown;
            try { parsed = JSON.parse(String(translations || '{}')); } catch { throw new Error('Translations must be valid JSON'); }
            await admin.put(`/admin/languages/${editing.lang.code}`, { ...rest, translations: parsed });
            reload();
          }} />
      )}
    </>
  );
}
