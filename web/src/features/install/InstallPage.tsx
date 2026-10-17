import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { client, unwrap } from '@/shared/api/client';
import { errorMessage, isApiError } from '@/shared/api/errors';
import { Button } from '@/shared/ui/Button';
import { FormField } from '@/shared/ui/FormField';
import { PageSpinner } from '@/shared/ui/Spinner';

/** First-run wizard. The API refuses `/install/complete` once an admin exists, so this page is inert on a live site. */
export default function InstallPage() {
  const status = useQuery({ queryKey: ['install-status'], queryFn: () => unwrap(client.GET('/install/status')), retry: false });
  const [f, setF] = useState({ siteName: 'VibeMatch', siteUrl: window.location.origin, adminUsername: 'admin', adminEmail: '', adminPassword: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));

  if (status.isPending) return <PageSpinner />;
  if (status.isError) return <Box title="Cannot reach the server"><p className="text-gray-400">{errorMessage(status.error)}</p></Box>;
  if (done) return <Box title="Installation complete"><p className="text-gray-400 mb-4">Sign in with your new administrator account.</p><Link to="/" className="px-4 py-2 rounded-xl bg-[#00E676] text-black font-bold">Open the site</Link></Box>;
  if (status.data.installed) return <Box title="Already installed"><p className="text-gray-400 mb-4">This site is set up. Manage it from the admin dashboard.</p><Link to="/" className="underline">Home</Link></Box>;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setErrors({}); setError('');
    try {
      await unwrap(client.POST('/install/complete', { body: f }));
      setDone(true);
    } catch (err) {
      setErrors(isApiError(err) ? err.fieldErrors : {});
      setError(isApiError(err) && Object.keys(err.fieldErrors).length ? 'Please check the highlighted fields' : errorMessage(err, 'Installation failed'));
    } finally { setBusy(false); }
  };

  return (
    <Box title="Set up your site">
      <ul className="text-xs text-gray-400 mb-4 space-y-1">
        <li>{status.data.database.connected ? '✓' : '✗'} Database connected</li>
        <li>{status.data.database.transactions ? '✓' : '✗'} Transactions available (replica set)</li>
      </ul>
      <form onSubmit={submit} className="space-y-4">
        <FormField label="Site name" value={f.siteName} onChange={set('siteName')} error={errors.siteName} required />
        <FormField label="Site URL" type="url" value={f.siteUrl} onChange={set('siteUrl')} error={errors.siteUrl} required />
        <FormField label="Admin username" value={f.adminUsername} onChange={set('adminUsername')} error={errors.adminUsername} required />
        <FormField label="Admin email" type="email" value={f.adminEmail} onChange={set('adminEmail')} error={errors.adminEmail} required />
        <FormField label="Admin password" type="password" autoComplete="new-password" minLength={8} value={f.adminPassword} onChange={set('adminPassword')} error={errors.adminPassword} hint="At least 8 characters" required />
        {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
        <Button type="submit" loading={busy} disabled={!status.data.database.connected} className="w-full">Install</Button>
      </form>
    </Box>
  );
}

const Box = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="min-h-[100dvh] flex items-center justify-center p-4"><div className="w-full max-w-md bg-white/5 border border-white/10 rounded-3xl p-6"><h1 className="text-2xl font-bold mb-4">{title}</h1>{children}</div></div>
);
