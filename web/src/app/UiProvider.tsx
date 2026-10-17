import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useSession } from '@/features/session/SessionProvider';

export type Overlay = 'auth' | 'shop' | 'vip' | 'filter' | 'drawer' | 'editProfile';

interface UiContextValue {
  isOpen(o: Overlay): boolean;
  open(o: Overlay): void;
  close(o: Overlay): void;
  /** Reason shown in the sign-in dialog ("Sign in to send messages"). */
  authReason: string | undefined;
  openAuth(reason?: string): void;
  /** Runs `fn` now if signed in with a real account, otherwise asks the person to sign in first. */
  requireAuth(fn: () => void, reason?: string, opts?: { allowGuest?: boolean }): void;
}

const Ctx = createContext<UiContextValue | null>(null);

export function UiProvider({ children }: { children: ReactNode }) {
  const { status, user } = useSession();
  const [open, setOpen] = useState<Set<Overlay>>(new Set());
  const [authReason, setAuthReason] = useState<string>();

  const set = useCallback((o: Overlay, on: boolean) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (on) next.add(o); else next.delete(o);
      return next;
    });
  }, []);

  const value = useMemo<UiContextValue>(
    () => ({
      isOpen: (o) => open.has(o),
      open: (o) => set(o, true),
      close: (o) => { set(o, false); if (o === 'auth') setAuthReason(undefined); },
      authReason,
      openAuth: (reason) => { setAuthReason(reason); set('auth', true); },
      requireAuth: (fn, reason, opts) => {
        if (status === 'authenticated' && user && (!user.isGuest || opts?.allowGuest)) return fn();
        setAuthReason(reason ?? (user?.isGuest ? 'Create an account to use this feature' : 'Sign in to continue'));
        set('auth', true);
      },
    }),
    [open, set, authReason, status, user],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useUi(): UiContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useUi must be used inside <UiProvider>');
  return v;
}
