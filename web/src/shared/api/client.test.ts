import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '@/test/server';
import { client, idempotencyHeader, refreshSession, setSessionLostHandler, unwrap, unwrapPage } from './client';
import { ApiError, errorMessage, isApiError } from './errors';
import { sessionStore } from './session-store';

const API = `${location.origin}/api/v1`;
const ok = (data: unknown, init: ResponseInit = {}) => HttpResponse.json({ data, meta: { requestId: 'r1' } }, init);
const problem = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  HttpResponse.json({ type: `https://docs/${code}`, title: code, status, code, detail: `detail ${code}`, requestId: 'req-1', ...extra }, { status, headers: { 'content-type': 'application/problem+json' } });
const refreshOk = (token: string) => ok({ tokens: { accessToken: token, tokenType: 'Bearer', expiresIn: 900 }, user: { id: 'u1' } });

describe('api client', () => {
  beforeEach(() => {
    sessionStore.clear();
    setSessionLostHandler(() => {});
  });

  it('unwraps the success envelope and sends the web-client headers', async () => {
    let seen: Headers | undefined;
    server.use(http.get(`${API}/discover`, ({ request }) => { seen = request.headers; return ok([{ id: 'a' }]); }));
    const data = await unwrap(client.GET('/discover'));
    expect(data).toEqual([{ id: 'a' }]);
    expect(seen?.get('x-client-type')).toBe('web');
    expect(seen?.get('accept-version')).toBe('1');
    expect(seen?.get('authorization')).toBeNull(); // anonymous
  });

  it('attaches the bearer token and returns undefined for 204', async () => {
    sessionStore.set('tok-1', 900);
    let auth: string | null = null;
    server.use(http.post(`${API}/users/:id/views`, ({ request }) => { auth = request.headers.get('authorization'); return new HttpResponse(null, { status: 204 }); }));
    expect(await unwrap(client.POST('/users/{id}/views', { params: { path: { id: 'u2' } } }))).toBeUndefined();
    expect(auth).toBe('Bearer tok-1');
  });

  it('turns problem+json into ApiError with code, detail, request id and field errors', async () => {
    server.use(http.post(`${API}/auth/register`, () => problem(422, 'validation_failed', { errors: [{ path: 'username', message: 'Username is reserved' }, { path: 'password', message: 'Too common' }] })));
    const err = (await unwrap(client.POST('/auth/register', { body: { username: 'admin', email: 'a@b.co', password: 'x' } })).catch((e: unknown) => e)) as ApiError;
    expect(isApiError(err)).toBe(true);
    expect(err).toMatchObject({ status: 422, code: 'validation_failed', requestId: 'req-1', fieldErrors: { username: 'Username is reserved', password: 'Too common' } });
    expect(err.is('validation_failed')).toBe(true);
    expect(errorMessage(err)).toBe('Username is reserved');
    expect(errorMessage(new ApiError(409, { code: 'username_taken', detail: 'taken' }))).toBe('taken');
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage(null, 'fallback')).toBe('fallback');
  });

  it('maps network failures to a friendly ApiError instead of leaking TypeError', async () => {
    server.use(http.get(`${API}/discover`, () => HttpResponse.error()));
    const err = (await unwrap(client.GET('/discover')).catch((e: unknown) => e)) as ApiError;
    expect(err).toMatchObject({ status: 0, code: 'network_error' });
    expect(err.detail).toMatch(/connection/i);
  });

  it('unwrapPage returns items with page metadata', async () => {
    server.use(http.get(`${API}/notifications`, () => HttpResponse.json({ data: [{ id: 'n1' }], page: { limit: 20, hasMore: true, nextCursor: 'c1' }, meta: { requestId: 'r' } })));
    const page = await unwrapPage(client.GET('/notifications'));
    expect(page.items).toEqual([{ id: 'n1' }]);
    expect(page.page).toEqual({ limit: 20, hasMore: true, nextCursor: 'c1' });
  });

  describe('token refresh', () => {
    it('refreshes once on an expired token and replays the original request with the new token', async () => {
      sessionStore.set('old', 900);
      const calls: string[] = [];
      server.use(
        http.get(`${API}/auth/me`, ({ request }) => {
          const t = request.headers.get('authorization');
          calls.push(`me:${t}`);
          return t === 'Bearer new' ? ok({ id: 'u1' }) : problem(401, 'token_expired');
        }),
        http.post(`${API}/auth/refresh`, () => { calls.push('refresh'); return refreshOk('new'); }),
      );
      expect(await unwrap(client.GET('/auth/me'))).toEqual({ id: 'u1' });
      expect(calls).toEqual(['me:Bearer old', 'refresh', 'me:Bearer new']);
      expect(sessionStore.getToken()).toBe('new');
    });

    it('SINGLE-FLIGHT: five parallel requests that hit 401 trigger exactly one refresh', async () => {
      sessionStore.set('old', 900);
      let refreshes = 0;
      server.use(
        http.get(`${API}/auth/me`, ({ request }) => (request.headers.get('authorization') === 'Bearer new' ? ok({ id: 'u1' }) : problem(401, 'token_expired'))),
        http.post(`${API}/auth/refresh`, async () => { refreshes++; await new Promise((r) => setTimeout(r, 30)); return refreshOk('new'); }),
      );
      const results = await Promise.all(Array.from({ length: 5 }, () => unwrap(client.GET('/auth/me'))));
      expect(results).toHaveLength(5);
      expect(refreshes).toBe(1); // refresh tokens are single-use: a second parallel refresh would revoke the session
    });

    it('replays a payment with the SAME Idempotency-Key and body', async () => {
      sessionStore.set('old', 900);
      const seen: { key: string | null; auth: string | null; body: unknown }[] = [];
      server.use(
        http.post(`${API}/gifts/:id/send`, async ({ request }) => {
          seen.push({ key: request.headers.get('idempotency-key'), auth: request.headers.get('authorization'), body: await request.json() });
          return request.headers.get('authorization') === 'Bearer new' ? ok({ balance: 5 }, { status: 201 }) : problem(401, 'token_expired');
        }),
        http.post(`${API}/auth/refresh`, () => refreshOk('new')),
      );
      await unwrap(client.POST('/gifts/{giftId}/send', { params: { path: { giftId: 'g1' }, header: idempotencyHeader() }, body: { receiverId: 'u2' } }));
      expect(seen).toHaveLength(2);
      expect(seen[0]!.key).toMatch(/^[\w-]{8,}$/);
      expect(seen[1]!.key).toBe(seen[0]!.key);
      expect(seen[1]!.body).toEqual({ receiverId: 'u2' });
      expect(seen.map((s) => s.auth)).toEqual(['Bearer old', 'Bearer new']);
    });

    it('a failed refresh clears the session, reports why, and surfaces the original 401', async () => {
      sessionStore.set('old', 900);
      const lost = vi.fn();
      setSessionLostHandler(lost);
      server.use(
        http.get(`${API}/auth/me`, () => problem(401, 'token_expired')),
        http.post(`${API}/auth/refresh`, () => problem(401, 'refresh_token_reuse')),
      );
      const err = (await unwrap(client.GET('/auth/me')).catch((e: unknown) => e)) as ApiError;
      expect(err).toMatchObject({ status: 401 });
      expect(sessionStore.getToken()).toBeNull();
      expect(lost).toHaveBeenCalledWith('refresh_token_reuse');
    });

    it('a revoked session or banned account ends the session without a refresh attempt', async () => {
      for (const code of ['session_revoked', 'account_banned']) {
        sessionStore.set('tok', 900);
        const lost = vi.fn();
        setSessionLostHandler(lost);
        let refreshed = false;
        server.use(http.get(`${API}/auth/me`, () => problem(code === 'account_banned' ? 403 : 401, code)), http.post(`${API}/auth/refresh`, () => { refreshed = true; return refreshOk('x'); }));
        await unwrap(client.GET('/auth/me')).catch(() => {});
        if (code === 'session_revoked') { expect(lost).toHaveBeenCalledWith(code); expect(sessionStore.getToken()).toBeNull(); expect(refreshed).toBe(false); }
      }
    });

    it('refreshes proactively when the token is about to expire', async () => {
      sessionStore.set('almost-dead', 5);
      const order: string[] = [];
      server.use(
        http.post(`${API}/auth/refresh`, () => { order.push('refresh'); return refreshOk('fresh'); }),
        http.get(`${API}/auth/me`, ({ request }) => { order.push(request.headers.get('authorization')!); return ok({ id: 'u1' }); }),
      );
      await unwrap(client.GET('/auth/me'));
      expect(order).toEqual(['refresh', 'Bearer fresh']);
    });

    it('auth endpoints never trigger a refresh loop', async () => {
      sessionStore.set('tok', 900);
      let refreshes = 0;
      server.use(http.post(`${API}/auth/login`, () => problem(401, 'invalid_credentials')), http.post(`${API}/auth/refresh`, () => { refreshes++; return refreshOk('x'); }));
      const err = (await unwrap(client.POST('/auth/login', { body: { identifier: 'a', password: 'b' } })).catch((e: unknown) => e)) as ApiError;
      expect(err.code).toBe('invalid_credentials');
      expect(refreshes).toBe(0);
    });

    it('refreshSession keeps the session when offline', async () => {
      sessionStore.set('tok', 900);
      server.use(http.post(`${API}/auth/refresh`, () => HttpResponse.error()));
      expect(await refreshSession()).toBe(false);
      expect(sessionStore.getToken()).toBe('tok');
    });
  });

  describe('session store', () => {
    it('keeps the token in memory only and notifies subscribers', () => {
      const fn = vi.fn();
      const off = sessionStore.subscribe(fn);
      sessionStore.set('secret-token', 60);
      expect(fn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify({ ...localStorage })).not.toContain('secret-token');
      expect(JSON.stringify({ ...sessionStorage })).not.toContain('secret-token');
      expect(sessionStore.mayHaveSession()).toBe(true);
      expect(sessionStore.secondsLeft()).toBeGreaterThan(55);
      sessionStore.clear();
      expect(sessionStore.getToken()).toBeNull();
      expect(sessionStore.mayHaveSession()).toBe(false);
      off();
      sessionStore.set('x', 1);
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });
});
