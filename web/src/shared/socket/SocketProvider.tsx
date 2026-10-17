import { useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { io, type Socket } from 'socket.io-client';
import { useSession } from '@/features/session/SessionProvider';
import { refreshSession } from '@/shared/api/client';
import { sessionStore } from '@/shared/api/session-store';

export type SocketFactory = (auth: (cb: (data: { token: string | null }) => void) => void) => Socket;

const defaultFactory: SocketFactory = (auth) =>
  io(globalThis.location?.origin ?? '', { path: '/socket.io', auth, transports: ['websocket', 'polling'], autoConnect: false, reconnectionDelayMax: 8000 });

interface SocketCtx {
  socket: Socket | null;
  connected: boolean;
}
const Ctx = createContext<SocketCtx>({ socket: null, connected: false });

/**
 * One socket per signed-in session. The access token is supplied through the `auth` callback, so every
 * (re)connection uses the *current* token; an expired one is refreshed once and the connection retried.
 */
export function SocketProvider({ children, factory = defaultFactory }: { children: ReactNode; factory?: SocketFactory }) {
  const { status } = useSession();
  const qc = useQueryClient();
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const refreshing = useRef(false);

  useEffect(() => {
    if (status !== 'authenticated') return;
    const s = factory((cb) => cb({ token: sessionStore.getToken() }));
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    const onError = (err: Error & { data?: { code?: string } }) => {
      const code = err.data?.code;
      if ((code === 'token_expired' || code === 'token_invalid') && !refreshing.current) {
        refreshing.current = true;
        void refreshSession().then((ok) => { refreshing.current = false; if (ok) s.connect(); });
      }
    };
    const onCount = (n: number) => qc.setQueryData(['online'], n);
    s.on('connect', onConnect);
    s.on('disconnect', onDisconnect);
    s.on('connect_error', onError);
    s.on('online_users_count', onCount);
    s.connect();
    setSocket(s);
    return () => {
      s.off('connect', onConnect); s.off('disconnect', onDisconnect); s.off('connect_error', onError); s.off('online_users_count', onCount);
      s.disconnect();
      setSocket(null);
      setConnected(false);
    };
  }, [status, factory, qc]);

  const value = useMemo(() => ({ socket, connected }), [socket, connected]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useSocket = (): SocketCtx => useContext(Ctx);

/** Emit with an acknowledgement and a timeout; rejects with the server's error object. */
export function emitAck<T = Record<string, unknown>>(socket: Socket, event: string, payload?: unknown, timeoutMs = 8000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The server did not respond')), timeoutMs);
    socket.emit(event, payload ?? {}, (res: { ok: boolean; error?: { code: string; message: string } } & T) => {
      clearTimeout(timer);
      if (res?.ok) resolve(res);
      else reject(Object.assign(new Error(res?.error?.message ?? 'Request failed'), { code: res?.error?.code ?? 'error' }));
    });
  });
}
