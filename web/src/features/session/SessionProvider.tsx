import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { client, refreshSession, setSessionLostHandler, setUserRefreshedHandler, unwrap } from '@/shared/api/client';
import { sessionStore } from '@/shared/api/session-store';
import type { SelfUser } from '@/shared/api/types';

export type SessionStatus = 'loading' | 'anonymous' | 'authenticated' | 'banned';

export interface Tokens {
  accessToken: string;
  expiresIn: number;
}

interface SessionContextValue {
  status: SessionStatus;
  user: SelfUser | null;
  /** Called by the auth flows once the server has issued tokens. */
  signIn(tokens: Tokens, user: SelfUser): void;
  signOut(): Promise<void>;
  /** Merge fresh values (e.g. new gem balance after a purchase) into the cached user. */
  patchUser(patch: Partial<SelfUser>): void;
  reloadUser(): Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);
export const ME_KEY = ['me'] as const;

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<SessionStatus>(sessionStore.mayHaveSession() ? 'loading' : 'anonymous');
  const [user, setUser] = useState<SelfUser | null>(() => qc.getQueryData<SelfUser>(ME_KEY) ?? null);
  const token = useSyncExternalStore(sessionStore.subscribe, sessionStore.snapshot);

  const applyUser = useCallback(
    (u: SelfUser | null) => {
      setUser(u);
      qc.setQueryData(ME_KEY, u);
    },
    [qc],
  );

  // The API client tells us when the session is gone for good.
  useEffect(() => {
    setSessionLostHandler((reason) => {
      qc.clear();
      setUser(null);
      setStatus(reason === 'account_banned' ? 'banned' : 'anonymous');
    });
    setUserRefreshedHandler((u) => {
      applyUser(u as SelfUser);
      setStatus('authenticated');
    });
  }, [qc, applyUser]);

  // Restore the session after a page load via the httpOnly refresh cookie.
  useEffect(() => {
    if (!sessionStore.mayHaveSession()) return;
    let cancelled = false;
    void refreshSession().then((ok) => {
      if (cancelled) return;
      setStatus((s) => (ok ? 'authenticated' : s === 'banned' ? 'banned' : 'anonymous'));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback<SessionContextValue['signIn']>(
    (t, u) => {
      sessionStore.set(t.accessToken, t.expiresIn);
      applyUser(u);
      setStatus('authenticated');
    },
    [applyUser],
  );

  const signOut = useCallback(async () => {
    try {
      await client.POST('/auth/logout', { body: {} });
    } catch {
      /* local sign-out must always succeed */
    }
    sessionStore.clear();
    qc.clear();
    setUser(null);
    setStatus('anonymous');
  }, [qc]);

  const patchUser = useCallback<SessionContextValue['patchUser']>(
    (patch) => {
      setUser((u) => {
        if (!u) return u;
        const next = { ...u, ...patch };
        qc.setQueryData(ME_KEY, next);
        return next;
      });
    },
    [qc],
  );

  const reloadUser = useCallback(async () => {
    applyUser(await unwrap(client.GET('/auth/me')));
  }, [applyUser]);

  // A cleared token (e.g. by another tab's logout) means we are no longer signed in, whatever we last believed.
  const effectiveStatus: SessionStatus = status === 'authenticated' && !token ? 'anonymous' : status;

  const value = useMemo(() => ({ status: effectiveStatus, user, signIn, signOut, patchUser, reloadUser }), [effectiveStatus, user, signIn, signOut, patchUser, reloadUser]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>');
  return ctx;
}
