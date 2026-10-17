import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Crown, Heart, MessageCircle, UserCheck, UserPlus } from 'lucide-react';
import { useEffect } from 'react';
import toast from 'react-hot-toast';
import { Link, useNavigate, useParams } from 'react-router';
import { useUi } from '@/app/UiProvider';
import { useSession } from '@/features/session/SessionProvider';
import { client, unwrap } from '@/shared/api/client';
import { errorMessage, isApiError } from '@/shared/api/errors';
import { useT } from '@/shared/i18n/I18nProvider';
import { Avatar } from '@/shared/ui/Avatar';
import { Button } from '@/shared/ui/Button';
import { EmptyState } from '@/shared/ui/EmptyState';
import { PageSpinner } from '@/shared/ui/Spinner';

export default function ProfilePage() {
  const t = useT();
  const ui = useUi();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { username = '' } = useParams();
  const { user: me, status } = useSession();
  const key = ['profile', username];
  const q = useQuery({ queryKey: key, queryFn: () => unwrap(client.GET('/users/by-username/{username}', { params: { path: { username } } })), retry: false });
  const p = q.data;
  const isMe = Boolean(p && me && p.id === me.id);

  // count the visit once per signed-in viewer
  useEffect(() => {
    if (p && status === 'authenticated' && !isMe && !me?.isGuest) void client.POST('/users/{id}/views', { params: { path: { id: p.id } } });
  }, [p?.id, status, isMe, me?.isGuest]); // eslint-disable-line react-hooks/exhaustive-deps

  if (q.isPending) return <PageSpinner />;
  if (!p) {
    const gone = isApiError(q.error) && q.error.status === 404;
    return <EmptyState title={gone ? t('User not found') : t('Could not load the profile')} text={gone ? t('This profile does not exist or was removed.') : errorMessage(q.error)} />;
  }

  const toggleFollow = () => ui.requireAuth(async () => {
    try {
      const r = p.isFollowing
        ? await unwrap(client.DELETE('/users/{id}/follow', { params: { path: { id: p.id } } }))
        : await unwrap(client.PUT('/users/{id}/follow', { params: { path: { id: p.id } } }));
      qc.setQueryData(key, { ...p, isFollowing: r.isFollowing, followersCount: r.followersCount });
    } catch (e) { toast.error(errorMessage(e, t('Action failed'))); }
  }, t('Sign in to follow people'));

  return (
    <div className="max-w-xl mx-auto px-4 py-10">
      <div className="flex flex-col items-center text-center gap-2">
        <Avatar src={p.avatar} name={p.name} className="w-28 h-28" />
        <h1 className="text-2xl font-bold">{p.name}{p.isVip && <Crown className="inline w-5 h-5 text-yellow-400 ml-1.5" aria-label="VIP" />}</h1>
        <p className="text-gray-400">@{p.username}{p.country ? ` · ${p.country}` : ''}{p.age ? ` · ${p.age}` : ''}</p>
        {p.isOnline && <span className="text-xs text-[#00E676]">● {t('Online')}</span>}
        {p.bio && <p className="mt-2 text-gray-300 max-w-md break-words">{p.bio}</p>}
        <dl className="flex gap-6 mt-3 text-sm">
          <div><dt className="text-gray-500">{t('Followers')}</dt><dd className="font-bold">{p.followersCount}</dd></div>
          <div><dt className="text-gray-500">{t('Following')}</dt><dd className="font-bold">{p.followingCount}</dd></div>
          <div><dt className="text-gray-500 flex items-center gap-1"><Heart className="w-3 h-3" />{t('Likes')}</dt><dd className="font-bold">{p.likesCount}</dd></div>
        </dl>
        <div className="flex gap-2 mt-4">
          {isMe ? <Button onClick={() => ui.open('editProfile')}>{t('Edit profile')}</Button> : (
            <>
              <Button variant={p.isFollowing ? 'secondary' : 'primary'} onClick={toggleFollow}>{p.isFollowing ? <UserCheck className="w-4 h-4" /> : <UserPlus className="w-4 h-4" />}{p.isFollowing ? t('Unfollow') : t('Follow')}</Button>
              <Button variant="secondary" onClick={() => ui.requireAuth(() => nav(`/messages?chat=${p.id}`), t('Sign in to send messages'))}><MessageCircle className="w-4 h-4" />{t('Message')}</Button>
            </>
          )}
        </div>
        <Link to="/" className="text-sm text-gray-500 mt-6 hover:text-white">{t('Back to home')}</Link>
      </div>
    </div>
  );
}
