import { useQuery } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { client, unwrap } from '@/shared/api/client';
import type { Language } from '@/shared/api/types';

const LANG_KEY = 'vm_lang';
const DEFAULT_LANG = 'en';

interface I18n {
  languages: Language[];
  current: Language | undefined;
  lang: string;
  rtl: boolean;
  setLang(code: string): void;
  /** Translate an English source string; unknown keys fall back to the key itself. */
  t(key: string, vars?: Record<string, string | number>): string;
}

const Ctx = createContext<I18n | null>(null);

const readLang = () => {
  try { return localStorage.getItem(LANG_KEY) ?? DEFAULT_LANG; } catch { return DEFAULT_LANG; }
};

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState(readLang);
  const list = useQuery({ queryKey: ['languages'], queryFn: () => unwrap(client.GET('/languages')), staleTime: 5 * 60_000 });
  const languages = useMemo(() => list.data ?? [], [list.data]);
  const active = languages.some((l) => l.code === lang) ? lang : languages.some((l) => l.code === DEFAULT_LANG) ? DEFAULT_LANG : (languages[0]?.code ?? DEFAULT_LANG);

  const pack = useQuery({
    queryKey: ['language', active],
    queryFn: () => unwrap(client.GET('/languages/{code}', { params: { path: { code: active } } })),
    enabled: languages.length > 0,
    staleTime: 5 * 60_000,
  });

  const current = pack.data ?? languages.find((l) => l.code === active);
  const rtl = Boolean(current?.rtl);
  const translations = pack.data?.translations;

  useEffect(() => {
    document.documentElement.dir = rtl ? 'rtl' : 'ltr';
    document.documentElement.lang = active;
  }, [rtl, active]);

  const setLang = useCallback((code: string) => {
    setLangState(code);
    try { localStorage.setItem(LANG_KEY, code); } catch { /* private mode */ }
  }, []);

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => {
      let out = translations?.[key] ?? key;
      if (vars) for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, String(v));
      return out;
    },
    [translations],
  );

  const value = useMemo<I18n>(() => ({ languages, current, lang: active, rtl, setLang, t }), [languages, current, active, rtl, setLang, t]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18n {
  const v = useContext(Ctx);
  if (!v) throw new Error('useI18n must be used inside <I18nProvider>');
  return v;
}

export const useT = () => useI18n().t;

/** `/images/flags/xx.svg` for a language, tolerant of the legacy `flag` formats. */
export function flagUrl(lang: Pick<Language, 'flag' | 'code'>): string {
  const map: Record<string, string> = { en: 'us', ar: 'sa', hi: 'in' };
  if (lang.flag?.includes('.')) return lang.flag.startsWith('/') ? lang.flag : `/images/flags/${lang.flag}`;
  return `/images/flags/${map[lang.code] ?? lang.code}.svg`;
}
