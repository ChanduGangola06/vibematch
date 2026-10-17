import { useState } from 'react';
import { Link } from 'react-router';
import { useDebounced } from '@/shared/lib/useDebounced';
import { Avatar } from '@/shared/ui/Avatar';
import { Button } from '@/shared/ui/Button';
import { Modal } from '@/shared/ui/Modal';
import { admin, fmtDate } from './adminApi';
import { act, Badge, LinkButton, PageTitle, PagedTable } from './ui';

interface AdminUser { id: string; username: string; name: string; email?: string; avatar: string; role: string; gems: number; isVip: boolean; isBanned: boolean; isGuest: boolean; isDemo: boolean; createdAt: string; lastLoginAt?: string }

export default function Users() {
  const [search, setSearch] = useState('');
  const [role, setRole] = useState('');
  const [state, setState] = useState('');
  const q = useDebounced(search, 300);
  const [gemsFor, setGemsFor] = useState<AdminUser | null>(null);
  return (
    <>
      <PageTitle>Users</PageTitle>
      <div className="flex flex-wrap gap-2 mb-4">
        <input aria-label="Search users" placeholder="Search name, username, email…" value={search} onChange={(e) => setSearch(e.target.value)} className="bg-gray-900 border border-gray-800 rounded-xl px-3 py-2 text-sm flex-1 min-w-48" />
        <select aria-label="Role" value={role} onChange={(e) => setRole(e.target.value)} className="bg-gray-900 border border-gray-800 rounded-xl px-3 py-2 text-sm"><option value="">All roles</option><option value="user">User</option><option value="admin">Admin</option><option value="guest">Guest</option></select>
        <select aria-label="Status" value={state} onChange={(e) => setState(e.target.value)} className="bg-gray-900 border border-gray-800 rounded-xl px-3 py-2 text-sm"><option value="">Any status</option><option value="banned">Banned</option><option value="vip">VIP</option></select>
      </div>
      <PagedTable<AdminUser> queryKey="admin-users" path="/admin/users"
        query={{ q: q || undefined, role: role || undefined, banned: state === 'banned' ? true : undefined, vip: state === 'vip' ? true : undefined }}
        columns={[
          { header: 'User', cell: (u) => <Link to={`/u/${u.username}`} className="flex items-center gap-2 hover:underline"><Avatar src={u.avatar} name={u.name} className="w-8 h-8" /><span><b>{u.name}</b><br /><span className="text-xs text-gray-400">@{u.username}{u.email ? ` · ${u.email}` : ''}</span></span></Link> },
          { header: 'Role', cell: (u) => <Badge tone={u.role === 'admin' ? 'yellow' : 'gray'}>{u.role}</Badge> },
          { header: 'Status', cell: (u) => <span className="flex gap-1">{u.isBanned && <Badge tone="red">banned</Badge>}{u.isVip && <Badge tone="green">VIP</Badge>}{u.isDemo && <Badge>demo</Badge>}</span> },
          { header: 'Gems', cell: (u) => u.gems.toLocaleString() },
          { header: 'Joined', cell: (u) => fmtDate(u.createdAt) },
        ]}
        actions={(u, reload) => (
          <>
            <LinkButton onClick={() => setGemsFor(u)}>Gems</LinkButton>
            {u.role !== 'guest' && <LinkButton onClick={() => act(() => admin.put(`/admin/users/${u.id}/role`, { role: u.role === 'admin' ? 'user' : 'admin' }), 'Role updated', reload, `${u.role === 'admin' ? 'Remove admin rights from' : 'Make admin:'} @${u.username}?`)}>{u.role === 'admin' ? 'Demote' : 'Promote'}</LinkButton>}
            {u.isBanned
              ? <LinkButton onClick={() => act(() => admin.del(`/admin/users/${u.id}/ban`), 'Unbanned', reload)}>Unban</LinkButton>
              : <LinkButton danger onClick={() => act(() => admin.post(`/admin/users/${u.id}/ban`, {}), 'Banned', reload, `Ban @${u.username}?`)}>Ban</LinkButton>}
            <LinkButton danger onClick={() => act(() => admin.del(`/admin/users/${u.id}`), 'Deleted', reload, `Permanently delete @${u.username}?`)}>Delete</LinkButton>
          </>
        )}
      />
      {gemsFor && <GemsDialog user={gemsFor} onClose={() => setGemsFor(null)} />}
    </>
  );
}

function GemsDialog({ user, onClose }: { user: AdminUser; onClose(): void }) {
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const n = Number(amount);
  const submit = async () => {
    setBusy(true);
    await act(() => admin.post(`/admin/users/${user.id}/gems`, { amount: n, ...(note ? { note } : {}) }), 'Balance updated');
    setBusy(false);
    onClose();
  };
  return (
    <Modal open onClose={onClose} title={`Adjust gems · @${user.username}`} size="sm" locked={busy}>
      <p className="text-sm text-gray-400 mb-3">Current balance: {user.gems.toLocaleString()}. Use a negative number to deduct.</p>
      <input type="number" aria-label="Amount" value={amount} onChange={(e) => setAmount(e.target.value)} className="w-full bg-gray-900 border border-gray-800 rounded-xl px-3 py-2 mb-2" />
      <input aria-label="Note" placeholder="Note (audit log)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} className="w-full bg-gray-900 border border-gray-800 rounded-xl px-3 py-2 mb-3" />
      <Button className="w-full" loading={busy} disabled={!Number.isInteger(n) || n === 0} onClick={submit}>Apply</Button>
    </Modal>
  );
}
