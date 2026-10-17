import { useRef, useState, type FormEvent } from 'react';
import toast from 'react-hot-toast';
import { useSession } from '@/features/session/SessionProvider';
import { client, rawFetch, unwrap } from '@/shared/api/client';
import { errorMessage, isApiError } from '@/shared/api/errors';
import type { SelfUser } from '@/shared/api/types';
import { useT } from '@/shared/i18n/I18nProvider';
import { COUNTRIES } from '@/shared/lib/countries';
import { Avatar } from '@/shared/ui/Avatar';
import { Button } from '@/shared/ui/Button';
import { FormField } from '@/shared/ui/FormField';
import { Modal } from '@/shared/ui/Modal';

const PRESETS = ['male', 'female'].flatMap((g) => [1, 2, 3, 4].map((n) => `/images/avatars/${g}-${n}.svg`));

export function EditProfileModal({ open, onClose }: { open: boolean; onClose(): void }) {
  const { user } = useSession();
  if (!user) return null;
  return <EditForm key={String(open)} user={user} open={open} onClose={onClose} />;
}

function EditForm({ user, open, onClose }: { user: SelfUser; open: boolean; onClose(): void }) {
  const t = useT();
  const { patchUser } = useSession();
  const [f, setF] = useState({ name: user.name, username: user.username, bio: user.bio, age: user.age ? String(user.age) : '', gender: user.gender, countryCode: user.countryCode });
  const [avatar, setAvatar] = useState(user.avatar);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));

  const upload = async (picked: File | undefined) => {
    if (!picked) return;
    setBusy(true);
    try {
      const body = new FormData();
      body.append('avatar', picked);
      const res = await rawFetch('/users/me/avatar', { method: 'POST', body });
      const json = (await res.json()) as { data?: SelfUser; detail?: string };
      if (!res.ok || !json.data) throw new Error(json.detail ?? 'Upload failed');
      setAvatar(json.data.avatar);
      patchUser({ avatar: json.data.avatar });
    } catch (e) {
      toast.error(errorMessage(e, t('Could not upload the photo')));
    } finally { setBusy(false); }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    const country = COUNTRIES.find((c) => c.code === f.countryCode);
    try {
      const body = {
        name: f.name.trim(), username: f.username.trim(), bio: f.bio, gender: f.gender as 'male' | 'female' | 'other',
        ...(f.age ? { age: Number(f.age) } : {}),
        ...(country ? { country: country.name, countryCode: country.code } : {}),
        ...(PRESETS.includes(avatar) && avatar !== user.avatar ? { avatar } : {}),
      };
      const updated = await unwrap(client.PATCH('/users/me', { body }));
      patchUser(updated);
      toast.success(t('Profile updated'));
      onClose();
    } catch (err) {
      setErrors(isApiError(err) ? err.fieldErrors : {});
      toast.error(isApiError(err) && Object.keys(err.fieldErrors).length ? t('Please check the highlighted fields') : errorMessage(err, t('Could not save your profile')));
    } finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title={t('Edit profile')} size="md" locked={busy}>
      <form onSubmit={submit} className="space-y-4">
        <div className="flex items-center gap-3">
          <Avatar src={avatar} name={f.name} className="w-16 h-16" />
          <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" hidden aria-label={t('Upload photo')} onChange={(e) => void upload(e.target.files?.[0])} />
          <Button variant="secondary" onClick={() => file.current?.click()} disabled={busy}>{t('Upload photo')}</Button>
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label={t('Choose an avatar')}>
          {PRESETS.map((p) => (
            <button type="button" key={p} aria-pressed={avatar === p} aria-label={p.split('/').pop()} onClick={() => setAvatar(p)} className={`rounded-full ring-2 ${avatar === p ? 'ring-[#00E676]' : 'ring-transparent'}`}>
              <Avatar src={p} name="" className="w-10 h-10" />
            </button>
          ))}
        </div>
        <FormField label={t('Name')} value={f.name} onChange={set('name')} error={errors.name} maxLength={60} required />
        <FormField label={t('Username')} value={f.username} onChange={set('username')} error={errors.username} maxLength={20} required />
        <FormField label={t('Age')} type="number" min={13} max={120} value={f.age} onChange={set('age')} error={errors.age} />
        <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider">{t('Gender')}
          <select value={f.gender} onChange={set('gender')} className="mt-1.5 w-full bg-gray-900 text-white rounded-xl px-4 py-3 border border-gray-800 normal-case font-normal text-base">
            <option value="male">{t('Male')}</option><option value="female">{t('Female')}</option><option value="other">{t('Other')}</option>
          </select>
        </label>
        <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider">{t('Country')}
          <select value={f.countryCode} onChange={set('countryCode')} className="mt-1.5 w-full bg-gray-900 text-white rounded-xl px-4 py-3 border border-gray-800 normal-case font-normal text-base">
            <option value="">—</option>
            {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.flag} {c.name}</option>)}
          </select>
        </label>
        <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider">{t('Bio')}
          <textarea value={f.bio} onChange={set('bio')} maxLength={500} rows={3} className="mt-1.5 w-full bg-gray-900 text-white rounded-xl px-4 py-3 border border-gray-800 normal-case font-normal text-base" />
        </label>
        <Button type="submit" loading={busy} className="w-full">{t('Save')}</Button>
      </form>
    </Modal>
  );
}
