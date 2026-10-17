import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import toast from 'react-hot-toast';
import { rawFetch } from '@/shared/api/client';
import { errorMessage } from '@/shared/api/errors';
import { Button } from '@/shared/ui/Button';
import { Modal } from '@/shared/ui/Modal';
import { admin, fmtDate } from './adminApi';
import { ResourceEditor } from './ResourceEditor';
import { act, Badge, LinkButton, PageTitle, PagedTable } from './ui';

// ---- purchases -----------------------------------------------------------------------------------
interface Purchase { id: string; provider: string; packName: string; gems: number; amount: number; currency: string; status: string; createdAt: string; userId?: string; username?: string }

export function Purchases() {
  const [provider, setProvider] = useState('');
  const exportCsv = async () => {
    try {
      const res = await rawFetch(`/admin/purchases/export${provider ? `?provider=${provider}` : ''}`);
      if (!res.ok) throw new Error('Export failed');
      const url = URL.createObjectURL(await res.blob());
      const a = Object.assign(document.createElement('a'), { href: url, download: 'purchases.csv' });
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) { toast.error(errorMessage(e)); }
  };
  return (
    <>
      <PageTitle action={<span className="flex gap-2">
        <select aria-label="Provider" value={provider} onChange={(e) => setProvider(e.target.value)} className="bg-gray-900 border border-gray-800 rounded-xl px-3 py-2 text-sm"><option value="">All providers</option>{['stripe', 'paypal', 'razorpay', 'google', 'apple'].map((p) => <option key={p}>{p}</option>)}</select>
        <Button variant="secondary" onClick={exportCsv}>Export CSV</Button></span>}>Purchases</PageTitle>
      <PagedTable<Purchase> queryKey="admin-purchases" path="/admin/purchases" query={{ provider: provider || undefined }}
        columns={[
          { header: 'When', cell: (p) => fmtDate(p.createdAt) }, { header: 'User', cell: (p) => p.username ?? p.userId ?? '—' }, { header: 'Provider', cell: (p) => p.provider },
          { header: 'Pack', cell: (p) => `${p.packName} (${p.gems})` }, { header: 'Amount', cell: (p) => p.amount.toLocaleString(undefined, { style: 'currency', currency: p.currency }) },
          { header: 'Status', cell: (p) => <Badge tone={p.status === 'completed' ? 'green' : 'yellow'}>{p.status}</Badge> },
        ]} />
    </>
  );
}

// ---- audit log -----------------------------------------------------------------------------------
interface Audit { id: string; actorName: string; actorId: string; action: string; target: string; meta: unknown; ip: string; createdAt: string }

export function AuditLog() {
  const [action, setAction] = useState('');
  return (
    <>
      <PageTitle action={<input aria-label="Filter by action" placeholder="e.g. user.ban" value={action} onChange={(e) => setAction(e.target.value)} className="bg-gray-900 border border-gray-800 rounded-xl px-3 py-2 text-sm" />}>Audit log</PageTitle>
      <PagedTable<Audit> queryKey="admin-audit" path="/admin/audit-log" query={{ action: action || undefined }}
        columns={[
          { header: 'When', cell: (a) => fmtDate(a.createdAt) }, { header: 'Who', cell: (a) => a.actorName || a.actorId }, { header: 'Action', cell: (a) => <code>{a.action}</code> },
          { header: 'Target', cell: (a) => a.target || '—' }, { header: 'Details', className: 'max-w-xs truncate font-mono text-xs text-gray-400', cell: (a) => (a.meta ? JSON.stringify(a.meta) : '') }, { header: 'IP', cell: (a) => a.ip },
        ]} />
    </>
  );
}

// ---- API keys ------------------------------------------------------------------------------------
interface ApiKey { id: string; name: string; level: string; scopes: string[]; hint: string; createdAt: string; expiresAt?: string; revokedAt?: string; lastUsedAt?: string }

