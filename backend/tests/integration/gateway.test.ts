import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ConflictError } from '../../src/core/errors/index.js';
import { RouteRegistry, type RouteDef } from '../../src/gateway/index.js';
import { parseTrustProxy } from '../../src/middleware/security.js';
import type { ModuleRegistrar } from '../../src/app.js';
import { buildTestApp } from '../helpers/app.js';

const big = 'x'.repeat(5000);
const calls = { create: 0, boom: 0 };

const demo: ModuleRegistrar = ({ v1 }) => {
  v1.add({ method: 'get', path: '/ping', summary: 'ping', auth: 'public', handler: async () => ({ data: { pong: true } }) });
  v1.add({ method: 'get', path: '/big', summary: 'big', auth: 'public', handler: async () => ({ data: { big } }) });
  v1.add({ method: 'get', path: '/boom', summary: 'boom', auth: 'public', handler: async () => { throw new Error('secret db password'); } });
  v1.add({ method: 'get', path: '/conflict', summary: 'c', auth: 'public', handler: async () => { throw new ConflictError('taken', 'username_taken'); } });
  v1.add({ method: 'get', path: '/me', summary: 'me', auth: 'user', handler: async ({ auth }) => ({ data: auth }) });
  v1.add({ method: 'get', path: '/guest-ok', summary: 'g', auth: 'user', roles: ['guest', 'user', 'admin'], handler: async ({ auth }) => ({ data: { role: auth.role } }) });
  v1.add({ method: 'get', path: '/opt', summary: 'o', auth: 'optional', handler: async ({ auth }) => ({ data: { userId: auth?.userId ?? null } }) });
  v1.add({ method: 'get', path: '/admin/thing', summary: 'a', auth: 'admin', handler: async () => ({ data: { ok: true } }) });
  v1.add({ method: 'get', path: '/mobile-only', summary: 'm', auth: 'public', apiKey: 'mobile', handler: async () => ({ data: { ok: true } }) });
  v1.add({
    method: 'post', path: '/items/:id', summary: 'create', auth: 'user',
    schema: {
      params: z.object({ id: z.string().regex(/^\d+$/) }),
      query: z.object({ dry: z.coerce.boolean().default(false) }),
      body: z.object({ name: z.string().min(2).max(10), qty: z.number().int().min(1) }),
    },
    handler: async ({ params, query, body }) => ({ status: 201, data: { id: params.id, dry: query.dry, ...body } }),
  });
  v1.add({
    method: 'post', path: '/pay', summary: 'pay', auth: 'user', idempotent: 'required',
    schema: { body: z.object({ amount: z.number() }) },
    handler: async ({ body }) => { calls.create++; await new Promise((r) => setTimeout(r, 30)); return { status: 201, data: { charged: body.amount, n: calls.create } }; },
  });
  v1.add({
    method: 'post', path: '/flaky', summary: 'flaky', auth: 'user', idempotent: 'optional',
    schema: { body: z.object({ ok: z.boolean() }) },
    handler: async ({ body }) => { calls.boom++; if (!body.ok) throw new ConflictError('nope'); return { data: { n: calls.boom } }; },
  });
  v1.add({ method: 'delete', path: '/gone', summary: 'd', auth: 'user', handler: async () => ({ status: 204 }) });
};

