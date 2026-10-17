import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSession } from '@/features/session/SessionProvider';
import { Button } from '@/shared/ui/Button';
import { admin, fmtDate } from './adminApi';
import { act, LinkButton, PageTitle } from './ui';

interface Passkey { id: string; label: string; createdAt: string; lastUsedAt?: string }

/** Registers a passkey with the browser's native WebAuthn JSON helpers (Chrome 129+, Safari 18.4+, Firefox 119+). */
async function createPasskey(label: string) {
  if (!('PublicKeyCredential' in window) || !('parseCreationOptionsFromJSON' in PublicKeyCredential)) throw new Error('This browser does not support passkey registration.');
  const options = await admin.post<unknown>('/auth/webauthn/register/options');
  const publicKey = (PublicKeyCredential as unknown as { parseCreationOptionsFromJSON(o: unknown): PublicKeyCredentialCreationOptions }).parseCreationOptionsFromJSON(options);
  const cred = (await navigator.credentials.create({ publicKey })) as (PublicKeyCredential & { toJSON(): unknown }) | null;
  if (!cred) throw new Error('Passkey creation was cancelled.');
  return admin.post('/auth/webauthn/register/verify', { credential: cred.toJSON(), ...(label ? { label } : {}) });
}

export default function Security() {
  const { user } = useSession();
  const qc = useQueryClient();
  const keys = useQuery({ queryKey: ['admin-passkeys'], queryFn: () => admin.get<Passkey[]>('/auth/webauthn/credentials') });
  const [label, setLabel] = useState('');
  const [required, setRequired] = useState(Boolean((user as { requirePasskey?: boolean } | null)?.requirePasskey));
  const reload = () => void qc.invalidateQueries({ queryKey: ['admin-passkeys'] });
  return (
    <>
      <PageTitle>Security</PageTitle>
      <section className="max-w-2xl space-y-4">
        <h2 className="font-bold">Passkeys</h2>
        <p className="text-sm text-gray-400">Passkeys (WebAuthn) protect your administrator account with your device's biometrics or a security key. Register at least one before requiring them.</p>
        <ul className="space-y-2">
          {(keys.data ?? []).map((k) => (
            <li key={k.id} className="flex items-center justify-between rounded-xl bg-white/5 px-3 py-2 text-sm">
              <span><b>{k.label || 'Passkey'}</b><br /><span className="text-xs text-gray-500">Added {fmtDate(k.createdAt)}{k.lastUsedAt ? ` · used ${fmtDate(k.lastUsedAt)}` : ''}</span></span>
              <LinkButton danger label={`Remove ${k.label || 'passkey'}`} onClick={() => act(() => admin.del(`/auth/webauthn/credentials/${encodeURIComponent(k.id)}`), 'Passkey removed', reload, 'Remove this passkey?')}>Remove</LinkButton>
            </li>
          ))}
          {keys.data?.length === 0 && <li className="text-sm text-gray-500">No passkeys yet.</li>}
        </ul>
        <div className="flex gap-2">
          <input aria-label="Passkey name" placeholder="Name (e.g. MacBook)" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} className="flex-1 bg-gray-900 border border-gray-800 rounded-xl px-3 py-2 text-sm" />
          <Button onClick={() => act(() => createPasskey(label), 'Passkey added', () => { setLabel(''); reload(); })}>Add passkey</Button>
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={required} onChange={(e) => { setRequired(e.target.checked); void act(() => admin.put('/auth/webauthn/require', { required: e.target.checked }), e.target.checked ? 'Passkey now required at sign-in' : 'Passkey no longer required'); }} />Require a passkey when signing in</label>
      </section>
    </>
  );
}
