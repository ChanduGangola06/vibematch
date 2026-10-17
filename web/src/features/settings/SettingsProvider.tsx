import { useQuery } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { client, unwrap } from '@/shared/api/client';
import type { PublicSettings } from '@/shared/api/types';

type Group = Record<string, unknown>;
const CACHE_KEY = 'vm_public_settings';

const readCache = (): PublicSettings | undefined => {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as PublicSettings) : undefined;
  } catch {
    return undefined;
  }
};

export interface SiteSettings {
  raw: PublicSettings | undefined;
  loading: boolean;
  siteName: string;
  logoUrl: string;
  /** Typed accessors over the loosely typed settings groups. */
  get<T = unknown>(group: keyof PublicSettings, key: string, fallback?: T): T;
}

const Ctx = createContext<SiteSettings | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const q = useQuery({
    queryKey: ['settings'],
    queryFn: () => unwrap(client.GET('/settings/public')),
    staleTime: 60_000,
    // Branding appears instantly from the last visit while fresh values load.
    initialData: readCache,
    initialDataUpdatedAt: 0,
  });

  useEffect(() => {
    if (!q.data) return;
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(q.data)); } catch { /* private mode */ }
  }, [q.data]);

  const value = useMemo<SiteSettings>(() => {
    const raw = q.data;
    const general = (raw?.general ?? {}) as Group;
    const seo = (raw?.seo ?? {}) as Group;
    return {
      raw,
      loading: q.isLoading,
      siteName: String(general.siteName ?? 'VibeMatch'),
      logoUrl: String(general.logoUrl ?? '/images/logo.png'),
      get: <T,>(group: keyof PublicSettings, key: string, fallback?: T) => {
        const g = (raw?.[group] ?? {}) as Group;
        return (g[key] ?? fallback) as T;
      },
      ...(seo ? {} : {}),
    };
  }, [q.data, q.isLoading]);

  // document title + favicon follow the admin settings
  useEffect(() => {
    const seo = (q.data?.seo ?? {}) as Group;
    document.title = String(seo.seoTitle || value.siteName);
    const favicon = String(((q.data?.general ?? {}) as Group).faviconUrl ?? '');
    if (favicon) {
      let link = document.querySelector<HTMLLinkElement>("link[rel~='icon']");
      if (!link) {
        link = document.createElement('link');
        link.rel = 'icon';
        document.head.appendChild(link);
      }
      link.href = favicon.length <= 2 ? `data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">${favicon}</text></svg>` : favicon;
    }
  }, [q.data, value.siteName]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSiteSettings(): SiteSettings {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSiteSettings must be used inside <SettingsProvider>');
  return v;
}