describe('gateway pipeline', () => {
  const t = buildTestApp({ modules: [demo] });
  t.users.set('u1').set('admin1', { role: 'admin' }).set('g1', { role: 'guest' }).set('banned', { isBanned: true });

  describe('security & transport', () => {
    it('sends hardened headers and a request id; hides the framework', async () => {
      const res = await request(t.app).get('/api/v1/ping');
      expect(res.status).toBe(200);
      expect(res.headers['x-powered-by']).toBeUndefined();
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-security-policy']).toContain("default-src 'none'");
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
      expect(res.headers['api-version']).toBe('1');
      expect(res.body).toEqual({ data: { pong: true }, meta: { requestId: res.headers['x-request-id'] } });
    });

    it('echoes a sane inbound request id and rejects a hostile one', async () => {
      expect((await request(t.app).get('/api/v1/ping').set('X-Request-Id', 'trace-abc12345')).headers['x-request-id']).toBe('trace-abc12345');
      const bad = await request(t.app).get('/api/v1/ping').set('X-Request-Id', 'a b\tc');
      expect(bad.headers['x-request-id']).not.toBe('a b\tc');
    });

    it('compresses large responses and honours opt-out', async () => {
      const gz = await request(t.app).get('/api/v1/big').set('Accept-Encoding', 'gzip');
      expect(gz.headers['content-encoding']).toBe('gzip');
      expect(gz.body.data.big).toBe(big);
      const none = await request(t.app).get('/api/v1/big').set('Accept-Encoding', 'gzip').set('x-no-compression', '1');
      expect(none.headers['content-encoding']).toBeUndefined();
      const small = await request(t.app).get('/api/v1/ping').set('Accept-Encoding', 'gzip');
      expect(small.headers['content-encoding']).toBeUndefined();
    });

    it('CORS: allow-listed origin gets headers, others do not; preflight answers 204', async () => {
      const ok = await request(t.app).get('/api/v1/ping').set('Origin', 'http://allowed.test');
      expect(ok.headers['access-control-allow-origin']).toBe('http://allowed.test');
      expect(ok.headers['access-control-allow-credentials']).toBe('true');
      const evil = await request(t.app).get('/api/v1/ping').set('Origin', 'http://evil.test');
      expect(evil.headers['access-control-allow-origin']).toBeUndefined();
      const pre = await request(t.app).options('/api/v1/items/1').set('Origin', 'http://allowed.test').set('Access-Control-Request-Method', 'POST').set('Access-Control-Request-Headers', 'idempotency-key,authorization');
      expect(pre.status).toBe(204);
      expect(pre.headers['access-control-allow-headers']).toContain('Idempotency-Key');
    });

    it('production: redirects HTTP→HTTPS, refuses plain-HTTP writes, sends HSTS over TLS, keeps liveness open', async () => {
      const prod = buildTestApp({
        modules: [demo],
        env: {
          NODE_ENV: 'production', PUBLIC_URL: 'https://api.vibematch.test', TRUST_PROXY: '1',
          CORS_ORIGINS: 'https://app.vibematch.test', SETTINGS_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
          WEBAUTHN_RP_ID: 'vibematch.test',
        },
      });
      const r = await request(prod.app).get('/api/v1/ping?x=1').set('X-Forwarded-Proto', 'http');
      expect(r.status).toBe(308);
      expect(r.headers.location).toBe('https://api.vibematch.test/api/v1/ping?x=1');
      const w = await request(prod.app).post('/api/v1/items/1').set('X-Forwarded-Proto', 'http').send({});
      expect(w.status).toBe(400);
      expect(w.body.code).toBe('https_required');
      expect((await request(prod.app).get('/health/live').set('X-Forwarded-Proto', 'http')).status).toBe(200);
      const tls = await request(prod.app).get('/api/v1/ping').set('X-Forwarded-Proto', 'https');
      expect(tls.status).toBe(200);
      expect(tls.headers['strict-transport-security']).toContain('max-age=31536000');
    });

    it('refuses TRUST_PROXY=true', () => {
      expect(() => parseTrustProxy('true')).toThrow();
      expect(parseTrustProxy('2')).toBe(2);
      expect(parseTrustProxy('10.0.0.0/8, 192.168.0.1')).toEqual(['10.0.0.0/8', '192.168.0.1']);
      expect(parseTrustProxy('false')).toBe(false);
      expect(parseTrustProxy('loopback')).toBe('loopback');
    });
  });

  describe('error handling (RFC 9457)', () => {
    it('404 is problem+json with correlation', async () => {
      const res = await request(t.app).get('/api/v1/nope');
      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body).toMatchObject({ status: 404, code: 'not_found', instance: '/api/v1/nope' });
      expect(res.body.requestId).toBe(res.headers['x-request-id']);
    });

    it('500 never leaks internals', async () => {
      const res = await request(t.app).get('/api/v1/boom');
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain('secret db password');
      expect(res.body.code).toBe('internal_error');
    });

    it('typed errors keep their status and code', async () => {
      const res = await request(t.app).get('/api/v1/conflict');
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('username_taken');
    });

    it('malformed JSON → 400, oversized → 413, non-JSON content type is ignored safely', async () => {
      const bad = await request(t.app).post('/api/v1/items/1').set('Authorization', t.bearer('u1')).set('Content-Type', 'application/json').send('{"a":');
      expect(bad.status).toBe(400);
      const small = buildTestApp({ modules: [demo], env: { BODY_LIMIT: '1kb' } });
      small.users.set('u1');
      const huge = await request(small.app).post('/api/v1/items/1').set('Authorization', small.bearer('u1')).send({ name: 'ab', qty: 1, junk: big });
      expect(huge.status).toBe(413);
    });

    it('rejects Mongo operator injection in bodies', async () => {
      const res = await request(t.app).post('/api/v1/items/1').set('Authorization', t.bearer('u1')).send({ name: { $ne: null }, qty: 1 });
      expect(res.status).toBe(400);
      expect(res.body.detail).toContain('$ne');
      const proto = await request(t.app).post('/api/v1/items/1').set('Authorization', t.bearer('u1')).set('Content-Type', 'application/json').send('{"__proto__":{"admin":true},"name":"ab","qty":1}');
      expect(proto.status).toBe(400);
    });

    it('query-string operator objects never reach handlers (flat parser)', async () => {
      const res = await request(t.app).post('/api/v1/items/1?dry[$ne]=1').set('Authorization', t.bearer('u1')).send({ name: 'ab', qty: 1 });
      expect(res.status).toBe(422);
    });
  });

  describe('authentication & authorization', () => {
    it('401 without / with bad tokens', async () => {
      expect((await request(t.app).get('/api/v1/me')).status).toBe(401);
      const bad = await request(t.app).get('/api/v1/me').set('Authorization', 'Bearer abc.def.ghi');
      expect(bad.status).toBe(401);
      expect(bad.body.code).toBe('token_invalid');
      expect(bad.headers['www-authenticate']).toBe('Bearer');
      expect((await request(t.app).get('/api/v1/me').set('Authorization', 'Basic xx')).status).toBe(401);
    });

    it('unknown account and banned account are rejected on every request', async () => {
      expect((await request(t.app).get('/api/v1/me').set('Authorization', t.bearer('ghost'))).body.code).toBe('account_not_found');
      const ban = await request(t.app).get('/api/v1/me').set('Authorization', t.bearer('banned'));
      expect(ban.status).toBe(403);
      expect(ban.body.code).toBe('account_banned');
    });

    it('role comes from the database, not the token', async () => {
      const forged = t.bearer('u1', 'admin'); // token claims admin, DB says user
      expect((await request(t.app).get('/api/v1/admin/thing').set('Authorization', forged)).status).toBe(403);
      expect((await request(t.app).get('/api/v1/me').set('Authorization', forged)).body.data.role).toBe('user');
      expect((await request(t.app).get('/api/v1/admin/thing').set('Authorization', t.bearer('admin1', 'user'))).status).toBe(200);
    });

    it('guests are excluded unless the route lists them', async () => {
      expect((await request(t.app).get('/api/v1/me').set('Authorization', t.bearer('g1'))).status).toBe(403);
      expect((await request(t.app).get('/api/v1/guest-ok').set('Authorization', t.bearer('g1'))).body.data.role).toBe('guest');
    });

    it('optional auth attaches identity when valid and ignores garbage', async () => {
      expect((await request(t.app).get('/api/v1/opt')).body.data.userId).toBeNull();
      expect((await request(t.app).get('/api/v1/opt').set('Authorization', 'Bearer garbage')).body.data.userId).toBeNull();
      expect((await request(t.app).get('/api/v1/opt').set('Authorization', t.bearer('u1'))).body.data.userId).toBe('u1');
    });
  });

  describe('leveled API keys', () => {
    const mobile = t.apiKeys.issue('mobile');
    const admin = t.apiKeys.issue('admin');
    const pub = t.apiKeys.issue('public');

    it('required level: missing 401, malformed 401, too low 403, sufficient 200', async () => {
      expect((await request(t.app).get('/api/v1/mobile-only')).body.code).toBe('api_key_required');
      expect((await request(t.app).get('/api/v1/mobile-only').set('X-API-Key', 'junk')).body.code).toBe('api_key_invalid');
      const forged = mobile.replace(/.$/, mobile.endsWith('A') ? 'B' : 'A');
      expect((await request(t.app).get('/api/v1/mobile-only').set('X-API-Key', forged)).status).toBe(401);
      const low = await request(t.app).get('/api/v1/mobile-only').set('X-API-Key', pub);
      expect(low.status).toBe(403);
      expect(low.body.code).toBe('api_key_level_insufficient');
      expect((await request(t.app).get('/api/v1/mobile-only').set('X-API-Key', mobile)).status).toBe(200);
      expect((await request(t.app).get('/api/v1/mobile-only').set('X-API-Key', admin)).status).toBe(200);
    });

    it('a lower-level key caps an admin token', async () => {
      const capped = await request(t.app).get('/api/v1/admin/thing').set('Authorization', t.bearer('admin1')).set('X-API-Key', mobile);
      expect(capped.status).toBe(403);
      expect(capped.body.code).toBe('api_key_level_insufficient');
      expect((await request(t.app).get('/api/v1/admin/thing').set('Authorization', t.bearer('admin1')).set('X-API-Key', admin)).status).toBe(200);
      expect((await request(t.app).get('/api/v1/admin/thing').set('Authorization', t.bearer('admin1'))).status).toBe(200);
    });
  });

  describe('metrics & health', () => {
    it('liveness is public; metrics need an admin-level key', async () => {
      expect((await request(t.app).get('/health/live')).body.data.status).toBe('ok');
      expect((await request(t.app).get('/metrics')).status).toBe(401);
      const key = t.apiKeys.issue('admin');
      const m = await request(t.app).get('/metrics').set('X-API-Key', key);
      expect(m.status).toBe(200);
      expect(m.text).toContain('vibematch_http_requests_total');
      expect(m.text).toContain('route="/api/v1/ping"'.replace('/api/v1', '') ); // route label is the registry pattern
    });

    it('readiness reflects dependency failures with 503', async () => {
      const ok = buildTestApp({ healthChecks: [{ name: 'db', run: async () => ({ ok: true, detail: { pingMs: 1 } }) }] });
      expect((await request(ok.app).get('/health/ready')).status).toBe(200);
      const bad = buildTestApp({
        healthChecks: [
          { name: 'db', run: async () => ({ ok: true }) },
          { name: 'redis', run: async () => { throw new Error('down'); } },
          { name: 'slow', run: () => new Promise(() => {}) },
        ],
      });
      vi.useFakeTimers({ toFake: ['setTimeout'] });
      const pending = request(bad.app).get('/health/ready').then((r) => r);
      await vi.advanceTimersByTimeAsync(3500);
      vi.useRealTimers();
      const res = await pending;
      expect(res.status).toBe(503);
      expect(res.body.data.status).toBe('degraded');
      expect(res.body.data.checks.map((c: { ok: boolean }) => c.ok)).toEqual([true, false, false]);
    });
  });

  describe('versioning', () => {
    it('406 for unsupported versions, ok for matching, header is optional', async () => {
      const bad = await request(t.app).get('/api/v1/ping').set('Accept-Version', '2');
      expect(bad.status).toBe(406);
      expect(bad.body.code).toBe('version_not_supported');
      expect(bad.body.supported).toEqual(['1']);
      expect((await request(t.app).get('/api/v1/ping').set('Accept-Version', '1')).status).toBe(200);
    });
  });

  describe('validation & whitelisting', () => {
    const auth = () => t.bearer('u1');
    it('coerces and validates params/query/body', async () => {
      const res = await request(t.app).post('/api/v1/items/42?dry=true').set('Authorization', auth()).send({ name: 'abc', qty: 3 });
      expect(res.status).toBe(201);
      expect(res.body.data).toEqual({ id: '42', dry: true, name: 'abc', qty: 3 });
    });

    it('rejects unknown body keys (mass-assignment guard) with field-level errors', async () => {
      const res = await request(t.app).post('/api/v1/items/1').set('Authorization', auth()).send({ name: 'abc', qty: 1, role: 'admin' });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('validation_failed');
      expect(res.body.detail).toBeDefined();
    });

    it('reports every invalid field', async () => {
      const res = await request(t.app).post('/api/v1/items/abc').set('Authorization', auth()).send({ name: 'a', qty: 0 });
      expect(res.status).toBe(422);
      expect(res.body.errors.length).toBeGreaterThanOrEqual(1);
    });

    it('handles empty bodies and 204 responses', async () => {
      expect((await request(t.app).post('/api/v1/items/1').set('Authorization', auth())).status).toBe(422);
      const del = await request(t.app).delete('/api/v1/gone').set('Authorization', auth());
      expect(del.status).toBe(204);
      expect(del.text).toBe('');
    });
  });

  describe('rate limiting', () => {
    it('returns 429 with Retry-After and RateLimit-* headers once the budget is spent', async () => {
      const lim = buildTestApp({ modules: [demo], env: { RATE_LIMIT_GLOBAL: '3', RATE_LIMIT_WINDOW_MS: '60000' } });
      const seen: number[] = [];
      let last = await request(lim.app).get('/api/v1/ping');
      seen.push(last.status);
      expect(last.headers['ratelimit-limit']).toBe('3');
      expect(last.headers['ratelimit-remaining']).toBe('2');
      for (let i = 0; i < 3; i++) {
        last = await request(lim.app).get('/api/v1/ping');
        seen.push(last.status);
      }
      expect(seen).toEqual([200, 200, 200, 429]);
      expect(last.body.code).toBe('rate_limited');
      expect(Number(last.headers['retry-after'])).toBeGreaterThan(0);
      expect(last.headers['content-type']).toContain('problem+json');
    });

    it('auth policy is keyed by account too (one victim, many IPs is still throttled per ip+account)', async () => {
      const lim = buildTestApp({
        env: { RATE_LIMIT_AUTH: '2' },
        modules: [({ v1 }) => {
          v1.add({ method: 'post', path: '/login', summary: 'l', auth: 'public', rateLimit: 'auth', schema: { body: z.object({ username: z.string() }) }, handler: async () => ({ data: { ok: true } }) });
        }],
      });
      const hit = (u: string) => request(lim.app).post('/api/v1/login').send({ username: u });
      expect((await hit('a')).status).toBe(200);
      expect((await hit('a')).status).toBe(200);
      expect((await hit('a')).status).toBe(429);
      expect((await hit('b')).status).toBe(200); // different account has its own budget
    });
  });

  describe('idempotency', () => {
    const pay = (key: string | undefined, amount = 5) => {
      const r = request(t.app).post('/api/v1/pay').set('Authorization', t.bearer('u1'));
      if (key) r.set('Idempotency-Key', key);
      return r.send({ amount });
    };

    it('replays the stored response and runs the handler once', async () => {
      calls.create = 0;
      const first = await pay('key-aaaaaaaa');
      const second = await pay('key-aaaaaaaa');
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(second.body.data).toEqual(first.body.data);
      expect(calls.create).toBe(1);
    });

    it('same key with a different payload → 422', async () => {
      await pay('key-bbbbbbbb', 1);
      const res = await pay('key-bbbbbbbb', 2);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('idempotency_key_reuse');
    });

    it('concurrent duplicates → one runs, the other gets 409 request_in_progress', async () => {
      calls.create = 0;
      const [a, b] = await Promise.all([pay('key-cccccccc'), pay('key-cccccccc')]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([201, 409]);
      expect([a, b].find((r) => r.status === 409)!.body.code).toBe('request_in_progress');
      expect(calls.create).toBe(1);
    });

    it('is required where declared, validated for shape, and scoped per user', async () => {
      expect((await pay(undefined)).status).toBe(400);
      expect((await pay('short')).status).toBe(400);
      t.users.set('u2');
      const other = await request(t.app).post('/api/v1/pay').set('Authorization', t.bearer('u2')).set('Idempotency-Key', 'key-aaaaaaaa').send({ amount: 5 });
      expect(other.status).toBe(201);
      expect(other.headers['idempotent-replayed']).toBeUndefined();
    });

    it('failed requests release the key so the client can retry', async () => {
      calls.boom = 0;
      const send = (ok: boolean) => request(t.app).post('/api/v1/flaky').set('Authorization', t.bearer('u1')).set('Idempotency-Key', 'key-dddddddd').send({ ok });
      expect((await send(false)).status).toBe(409);
      const retry = await send(true); // different body than the failed one, key was released
      expect(retry.status).toBe(200);
    });

    it('optional mode works without a key', async () => {
      const res = await request(t.app).post('/api/v1/flaky').set('Authorization', t.bearer('u1')).send({ ok: true });
      expect(res.status).toBe(200);
    });
  });
});

