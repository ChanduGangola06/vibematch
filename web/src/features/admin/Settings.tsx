import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import toast from 'react-hot-toast';
import { NavLink, useParams } from 'react-router';
import { errorMessage } from '@/shared/api/errors';
import { Button } from '@/shared/ui/Button';
import { EmptyState } from '@/shared/ui/EmptyState';
import { PageSpinner } from '@/shared/ui/Spinner';
import { admin, fmtDate } from './adminApi';
import { act, PageTitle } from './ui';

interface GroupInfo { group: string; secrets: string[] }
type Data = Record<string, unknown> & { _version: number };
interface Revision { version: number; by: string; createdAt: string }

export function SettingsIndex() {
  const groups = useQuery({ queryKey: ['admin-settings-groups'], queryFn: () => admin.get<GroupInfo[]>('/admin/settings') });
  if (groups.isPending) return <PageSpinner />;
  if (groups.isError) return <EmptyState title="Could not load" text={errorMessage(groups.error)} />;
  return (
    <>
      <PageTitle>Settings</PageTitle>
      <ul className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {groups.data.map((g) => (
          <li key={g.group}><NavLink to={g.group} className="block rounded-2xl bg-white/5 border border-white/10 hover:border-[#00E676]/50 p-4 capitalize font-semibold">{g.group}<span className="block text-xs text-gray-500 normal-case font-normal">{g.secrets.length ? `${g.secrets.length} secret field(s)` : 'No secrets'}</span></NavLink></li>
        ))}
      </ul>
    </>
  );
}

const label = (k: string) => k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
const isSecretMask = (v: unknown) => typeof v === 'string' && v.startsWith('••••');

export function SettingsGroup() {
  const { group = '' } = useParams();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin-settings', group], queryFn: async () => ({ data: await admin.get<Data>(`/admin/settings/${group}`), info: (await admin.get<GroupInfo[]>('/admin/settings')).find((g) => g.group === group) }) });
  const revs = useQuery({ queryKey: ['admin-settings-rev', group], queryFn: () => admin.get<Revision[]>(`/admin/settings/${group}/revisions`) });
  if (q.isPending) return <PageSpinner />;
  if (q.isError) return <EmptyState title="Could not load" text={errorMessage(q.error)} />;
  // `key` remounts the form whenever a new version loads so edits never leak across versions
  return (
    <>
      <PageTitle>{label(group)} settings</PageTitle>
      <GroupForm key={`${group}-${q.data.data._version}`} group={group} data={q.data.data} secrets={q.data.info?.secrets ?? []} onSaved={() => { void qc.invalidateQueries({ queryKey: ['admin-settings', group] }); void qc.invalidateQueries({ queryKey: ['admin-settings-rev', group] }); void qc.invalidateQueries({ queryKey: ['settings'] }); }} />
      {group === 'mail' && <MailTest />}
      <section className="mt-8"><h2 className="font-bold mb-2">History</h2>
        <ul className="text-sm space-y-1">
          {(revs.data ?? []).map((r) => (
            <li key={r.version} className="flex items-center gap-3"><span>v{r.version}</span><span className="text-gray-500">{fmtDate(r.createdAt)}</span>
              {r.version !== q.data.data._version && <button className="text-xs underline" onClick={() => act(() => admin.post(`/admin/settings/${group}/restore`, { version: r.version }), `Restored v${r.version}`, () => { void qc.invalidateQueries({ queryKey: ['admin-settings', group] }); void qc.invalidateQueries({ queryKey: ['admin-settings-rev', group] }); }, `Restore version ${r.version}?`)}>Restore</button>}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

function GroupForm({ group, data, secrets, onSaved }: { group: string; data: Data; secrets: string[]; onSaved(): void }) {
  const fields = Object.entries(data).filter(([k]) => !k.startsWith('_'));
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const value = (k: string, orig: unknown) => (k in draft ? draft[k] : orig);
  const dirty = Object.keys(draft).length > 0;

  const save = async () => {
    setBusy(true);
    try {
      await admin.put(`/admin/settings/${group}`, draft);
      toast.success('Settings saved');
      onSaved();
    } catch (e) { toast.error(errorMessage(e, 'Could not save')); } finally { setBusy(false); }
  };
  const cls = 'w-full bg-gray-900 border border-gray-800 rounded-xl px-3 py-2 text-sm';
  return (
    <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="space-y-3 max-w-2xl">
      {fields.map(([k, orig]) => {
        const v = value(k, orig);
        const id = `s-${k}`;
        if (typeof orig === 'boolean') return <label key={k} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(v)} onChange={(e) => setDraft({ ...draft, [k]: e.target.checked })} />{label(k)}</label>;
        const secret = secrets.includes(k);
        return (
          <div key={k}>
            <label htmlFor={id} className="block text-xs font-bold text-gray-400 uppercase mb-1">{label(k)}{secret && ' (secret)'}</label>
            {typeof orig === 'object' && orig !== null
              ? <textarea id={id} rows={4} className={`${cls} font-mono`} value={typeof v === 'string' ? v : JSON.stringify(v, null, 2)} onChange={(e) => { try { setDraft({ ...draft, [k]: JSON.parse(e.target.value) }); } catch { setDraft({ ...draft, [k]: e.target.value }); } }} />
              : <input id={id} className={cls} type={typeof orig === 'number' ? 'number' : secret ? 'password' : 'text'} autoComplete="off"
                  value={String(v ?? '')} placeholder={isSecretMask(orig) ? 'Unchanged' : ''}
                  onChange={(e) => setDraft({ ...draft, [k]: typeof orig === 'number' ? Number(e.target.value) : e.target.value })} />}
            {secret && isSecretMask(orig) && !(k in draft) && <p className="text-xs text-gray-500 mt-1">Currently set ({String(orig)}). Type a new value to replace it.</p>}
          </div>
        );
      })}
      <Button type="submit" loading={busy} disabled={!dirty}>Save changes</Button>
    </form>
  );
}

function MailTest() {
  const [email, setEmail] = useState('');
  return (
    <section className="mt-6 max-w-2xl"><h2 className="font-bold mb-2">Send a test e-mail</h2>
      <div className="flex gap-2"><input aria-label="Test e-mail address" type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="flex-1 bg-gray-900 border border-gray-800 rounded-xl px-3 py-2 text-sm" />
        <Button variant="secondary" disabled={!email} onClick={() => act(() => admin.post('/admin/mail/test', { email }), 'Test e-mail sent')}>Send</Button></div>
    </section>
  );
}
