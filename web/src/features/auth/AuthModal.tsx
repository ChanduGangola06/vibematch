import { Apple, Mail, Phone, Sparkles, UserRound } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import toast from 'react-hot-toast';
import { useUi } from '@/app/UiProvider';
import { useSiteSettings } from '@/features/settings/SettingsProvider';
import { useSession } from '@/features/session/SessionProvider';
import { ApiError, errorMessage } from '@/shared/api/errors';
import { confirmPhoneCode, firebaseMessage, sendPhoneCode, signInWithProvider, type SocialProvider } from '@/shared/firebase/firebase';
import { useT } from '@/shared/i18n/I18nProvider';
import { Button } from '@/shared/ui/Button';
import { FormField } from '@/shared/ui/FormField';
import { FacebookIcon, XIcon } from '@/shared/ui/BrandIcons';
import { useDebounced } from '@/shared/lib/useDebounced';
import { Modal } from '@/shared/ui/Modal';
import * as authApi from './api';

type Tab = 'quick' | 'email';
type Gender = 'male' | 'female';
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

/** The dialog shell. The form lives in a child that only mounts while open, so its state resets on every open. */
export function AuthModal() {
  const ui = useUi();
  const t = useT();
  const settings = useSiteSettings();
  const title = ui.authReason ?? t('Join {site}', { site: settings.siteName });
  return (
    <Modal open={ui.isOpen('auth')} onClose={() => ui.close('auth')} title={title} size="sm">
      <AuthForm />
    </Modal>
  );
}

