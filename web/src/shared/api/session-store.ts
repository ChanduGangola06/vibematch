/**
 * In-memory access token.
 * It is deliberately NOT written to localStorage/sessionStorage: a token that page scripts cannot read
 * cannot be stolen by XSS. After a reload the session is restored with the httpOnly refresh cookie.
 */
interface State {
  accessToken: string | null;
  expiresAt: number;
}

let state: State = { accessToken: null, expiresAt: 0 };
const listeners = new Set<() => void>();
const HINT_KEY = 'vm_has_session';

const emit = () => listeners.forEach((l) => l());

export const sessionStore = {
  getToken: (): string | null => state.accessToken,
  /** Seconds until the access token expires (negative = already expired). */
  secondsLeft: (): number => Math.round((state.expiresAt - Date.now()) / 1000),
  set(accessToken: string, expiresInSeconds: number): void {
    state = { accessToken, expiresAt: Date.now() + expiresInSeconds * 1000 };
    try { localStorage.setItem(HINT_KEY, '1'); } catch { /* private mode */ }
    emit();
  },
  clear(): void {
    state = { accessToken: null, expiresAt: 0 };
    try { localStorage.removeItem(HINT_KEY); } catch { /* private mode */ }
    emit();
  },
  /** A non-secret hint that a refresh cookie probably exists, so a visitor who never logged in makes no refresh call. */
  mayHaveSession(): boolean {
    try { return localStorage.getItem(HINT_KEY) === '1'; } catch { return false; }
  },
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  snapshot: (): string | null => state.accessToken,
};
