import { useState } from 'react';
import { Avatar } from '@/shared/ui/Avatar';
import { admin, fmtDate } from './adminApi';
import { act, Badge, LinkButton, PageTitle, PagedTable } from './ui';

interface Person { id: string; name: string; username: string; avatar: string; isBanned: boolean; exists: boolean }
interface Report { id: string; reason: string; details: string; status: string; createdAt: string; reporter: Person; reported: Person }
interface Mail { id: string; name: string; email: string; message: string; status: string; createdAt: string }

const Who = ({ p }: { p: Person }) => <span className="flex items-center gap-2"><Avatar src={p.avatar} name={p.name} className="w-6 h-6" />{p.name}{p.isBanned && <Badge tone="red">banned</Badge>}</span>;
const Filter = ({ value, onChange, options }: { value: string; onChange(v: string): void; options: string[] }) => (
  <select aria-label="Status filter" value={value} onChange={(e) => onChange(e.target.value)} className="bg-gray-900 border border-gray-800 rounded-xl px-3 py-2 text-sm">
    <option value="">All</option>{options.map((o) => <option key={o} value={o}>{o}</option>)}
  </select>
);

export function Reports() {
  const [status, setStatus] = useState('');
  return (
    <>
      <PageTitle action={<Filter value={status} onChange={setStatus} options={['pending', 'reviewed', 'resolved', 'dismissed']} />}>Reports</PageTitle>
      <PagedTable<Report> queryKey="admin-reports" path="/admin/reports" query={{ status: status || undefined }}
        columns={[
          { header: 'Reported', cell: (r) => <Who p={r.reported} /> },
          { header: 'By', cell: (r) => <Who p={r.reporter} /> },
          { header: 'Reason', cell: (r) => <span><b>{r.reason}</b>{r.details && <><br /><span className="text-xs text-gray-400">{r.details}</span></>}</span> },
          { header: 'Status', cell: (r) => <Badge tone={r.status === 'pending' ? 'yellow' : 'gray'}>{r.status}</Badge> },
          { header: 'When', cell: (r) => fmtDate(r.createdAt) },
        ]}
        actions={(r, reload) => (
          <>
            {r.status === 'pending' && <LinkButton onClick={() => act(() => admin.patch(`/admin/reports/${r.id}`, { status: 'resolved' }), 'Resolved', reload)}>Resolve</LinkButton>}
            {r.status === 'pending' && <LinkButton onClick={() => act(() => admin.patch(`/admin/reports/${r.id}`, { status: 'dismissed' }), 'Dismissed', reload)}>Dismiss</LinkButton>}
            {r.reported.exists && !r.reported.isBanned && <LinkButton danger onClick={() => act(() => admin.post(`/admin/users/${r.reported.id}/ban`, {}), 'User banned', reload, `Ban ${r.reported.name}?`)}>Ban user</LinkButton>}
            <LinkButton danger onClick={() => act(() => admin.del(`/admin/reports/${r.id}`), 'Deleted', reload, 'Delete this report?')}>Delete</LinkButton>
          </>
        )} />
    </>
  );
}

export function Mailbox() {
  const [status, setStatus] = useState('');
  return (
    <>
      <PageTitle action={<Filter value={status} onChange={setStatus} options={['unread', 'read', 'archived']} />}>Mailbox</PageTitle>
      <PagedTable<Mail> queryKey="admin-mailbox" path="/admin/mailbox" query={{ status: status || undefined }}
        columns={[
          { header: 'From', cell: (m) => <span><b className={m.status === 'unread' ? 'text-[#00E676]' : ''}>{m.name}</b><br /><a href={`mailto:${m.email}`} className="text-xs text-gray-400 hover:underline">{m.email}</a></span> },
          { header: 'Message', className: 'max-w-md whitespace-pre-wrap break-words', cell: (m) => m.message },
          { header: 'When', cell: (m) => fmtDate(m.createdAt) },
        ]}
        actions={(m, reload) => (
          <>
            {m.status === 'unread' && <LinkButton onClick={() => act(() => admin.patch(`/admin/mailbox/${m.id}`, { status: 'read' }), 'Marked read', reload)}>Mark read</LinkButton>}
            {m.status !== 'archived' && <LinkButton onClick={() => act(() => admin.patch(`/admin/mailbox/${m.id}`, { status: 'archived' }), 'Archived', reload)}>Archive</LinkButton>}
            <LinkButton danger onClick={() => act(() => admin.del(`/admin/mailbox/${m.id}`), 'Deleted', reload, 'Delete this message?')}>Delete</LinkButton>
          </>
        )} />
    </>
  );
}
