import createClient from 'openapi-fetch';
import { ApiError, networkError, type Problem } from './errors';
import type { paths } from './schema';
import { sessionStore } from './session-store';

export const API_PREFIX = '/api/v1';
const baseUrl = () => `${globalThis.location?.origin ?? 'http://localhost'}${API_PREFIX}`;

/** Paths that must carry an Idempotency-Key (money / one-shot actions) or benefit from one on retry. */
const IDEMPOTENT: RegExp[] = [
  /^\/gifts\/[^/]+\/send$/,
  /^\/vip-plans\/[^/]+\/subscribe$/,
  /^\/conversations\/[^/]+\/messages$/,
  /^\/payments\/[^/]+\/verify$/,
];
/** Calls that never trigger (or depend on) a token refresh. */
const AUTH_PATHS = /\/auth\/(login|register|guest|social|refresh|token|logout|webauthn)/;

export const newIdempotencyKey = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`).replace(/[^\w-]/g, '');

let onSessionLost: (reason: string) => void = () => {};
/** The session provider registers here to learn when a refresh failed for good (banned, revoked, expired). */
export const setSessionLostHandler = (fn: (reason: string) => void) => { onSessionLost = fn; };

let onUserRefreshed: (user: unknown) => void = () => {};
export const setUserRefreshedHandler = (fn: (user: unknown) => void) => { onUserRefreshed = fn; };

// ---- single-flight token refresh ----------------------------------------------------------------------
let inflight: Promise<boolean> | null = null;

/**
 * Rotates the refresh token. Concurrent callers share ONE request — refresh tokens are single-use, so a
 * second parallel refresh would look like theft and close the session.
 */
export function refreshSession(): Promise<boolean> {
  inflight ??= (async () => {
    try {
      const res = await fetch(`${baseUrl()}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Client-Type': 'web', 'Accept-Version': '1' },
        body: '{}',
        credentials: 'same-origin',
      });
      if (!res.ok) {
        const problem = (await res.json().catch(() => ({}))) as Problem;
        sessionStore.clear();
        onSessionLost(problem.code ?? 'session_expired');
        return false;
      }
      const body = (await res.json()) as { data: { tokens: { accessToken: string; expiresIn: number }; user: unknown } };
      sessionStore.set(body.data.tokens.accessToken, body.data.tokens.expiresIn);
      onUserRefreshed(body.data.user);
      return true;
    } catch {
      return false; // offline: keep the session, the caller will see a network error
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

const TOKEN_PROBLEMS = new Set(['token_expired', 'token_invalid']);

/**
 * fetch wrapper used by openapi-fetch: attaches the token and, on an expired-token 401, refreshes once and
 * replays the identical request (same body, same Idempotency-Key, so a replayed payment cannot double-charge).
 */
async function authedFetch(input: Request): Promise<Response> {
  const path = new URL(input.url).pathname.replace(API_PREFIX, '');
  const headers = new Headers(input.headers);
  headers.set('X-Client-Type', 'web');
  headers.set('Accept-Version', '1');
  if (input.method === 'POST' && IDEMPOTENT.some((r) => r.test(path)) && !headers.has('Idempotency-Key')) headers.set('Idempotency-Key', newIdempotencyKey());

  // Buffer the body once: a Request body can only be read a single time, and a replay after a token
  // refresh must send exactly the same bytes (same Idempotency-Key, same payload).
  const body = input.method === 'GET' || input.method === 'HEAD' ? undefined : await input.clone().arrayBuffer();
  const build = (token: string | null) => {
    const h = new Headers(headers);
    if (token && !AUTH_PATHS.test(path)) h.set('Authorization', `Bearer ${token}`);
    return new Request(input.url, { method: input.method, headers: h, ...(body && body.byteLength ? { body } : {}), credentials: input.credentials, signal: input.signal });
  };

  // proactively refresh when the token is about to expire
  if (!AUTH_PATHS.test(path) && sessionStore.getToken() && sessionStore.secondsLeft() < 10) await refreshSession();

  let res = await fetch(build(sessionStore.getToken()));
  if (res.status === 401 && !AUTH_PATHS.test(path) && (sessionStore.getToken() || sessionStore.mayHaveSession())) {
    const problem = (await res.clone().json().catch(() => ({}))) as Problem;
    if (!problem.code || TOKEN_PROBLEMS.has(problem.code) || problem.code === 'unauthorized') {
      if (await refreshSession()) res = await fetch(build(sessionStore.getToken()));
    } else if (problem.code === 'session_revoked' || problem.code === 'account_banned') {
      sessionStore.clear();
      onSessionLost(problem.code);
    }
  }
  if (res.status === 403 && !path.startsWith('/auth/login')) {
    const problem = (await res.clone().json().catch(() => ({}))) as Problem;
    if (problem.code === 'account_banned') {
      sessionStore.clear();
      onSessionLost('account_banned');
    }
  }
  return res;
}

export const client = createClient<paths>({
  baseUrl: baseUrl(),
  fetch: async (req) => {
    try {
      return await authedFetch(req);
    } catch (e) {
      throw networkError(e);
    }
  },
});

// ---- unwrapping helpers: turn `{ data, error, response }` into values or ApiError ----------------------
interface Envelope<T> { data: T; page?: PageMeta; meta?: { requestId: string } }
export type PageMeta =
  | { limit: number; hasMore: boolean; nextCursor: string | null }
  | { page: number; pageSize: number; total: number; totalPages: number };

type Result = { data?: unknown; error?: unknown; response: Response };

function throwIfError(r: Result): void {
  if (r.response.ok) return;
  const problem = (typeof r.error === 'object' && r.error !== null ? r.error : {}) as Problem;
  throw new ApiError(r.response.status, problem);
}

/** The `data` member of the success body. Only the success branch of openapi-fetch's result union matches `{ data: … }`. */
type Payload<R> = R extends { data: infer B } ? (B extends { data: infer D } ? D : unknown) : never;

/** Payload of a successful call (`undefined` for 204). */
export async function unwrap<R extends Result>(p: Promise<R>): Promise<Payload<R>> {
  const r = await p;
  throwIfError(r);
  return (r.data as Envelope<never> | undefined)?.data as Payload<R>;
}

/** Payload plus pagination metadata. */
export async function unwrapPage<T>(p: Promise<Result>): Promise<{ items: T[]; page: PageMeta }> {
  const r = await p;
  throwIfError(r);
  const body = r.data as Envelope<T[]>;
  return { items: body.data, page: body.page as PageMeta };
}

/** Plain JSON helper for routes whose bodies are not in the typed client (OAuth2 form posts, NDJSON …). */
export async function rawFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return authedFetch(new Request(`${baseUrl()}${path}`, init));
}

/** Header param for operations whose OpenAPI type requires an Idempotency-Key. Keep one key per user *intent*. */
export const idempotencyHeader = (key: string = newIdempotencyKey()) => ({ 'Idempotency-Key': key });