export function ApiKeys() {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<{ plain: string; name: string } | null>(null);
  const reload = () => void qc.invalidateQueries({ queryKey: ['admin-keys'] });
  return (
    <>
      <PageTitle action={<Button onClick={() => setCreating(true)}>New key</Button>}>API keys</PageTitle>
      <p className="text-sm text-gray-400 mb-4 max-w-2xl">Keys cap what a client may do: <b>public</b> &lt; <b>mobile</b> &lt; <b>partner</b> &lt; <b>admin</b>. The mobile apps need a <b>mobile</b> key.</p>
      <PagedTable<ApiKey> queryKey="admin-keys" path="/admin/api-keys" query={{ includeRevoked: true }}
        columns={[
          { header: 'Name', cell: (k) => k.name }, { header: 'Key', cell: (k) => <code>{k.hint}</code> }, { header: 'Level', cell: (k) => <Badge>{k.level}</Badge> },
          { header: 'Last used', cell: (k) => fmtDate(k.lastUsedAt) }, { header: 'Expires', cell: (k) => fmtDate(k.expiresAt) },
          { header: 'Status', cell: (k) => (k.revokedAt ? <Badge tone="red">revoked</Badge> : <Badge tone="green">active</Badge>) },
        ]}
        actions={(k, rl) => k.revokedAt ? null : (
          <>
            <LinkButton onClick={async () => { if (!window.confirm(`Rotate "${k.name}"? The old key stops working immediately.`)) return; try { const r = await admin.post<{ key: string }>(`/admin/api-keys/${k.id}/rotate`); setSecret({ plain: r.key, name: k.name }); rl(); } catch (e) { toast.error(errorMessage(e)); } }}>Rotate</LinkButton>
            <LinkButton danger onClick={() => act(() => admin.del(`/admin/api-keys/${k.id}`), 'Key revoked', () => { rl(); reload(); }, `Revoke "${k.name}"?`)}>Revoke</LinkButton>
          </>
        )} />
      {creating && <ResourceEditor title="New API key" onClose={() => setCreating(false)}
        fields={[{ name: 'name', label: 'Name', required: true }, { name: 'level', label: 'Level', type: 'select', options: ['public', 'mobile', 'partner', 'admin'] }, { name: 'expiresInDays', label: 'Expires in (days)', type: 'number', hint: 'Leave empty for no expiry' }]}
        initial={{ level: 'mobile' }}
        onSubmit={async (v) => { const r = await admin.post<{ key: string }>('/admin/api-keys', v); setSecret({ plain: r.key, name: String(v.name) }); reload(); }} />}
      {secret && (
        <Modal open onClose={() => setSecret(null)} title={`Key for “${secret.name}”`} size="md">
          <p className="text-sm text-yellow-400 mb-2">Copy it now — it will not be shown again.</p>
          <code className="block break-all bg-black/40 rounded-xl p-3 text-sm select-all" data-testid="api-key-secret">{secret.plain}</code>
          <Button className="w-full mt-3" onClick={() => { void navigator.clipboard?.writeText(secret.plain); toast.success('Copied'); }}>Copy</Button>
        </Modal>
      )}
    </>
  );
}

// ---- backup --------------------------------------------------------------------------------------
export function Backup() {
  const [secrets, setSecrets] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState('dry-run');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<unknown>(null);

  const download = async () => {
    try {
      const res = await rawFetch(`/admin/backup?includeSecrets=${secrets}`);
      if (!res.ok) throw new Error('Backup failed');
      const url = URL.createObjectURL(await res.blob());
      Object.assign(document.createElement('a'), { href: url, download: `vibematch-backup-${new Date().toISOString().slice(0, 10)}.ndjson` }).click();
      URL.revokeObjectURL(url);
    } catch (e) { toast.error(errorMessage(e)); }
  };
  const restore = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.append('mode', mode);
      if (mode !== 'dry-run') form.append('confirm', confirm);
      form.append('backup', file);
      setReport(await admin.upload('POST', '/admin/backup/restore', form));
      toast.success(mode === 'dry-run' ? 'Backup is valid' : 'Restore finished');
    } catch (e) { toast.error(errorMessage(e, 'Restore failed')); } finally { setBusy(false); }
  };
  const input = 'bg-gray-900 border border-gray-800 rounded-xl px-3 py-2 text-sm';
  return (
    <>
      <PageTitle>Backup &amp; restore</PageTitle>
      <section className="max-w-2xl space-y-3 mb-10">
        <h2 className="font-bold">Download</h2>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={secrets} onChange={(e) => setSecrets(e.target.checked)} />Include encrypted secrets (API keys of payment gateways etc.)</label>
        <Button onClick={download}>Download backup</Button>
      </section>
      <section className="max-w-2xl space-y-3">
        <h2 className="font-bold">Restore</h2>
        <input type="file" aria-label="Backup file" accept=".ndjson,application/x-ndjson,application/json" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-sm block" />
        <select aria-label="Mode" value={mode} onChange={(e) => setMode(e.target.value)} className={input}><option value="dry-run">Validate only (dry run)</option><option value="merge">Merge into existing data</option><option value="replace">Replace everything</option></select>
        {mode !== 'dry-run' && <input aria-label="Type RESTORE to confirm" placeholder="Type RESTORE to confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} className={`${input} block`} />}
        <Button variant={mode === 'replace' ? 'danger' : 'primary'} loading={busy} disabled={!file || (mode !== 'dry-run' && confirm !== 'RESTORE')} onClick={restore}>{mode === 'dry-run' ? 'Validate' : 'Restore'}</Button>
        {report !== null && <pre className="text-xs bg-black/40 rounded-xl p-3 overflow-auto max-h-64">{JSON.stringify(report, null, 2)}</pre>}
      </section>
    </>
  );
}
