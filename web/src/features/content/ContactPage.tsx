import { useEffect, useRef, useState, type FormEvent } from 'react';
import toast from 'react-hot-toast';
import { useSession } from '@/features/session/SessionProvider';
import { useSiteSettings } from '@/features/settings/SettingsProvider';
import { client, unwrap } from '@/shared/api/client';
import { errorMessage, isApiError } from '@/shared/api/errors';
import { useT } from '@/shared/i18n/I18nProvider';
import { Button } from '@/shared/ui/Button';
import { FormField } from '@/shared/ui/FormField';
import { loadRecaptcha } from './recaptcha';

export default function ContactPage() {
  const t = useT();
  const settings = useSiteSettings();
  const { user } = useSession();
  const enabled = settings.get<boolean>('plugins', 'enableRecaptcha', false);
  const siteKey = settings.get<string>('plugins', 'recaptchaSiteKey', '');
  const version = settings.get<'v2' | 'v3'>('plugins', 'recaptchaVersion', 'v3');
  const useCaptcha = enabled && Boolean(siteKey);

  const [f, setF] = useState({ name: user?.isGuest ? '' : user?.name ?? '', email: user && !user.isGuest ? user.email ?? '' : '', message: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [v2Token, setV2Token] = useState('');
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!useCaptcha || version !== 'v2') return;
    let cancelled = false;
    loadRecaptcha(siteKey, 'v2').then(() => {
      if (!cancelled && box.current && !box.current.hasChildNodes()) window.grecaptcha?.render(box.current, { sitekey: siteKey, callback: setV2Token, 'expired-callback': () => setV2Token('') });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [useCaptcha, version, siteKey]);

  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    try {
      let recaptchaToken: string | undefined;
      if (useCaptcha) {
        if (version === 'v3') { await loadRecaptcha(siteKey, 'v3'); recaptchaToken = await window.grecaptcha!.execute(siteKey, { action: 'contact' }); }
        else recaptchaToken = v2Token;
      }
      await unwrap(client.POST('/contact', { body: { name: f.name.trim(), email: f.email.trim(), message: f.message.trim(), ...(recaptchaToken ? { recaptchaToken } : {}) } }));
      setSent(true);
    } catch (err) {
      setErrors(isApiError(err) ? err.fieldErrors : {});
      toast.error(isApiError(err) && Object.keys(err.fieldErrors).length ? t('Please check the highlighted fields') : errorMessage(err, t('Message not sent')));
    } finally { setBusy(false); }
  };

  if (sent) return <div role="status" className="max-w-md mx-auto py-20 px-4 text-center"><h1 className="text-2xl font-bold mb-2">{t('Thank you!')}</h1><p className="text-gray-400">{t('We received your message and will get back to you soon.')}</p></div>;
  return (
    <div className="max-w-lg mx-auto px-4 py-10">
      <h1 className="text-3xl font-bold mb-6">{t('Contact us')}</h1>
      <form onSubmit={submit} className="space-y-4">
        <FormField label={t('Name')} value={f.name} onChange={set('name')} error={errors.name} maxLength={120} required />
        <FormField label={t('Email')} type="email" value={f.email} onChange={set('email')} error={errors.email} maxLength={254} required />
        <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider">{t('Message')}
          <textarea value={f.message} onChange={set('message')} rows={6} minLength={5} maxLength={5000} required aria-invalid={errors.message ? true : undefined}
            className="mt-1.5 w-full bg-gray-900 text-white rounded-xl px-4 py-3 border border-gray-800 normal-case font-normal text-base" />
          {errors.message && <span role="alert" className="text-xs text-red-400 normal-case">{errors.message}</span>}
        </label>
        {useCaptcha && version === 'v2' && <div ref={box} />}
        <Button type="submit" loading={busy} className="w-full">{t('Send message')}</Button>
      </form>
    </div>
  );
}
