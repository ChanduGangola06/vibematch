import { createBrowserRouter, type RouteObject } from 'react-router';
import type React from 'react';
import { AppLayout } from './AppLayout';

const page = (load: () => Promise<{ default: React.ComponentType }>) => ({ lazy: async () => ({ Component: (await load()).default }) });

const named = (load: () => Promise<Record<string, unknown>>, key: string) => ({ lazy: async () => ({ Component: (await load())[key] as React.ComponentType }) });

export const routes: RouteObject[] = [
  { path: '/install', ...page(() => import('@/features/install/InstallPage')) },
  {
    path: '/admin',
    ...page(() => import('@/features/admin/AdminLayout')),
    children: [
      { index: true, ...page(() => import('@/features/admin/Overview')) },
      { path: 'users', ...named(() => import('@/features/admin/Users'), 'default') },
      { path: 'demo-users', ...named(() => import('@/features/admin/Catalog'), 'DemoUsers') },
      { path: 'reports', ...named(() => import('@/features/admin/Moderation'), 'Reports') },
      { path: 'mailbox', ...named(() => import('@/features/admin/Moderation'), 'Mailbox') },
      { path: 'purchases', ...named(() => import('@/features/admin/Operations'), 'Purchases') },
      { path: 'gifts', ...named(() => import('@/features/admin/Catalog'), 'Gifts') },
      { path: 'packs', ...named(() => import('@/features/admin/Catalog'), 'Packs') },
      { path: 'vip-plans', ...named(() => import('@/features/admin/Catalog'), 'VipPlans') },
      { path: 'pages', ...named(() => import('@/features/admin/Catalog'), 'Pages') },
      { path: 'languages', ...page(() => import('@/features/admin/Languages')) },
      { path: 'settings', ...named(() => import('@/features/admin/Settings'), 'SettingsIndex') },
      { path: 'settings/:group', ...named(() => import('@/features/admin/Settings'), 'SettingsGroup') },
      { path: 'api-keys', ...named(() => import('@/features/admin/Operations'), 'ApiKeys') },
      { path: 'security', ...page(() => import('@/features/admin/Security')) },
      { path: 'audit', ...named(() => import('@/features/admin/Operations'), 'AuditLog') },
      { path: 'backup', ...named(() => import('@/features/admin/Operations'), 'Backup') },
    ],
  },
  {
    element: <AppLayout />,
    children: [
      { index: true, ...page(() => import('@/features/matching/HomePage')) },
      { path: 'messages', ...page(() => import('@/features/messages/MessagesPage')) },
      { path: 'history', ...page(() => import('@/features/history/HistoryPage')) },
      { path: 'u/:username', ...page(() => import('@/features/profile/ProfilePage')) },
      { path: 'payment-callback', ...page(() => import('@/features/shop/PaymentCallbackPage')) },
      { path: 'contact', ...page(() => import('@/features/content/ContactPage')) },
      { path: ':slug', ...page(() => import('@/features/content/CmsPage')) },
      { path: '*', ...page(() => import('@/features/content/NotFoundPage')) },
    ],
  },
];

export const createRouter = () => createBrowserRouter(routes);
