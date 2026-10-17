import { useQuery } from '@tanstack/react-query';
import { BarChart3, CreditCard, Flag, Gift, Globe, KeyRound, Mail, Package, ScrollText, Settings, Shield, Users, Crown, FileText, DatabaseBackup, UserRound, ArrowLeft } from 'lucide-react';
import { NavLink, Outlet, Link } from 'react-router';
import { useSession } from '@/features/session/SessionProvider';
import { EmptyState } from '@/shared/ui/EmptyState';
import { PageSpinner } from '@/shared/ui/Spinner';
import { admin } from './adminApi';

const NAV = [
  { to: '/admin', end: true, label: 'Overview', icon: BarChart3 },
  { to: '/admin/users', label: 'Users', icon: Users },
  { to: '/admin/demo-users', label: 'Demo users', icon: UserRound },
  { to: '/admin/reports', label: 'Reports', icon: Flag },
  { to: '/admin/mailbox', label: 'Mailbox', icon: Mail, badge: true },
  { to: '/admin/purchases', label: 'Purchases', icon: CreditCard },
  { to: '/admin/gifts', label: 'Gifts', icon: Gift },
  { to: '/admin/packs', label: 'Gem packs', icon: Package },
  { to: '/admin/vip-plans', label: 'VIP plans', icon: Crown },
  { to: '/admin/pages', label: 'Pages', icon: FileText },
  { to: '/admin/languages', label: 'Languages', icon: Globe },
  { to: '/admin/settings', label: 'Settings', icon: Settings },
  { to: '/admin/api-keys', label: 'API keys', icon: KeyRound },
  { to: '/admin/security', label: 'Security', icon: Shield },
  { to: '/admin/audit', label: 'Audit log', icon: ScrollText },
  { to: '/admin/backup', label: 'Backup', icon: DatabaseBackup },
] as const;

/** Route guard + chrome. The API enforces admin role on every call; this only hides UI from everyone else. */
export default function AdminLayout() {
  const { status, user } = useSession();
  const unread = useQuery({ queryKey: ['admin-unread'], queryFn: () => admin.get<{ count: number }>('/admin/mailbox/unread-count'), enabled: user?.role === 'admin', refetchInterval: 60_000 });
  if (status === 'loading') return <PageSpinner />;
  if (user?.role !== 'admin') return <EmptyState title="Administrators only" text="Sign in with an administrator account to continue." action={<Link to="/" className="underline">Home</Link>} />;
  return (
    <div className="min-h-[100dvh] md:flex">
      <aside className="md:w-56 shrink-0 border-b md:border-b-0 md:border-r border-white/10 p-3">
        <Link to="/" className="flex items-center gap-2 text-sm text-gray-400 hover:text-white mb-3"><ArrowLeft className="w-4 h-4" />Back to site</Link>
        <nav aria-label="Admin" className="flex md:flex-col gap-1 overflow-x-auto">
          {NAV.map(({ to, label, icon: Icon, ...rest }) => (
            <NavLink key={to} to={to} end={'end' in rest} className={({ isActive }) => `flex items-center gap-2 px-3 py-2 rounded-xl text-sm whitespace-nowrap ${isActive ? 'bg-[#00E676] text-black font-bold' : 'text-gray-300 hover:bg-white/10'}`}>
              <Icon className="w-4 h-4" aria-hidden />{label}
              {'badge' in rest && (unread.data?.count ?? 0) > 0 && <span className="ml-auto bg-red-500 text-white text-[10px] rounded-full px-1.5" aria-label={`${unread.data!.count} unread`}>{unread.data!.count}</span>}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div id="admin-main" className="flex-1 min-w-0 p-4 md:p-6"><Outlet /></div>
    </div>
  );
}