function AuthForm() {
  const ui = useUi();
  const t = useT();
  const settings = useSiteSettings();
  const session = useSession();

  const flag = (key: string) => settings.get<boolean>('auth', key, true) !== false;
  const firebaseConfig = settings.get<string>('auth', 'firebaseConfig', '');
  const socials = (['google', 'facebook', 'apple', 'twitter'] as SocialProvider[]).filter((p) => flag(`${p}Login`) && firebaseConfig);

  const [tab, setTab] = useState<Tab>('quick');
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [gender, setGender] = useState<Gender>('female');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [form, setForm] = useState({ identifier: '', password: '', username: '', email: '', name: '' });
  const [phone, setPhone] = useState({ open: false, number: '', code: '', sent: false });
  const debouncedUsername = useDebounced(form.username, 350);
  const availability = useQuery({
    queryKey: ['username-available', debouncedUsername],
    queryFn: () => authApi.checkUsername(debouncedUsername),
    enabled: mode === 'register' && USERNAME_RE.test(debouncedUsername),
    staleTime: 30_000,
  });
  const usernameState: 'idle' | 'checking' | 'ok' | 'taken' | 'invalid' =
    mode !== 'register' || !form.username ? 'idle'
    : !USERNAME_RE.test(form.username) ? 'invalid'
    : debouncedUsername !== form.username || availability.isFetching ? 'checking'
    : availability.data ? (availability.data.available ? 'ok' : 'taken') : 'idle';

  const finish = (r: authApi.AuthSuccess) => {
    session.signIn(r.tokens, r.user);
    ui.close('auth');
    if (r.isNewUser && !r.user.isGuest && r.user.gems > 0) toast.success(t('Welcome! You received {gems} gems', { gems: r.user.gems }));
    else toast.success(t('Welcome back'));
  };

  const run = async (fn: () => Promise<authApi.AuthSuccess>, fallback: string) => {
    setBusy(true);
    setError(null);
    setFields({});
    try {
      finish(await fn());
    } catch (e) {
      if (e instanceof ApiError) setFields(e.fieldErrors);
      setError(
        e instanceof authApi.PasskeyRequiredError ? e.message
        : e instanceof ApiError && e.status === 422 && Object.keys(e.fieldErrors).length ? t('Please check the highlighted fields')
        : e instanceof ApiError ? errorMessage(e, fallback)
        : firebaseMessage(e),
      );
    } finally {
      setBusy(false);
    }
  };

  const onSocial = (p: SocialProvider) => run(async () => authApi.social(await signInWithProvider(p, firebaseConfig), gender), t('Sign-in failed'));
  const onGuest = () => run(authApi.guest, t('Guest sign-in failed'));

  const sendCode = async () => {
    setBusy(true);
    setError(null);
    try {
      await sendPhoneCode(phone.number.trim(), 'recaptcha-container', firebaseConfig);
      setPhone((p) => ({ ...p, sent: true }));
    } catch (e) {
      setError(firebaseMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const verifyCode = () => run(async () => authApi.social(await confirmPhoneCode(phone.code.trim()), gender), t('Verification failed'));

  const onEmailSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (mode === 'login') return void run(() => authApi.login(form.identifier.trim(), form.password), t('Sign-in failed'));
    return void run(
      () => authApi.register({ username: form.username.trim(), email: form.email.trim(), password: form.password, ...(form.name.trim() ? { name: form.name.trim() } : {}), gender }),
      t('Could not create the account'),
    );
  };

  return (
      <div className="space-y-5">
        <div role="tablist" aria-label={t('Sign-in method')} className="grid grid-cols-2 gap-1 p-1 rounded-xl bg-black/30">
          {(['quick', 'email'] as Tab[]).map((id) => (
            <button key={id} role="tab" aria-selected={tab === id} onClick={() => { setTab(id); setError(null); }}
              className={`py-2 rounded-lg text-sm font-bold transition-colors ${tab === id ? 'bg-[#00E676] text-black' : 'text-gray-400 hover:text-white'}`}>
              {id === 'quick' ? <><Sparkles className="inline w-4 h-4 mr-1" aria-hidden="true" />{t('Quick start')}</> : <><Mail className="inline w-4 h-4 mr-1" aria-hidden="true" />{t('Email')}</>}
            </button>
          ))}
        </div>

        {error && <div role="alert" className="p-3 rounded-xl bg-red-500/15 border border-red-500/30 text-red-200 text-sm font-semibold text-center">{error}</div>}

        <fieldset className="space-y-2">
          <legend className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">{t('I am')}</legend>
          <div className="grid grid-cols-2 gap-2">
            {(['female', 'male'] as Gender[]).map((g) => (
              <button key={g} type="button" aria-pressed={gender === g} onClick={() => setGender(g)}
                className={`py-2.5 rounded-xl text-sm font-bold border transition-colors ${gender === g ? 'border-[#00E676] bg-[#00E676]/15 text-[#00E676]' : 'border-white/10 text-gray-300 hover:bg-white/5'}`}>
                {g === 'female' ? t('Female') : t('Male')}
              </button>
            ))}
          </div>
        </fieldset>

        {tab === 'quick' && (
          <div className="space-y-3">
            {flag('guestLogin') && (
              <Button onClick={onGuest} loading={busy} className="w-full"><UserRound className="w-4 h-4" aria-hidden="true" />{t('Continue as guest')}</Button>
            )}
            {socials.includes('google') && <Button variant="secondary" className="w-full" onClick={() => onSocial('google')} disabled={busy}><span aria-hidden="true" className="font-black">G</span>{t('Continue with Google')}</Button>}
            {socials.includes('facebook') && <Button variant="secondary" className="w-full" onClick={() => onSocial('facebook')} disabled={busy}><FacebookIcon />{t('Continue with Facebook')}</Button>}
            {socials.includes('apple') && <Button variant="secondary" className="w-full" onClick={() => onSocial('apple')} disabled={busy}><Apple className="w-4 h-4" aria-hidden="true" />{t('Continue with Apple')}</Button>}
            {socials.includes('twitter') && <Button variant="secondary" className="w-full" onClick={() => onSocial('twitter')} disabled={busy}><XIcon />{t('Continue with X')}</Button>}

            {flag('phoneLogin') && firebaseConfig && (
              <div className="space-y-2 pt-1">
                {!phone.open ? (
                  <Button variant="ghost" className="w-full" onClick={() => setPhone((p) => ({ ...p, open: true }))}><Phone className="w-4 h-4" aria-hidden="true" />{t('Use phone number')}</Button>
                ) : !phone.sent ? (
                  <>
                    <FormField label={t('Phone number')} type="tel" inputMode="tel" autoComplete="tel" placeholder="+14155550123" value={phone.number} onChange={(e) => setPhone((p) => ({ ...p, number: e.target.value }))} hint={t('International format with country code')} />
                    <Button onClick={sendCode} loading={busy} disabled={!/^\+\d{7,15}$/.test(phone.number.trim())} className="w-full">{t('Send code')}</Button>
                  </>
                ) : (
                  <>
                    <FormField label={t('Verification code')} inputMode="numeric" autoComplete="one-time-code" value={phone.code} onChange={(e) => setPhone((p) => ({ ...p, code: e.target.value }))} data-autofocus />
                    <Button onClick={verifyCode} loading={busy} disabled={phone.code.trim().length < 4} className="w-full">{t('Verify')}</Button>
                  </>
                )}
                <div id="recaptcha-container" />
              </div>
            )}
            {!flag('guestLogin') && socials.length === 0 && !flag('phoneLogin') && (
              <p className="text-sm text-gray-400 text-center">{t('Quick sign-in is disabled. Use your email instead.')}</p>
            )}
          </div>
        )}

        {tab === 'email' && (
          <form onSubmit={onEmailSubmit} className="space-y-4" noValidate>
            <div className="flex gap-4 text-sm">
              {(['login', 'register'] as const).map((m) => (
                <button key={m} type="button" onClick={() => { setMode(m); setError(null); setFields({}); }} aria-pressed={mode === m}
                  className={`font-bold pb-1 border-b-2 ${mode === m ? 'text-white border-[#00E676]' : 'text-gray-500 border-transparent hover:text-gray-300'}`}>
                  {m === 'login' ? t('Sign in') : t('Create account')}
                </button>
              ))}
            </div>

            {mode === 'login' ? (
              <>
                <FormField label={t('Username or email')} autoComplete="username" value={form.identifier} onChange={(e) => setForm({ ...form, identifier: e.target.value })} error={fields.identifier} required data-autofocus />
                <FormField label={t('Password')} type="password" autoComplete="current-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} error={fields.password} required />
              </>
            ) : (
              <>
                <FormField label={t('Username')} autoComplete="username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })}
                  error={fields.username ?? (usernameState === 'invalid' ? t('3-20 letters, numbers or underscores') : usernameState === 'taken' ? t('Username is taken') : undefined)}
                  hint={usernameState === 'ok' ? t('Username is available') : usernameState === 'checking' ? t('Checking…') : undefined} required data-autofocus />
                <FormField label={t('Email')} type="email" autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} error={fields.email} required />
                <FormField label={t('Display name (optional)')} autoComplete="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} error={fields.name} />
                <FormField label={t('Password')} type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} error={fields.password} hint={t('At least 8 characters')} required />
              </>
            )}
            <Button type="submit" loading={busy} className="w-full">{mode === 'login' ? t('Sign in') : t('Create account')}</Button>
          </form>
        )}

        <p className="text-[11px] text-gray-500 text-center leading-relaxed">
          {t('By continuing you agree to our')} <a className="underline hover:text-white" href={settings.get<string>('general', 'termsUrl', '/terms-of-service')}>{t('Terms')}</a> {t('and')} <a className="underline hover:text-white" href={settings.get<string>('general', 'privacyUrl', '/privacy-policy')}>{t('Privacy Policy')}</a>.
        </p>
      </div>
  );
}
