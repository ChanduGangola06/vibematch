import { Crown, History, LogOut, MessageCircle, Pencil, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import toast from 'react-hot-toast';
import { Link, useNavigate } from 'react-router';
import { useUi } from '@/app/UiProvider';
import { useSession } from '@/features/session/SessionProvider';
import { client, unwrap } from '@/shared/api/client';
import { errorMessage } from '@/shared/api/errors';
import { useT } from '@/shared/i18n/I18nProvider';
import { Avatar } from '@/shared/ui/Avatar';
import { Button } from '@/shared/ui/Button';
import { GemIcon } from '@/shared/ui/GemIcon';
import { Modal } from '@/shared/ui/Modal';

export function ProfileDrawer({ open, onClose }: { open: boolean; onClose(): void }) {
  const t = useT();
  const ui = useUi();
  const nav = useNavigate();
  const { user, signOut } = useSession();
  const [deleting, setDeleting] = useState(false);
  if (!user) return null;
  const go = (fn: () => void) => () => { onClose(); fn(); };
  const row = 'flex items-center gap-3 w-full px-3 py-3 rounded-xl hover:bg-white/10 text-left';

  return (
    <>
      <Modal open={open && !deleting} onClose={onClose} title={t('Profile')} hideTitle size="sm">
        <div className="flex items-center gap-3 mb-4">
          <Avatar src={user.avatar} name={user.name} className="w-14 h-14" />
          <div className="min-w-0">
            <b className="block truncate">{user.name}{user.isVip && <Crown className="inline w-4 h-4 text-yellow-400 ml-1" aria-label="VIP" />}</b>
            <span className="text-sm text-gray-400">@{user.username}</span>
            <span className="flex items-center gap-1 text-sm"><GemIcon className="w-3.5 h-3.5" />{user.gems.toLocaleString()}</span>
          </div>
        </div>
        <nav className="space-y-1">
          {!user.isGuest && <Link to={`/u/${user.username}`} onClick={onClose} className={row}>{t('My profile')}</Link>}
          <button className={row} onClick={go(() => ui.open('editProfile'))}><Pencil className="w-4 h-4" />{t('Edit profile')}</button>
          <button className={row} onClick={go(() => ui.open('shop'))}><GemIcon className="w-4 h-4" />{t('Get gems')}</button>
          <button className={row} onClick={go(() => ui.open('vip'))}><Crown className="w-4 h-4" />{t('Go VIP')}</button>
          <Link to="/messages" onClick={onClose} className={row}><MessageCircle className="w-4 h-4" />{t('Messages')}</Link>
          <Link to="/history" onClick={onClose} className={row}><History className="w-4 h-4" />{t('History')}</Link>
          {user.role === 'admin' && <Link to="/admin" onClick={onClose} className={row}>{t('Admin')}</Link>}
          <button className={row} onClick={go(() => { void signOut().then(() => nav('/')); })}><LogOut className="w-4 h-4" />{t('Sign out')}</button>
          {!user.isGuest && <button className={`${row} text-red-400`} onClick={() => setDeleting(true)}><Trash2 className="w-4 h-4" />{t('Delete account')}</button>}
        </nav>
        <button onClick={onClose} className="sr-only"><X />{t('Close')}</button>
      </Modal>
      <DeleteAccount open={open && deleting} onCancel={() => setDeleting(false)} onDone={() => { setDeleting(false); onClose(); }} />
    </>
  );
}

function DeleteAccount({ open, onCancel, onDone }: { open: boolean; onCancel(): void; onDone(): void }) {
  const t = useT();
  const nav = useNavigate();
  const { signOut } = useSession();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await unwrap(client.POST('/users/me/delete', { body: { password } }));
      toast.success(t('Your account was deleted'));
      await signOut();
      onDone();
      nav('/');
    } catch (e) {
      toast.error(errorMessage(e, t('Could not delete the account')));
    } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onCancel} title={t('Delete account')} size="sm" locked={busy}>
      <p className="text-sm text-gray-400 mb-3">{t('This is permanent. Enter your password to confirm.')}</p>
      <input type="password" autoComplete="current-password" aria-label={t('Password')} value={password} onChange={(e) => setPassword(e.target.value)} className="w-full bg-gray-900 rounded-xl px-4 py-3 border border-gray-800 mb-3" />
      <div className="flex gap-2"><Button variant="secondary" className="flex-1" onClick={onCancel}>{t('Cancel')}</Button><Button variant="danger" className="flex-1" loading={busy} disabled={!password} onClick={submit}>{t('Delete')}</Button></div>
    </Modal>
  );
}