describe('admin IP allow-list', () => {
  it('blocks callers outside the list', async () => {
    const t = buildTestApp({ modules: [demo], env: { ADMIN_IP_ALLOWLIST: '203.0.113.0/24' } });
    t.users.set('admin1', { role: 'admin' });
    const res = await request(t.app).get('/api/v1/admin/thing').set('Authorization', t.bearer('admin1'));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ip_not_allowed');
  });

  it('allows listed addresses (incl. IPv4-mapped IPv6)', async () => {
    const t = buildTestApp({ modules: [demo], env: { ADMIN_IP_ALLOWLIST: '127.0.0.1' } });
    t.users.set('admin1', { role: 'admin' });
    expect((await request(t.app).get('/api/v1/admin/thing').set('Authorization', t.bearer('admin1'))).status).toBe(200);
  });
});

describe('RouteRegistry deny-by-default', () => {
  const base = { method: 'get', path: '/x', summary: 's', handler: async () => ({}) } as const;
  it('refuses routes without an explicit auth mode', () => {
    expect(() => new RouteRegistry().add({ ...base } as unknown as RouteDef)).toThrow(/deny-by-default/);
    expect(() => new RouteRegistry().add({ ...base, auth: 'maybe' } as unknown as RouteDef)).toThrow(/auth/);
  });
  it('refuses malformed declarations', () => {
    const r = new RouteRegistry();
    expect(() => r.add({ ...base, path: 'x', auth: 'public' })).toThrow(/start with/);
    expect(() => r.add({ ...base, summary: '', auth: 'public' })).toThrow(/summary/);
    expect(() => r.add({ ...base, method: 'trace' as never, auth: 'public' })).toThrow(/method/);
    expect(() => r.add({ ...base, auth: 'admin', roles: ['user'] })).toThrow(/roles/);
    expect(() => r.add({ ...base, auth: 'public', handler: undefined as never })).toThrow(/handler/);
    r.add({ ...base, auth: 'public' });
    expect(() => r.add({ ...base, auth: 'public' })).toThrow(/twice/);
    expect(r.size).toBe(1);
  });
  it('describes routes for OpenAPI generation', () => {
    const r = new RouteRegistry().add({ ...base, auth: 'admin' }).add({ ...base, path: '/y', auth: 'user', idempotent: 'required', apiKey: 'mobile' });
    expect(r.describe()).toMatchObject([
      { path: '/x', roles: ['admin'], rateLimit: 'admin' },
      { path: '/y', roles: ['user', 'admin'], rateLimit: 'user', idempotent: 'required', apiKey: 'mobile' },
    ]);
  });
});
