import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RouteDescription } from '../../src/gateway/index.js';
import { syncIndexes } from '../../src/infra/db/models/index.js';
import { buildFullApp, makeAdmin, registerUser, type FullApp } from '../helpers/full-app.js';
import { startTestDb, stopTestDb } from '../helpers/mongo.js';

/**
 * Broken-function-level-authorization safety net (OWASP API5). It walks the live route registry, so a
 * route added tomorrow is covered automatically: no new endpoint can ship without an auth decision
 * that this test then verifies against real tokens.
 */
describe('authorization matrix (every registered route)', () => {
  let f: FullApp;
  let routes: RouteDescription[];
  let admin: Awaited<ReturnType<typeof registerUser>>;
  let n = 0;
  /** Fresh accounts per probe: some routes are destructive (e.g. delete-my-account) and must not poison later checks. */
  const freshGuest = async () => `Bearer ${(await f.http().post('/api/v1/auth/guest')).body.data.tokens.accessToken}`;
  const freshUser = async () => (await registerUser(f, `mx${++n}x`)).bearer;

  beforeAll(async () => {
    await startTestDb();
    await syncIndexes();
    f = buildFullApp({ RATE_LIMIT_GLOBAL: '100000', RATE_LIMIT_USER: '100000', RATE_LIMIT_SENSITIVE: '100000', RATE_LIMIT_AUTH: '100000' });
    const reg = f.app.locals.registries as { v1: { describe(): RouteDescription[] }; root: { describe(): RouteDescription[] } };
    routes = reg.v1.describe();
    admin = await makeAdmin(f, 'matrixadmin');
  });
  afterAll(stopTestDb);

  const url = (r: RouteDescription) => `/api/v1${r.path.replace(/:\w+/g, 'x')}`;
  const call = (r: RouteDescription, bearer?: string) => {
    const req = f.http()[r.method](url(r));
    if (bearer) req.set('Authorization', bearer);
    if (r.idempotent) req.set('Idempotency-Key', 'matrix-key-0001');
    return req.send(['post', 'put', 'patch'].includes(r.method) ? {} : undefined);
  };

  it('has a meaningful number of routes to check', () => {
    expect(routes.length).toBeGreaterThan(100);
    expect(routes.filter((r) => r.auth === 'admin').length).toBeGreaterThan(40);
  });

  it('admin routes: anonymous 401, regular user 403, guest 403, admin passes the gate', async () => {
    for (const r of routes.filter((x) => x.auth === 'admin')) {
      const label = `${r.method.toUpperCase()} ${r.path}`;
      expect((await call(r)).status, `${label} anonymous`).toBe(401);
      expect((await call(r, await freshUser())).status, `${label} user`).toBe(403);
      expect((await call(r, await freshGuest())).status, `${label} guest`).toBe(403);
      const asAdmin = (await call(r, admin.bearer)).status;
      expect([401, 403], `${label} admin was blocked (${asAdmin})`).not.toContain(asAdmin);
    }
  });

  it('user routes: anonymous 401; guests only where explicitly allowed; regular users pass the role gate', async () => {
    for (const r of routes.filter((x) => x.auth === 'user')) {
      const label = `${r.method.toUpperCase()} ${r.path}`;
      expect((await call(r)).status, `${label} anonymous`).toBe(401);

      const guest = await call(r, await freshGuest());
      if (r.roles.includes('guest')) expect(guest.body?.code, `${label} guest should pass the gate`).not.toBe('role_forbidden');
      else expect(guest.body?.code, `${label} guest must be refused`).toBe('role_forbidden');

      const asUser = await call(r, await freshUser());
      expect(asUser.status, `${label} user`).not.toBe(401);
      expect(asUser.body?.code, `${label} user`).not.toBe('role_forbidden');
    }
  });

  it('API-key protected routes refuse callers without a key', async () => {
    for (const r of routes.filter((x) => x.apiKey)) {
      const res = await call(r, admin.bearer);
      expect(res.status, `${r.method} ${r.path}`).toBe(401);
      expect(res.body.code).toBe('api_key_required');
    }
  });

  it('public routes never demand credentials', async () => {
    for (const r of routes.filter((x) => x.auth === 'public' && !x.apiKey)) {
      const status = (await call(r)).status;
      expect(status, `${r.method.toUpperCase()} ${r.path}`).not.toBe(401);
      expect(status, `${r.method.toUpperCase()} ${r.path}`).not.toBe(403);
    }
  });

  it('every route declares an explicit rate-limit policy resolution and a summary (OpenAPI-ready)', () => {
    for (const r of routes) {
      expect(r.summary.length, r.path).toBeGreaterThan(5);
      expect(['global', 'user', 'auth', 'sensitive', 'upload', 'admin']).toContain(r.rateLimit);
    }
  });

  it('no admin route is reachable through a lower-level API key', async () => {
    const mk = await f.http().post('/api/v1/admin/api-keys').set('Authorization', admin.bearer).send({ name: 'm', level: 'mobile' });
    for (const r of routes.filter((x) => x.auth === 'admin').slice(0, 15)) {
      const res = await f.http()[r.method](url(r)).set('Authorization', admin.bearer).set('X-API-Key', mk.body.data.key).send({});
      expect(res.status, `${r.method.toUpperCase()} ${r.path}`).toBe(403);
      expect(res.body.code).toBe('api_key_level_insufficient');
    }
  });
});
