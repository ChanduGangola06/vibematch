import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiKeyModel, AuditLogModel, syncIndexes } from '../../src/infra/db/models/index.js';
import { buildFullApp, makeAdmin, registerUser, type FullApp } from '../helpers/full-app.js';
import { clearTestDb, startTestDb, stopTestDb } from '../helpers/mongo.js';

describe('leveled API keys', () => {
  let f: FullApp;
  beforeAll(async () => {
    await startTestDb();
    await syncIndexes();
    f = buildFullApp();
  });
  afterAll(stopTestDb);
  beforeEach(clearTestDb);

  const create = (bearer: string, body: Record<string, unknown>) => f.http().post('/api/v1/admin/api-keys').set('Authorization', bearer).send(body);

  it('only admins can manage keys', async () => {
    const user = await registerUser(f, 'peon');
    expect((await f.http().get('/api/v1/admin/api-keys').set('Authorization', user.bearer)).status).toBe(403);
    expect((await f.http().get('/api/v1/admin/api-keys')).status).toBe(401);
    expect((await create(user.bearer, { name: 'x', level: 'admin' })).status).toBe(403);
  });

  it('creates a key whose secret is shown once, stored only as a hash, and audited', async () => {
    const admin = await makeAdmin(f);
    const res = await create(admin.bearer, { name: 'Android app', level: 'mobile', scopes: ['init'], expiresInDays: 30 });
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const plain: string = res.body.data.key;
    expect(plain).toMatch(/^vm_mobile_[\w-]{8}_[\w-]{43}$/);
    expect(res.body.data).toMatchObject({ name: 'Android app', level: 'mobile', scopes: ['init'] });
    expect(res.body.data.hint).toMatch(/^vm_mobile_[\w-]{8}_••••$/);

    expect(JSON.stringify(await ApiKeyModel.find().lean())).not.toContain(plain.split('_').pop()!);
    const list = await f.http().get('/api/v1/admin/api-keys').set('Authorization', admin.bearer);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].key).toBeUndefined();
    expect(JSON.stringify(list.body)).not.toContain(plain);
    expect(list.body.page).toMatchObject({ total: 1, page: 1 });

    const audit = await AuditLogModel.find({ action: 'api_key.create' }).lean();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorId: admin.id, target: res.body.data.id });
    expect(JSON.stringify(audit)).not.toContain(plain);
  });

  it('the issued key actually authenticates against a key-protected route and respects its level', async () => {
    const admin = await makeAdmin(f);
    const mobile = (await create(admin.bearer, { name: 'm', level: 'mobile' })).body.data.key as string;
    const pub = (await create(admin.bearer, { name: 'p', level: 'public' })).body.data.key as string;

    // /metrics needs an admin-level key
    expect((await f.http().get('/metrics').set('X-API-Key', mobile)).status).toBe(403);
    expect((await f.http().get('/metrics').set('X-API-Key', pub)).status).toBe(403);
    const adminKey = (await create(admin.bearer, { name: 'ops', level: 'admin' })).body.data.key as string;
    expect((await f.http().get('/metrics').set('X-API-Key', adminKey)).status).toBe(200);

    // a mobile key caps even an admin session on admin routes
    const capped = await f.http().get('/api/v1/admin/api-keys').set('Authorization', admin.bearer).set('X-API-Key', mobile);
    expect(capped.status).toBe(403);
    expect(capped.body.code).toBe('api_key_level_insufficient');
  });

  it('revoked and expired keys stop working (cache is invalidated on revoke)', async () => {
    const admin = await makeAdmin(f);
    const made = await create(admin.bearer, { name: 'ops', level: 'admin' });
    const key = made.body.data.key as string;
    expect((await f.http().get('/metrics').set('X-API-Key', key)).status).toBe(200); // primes the verifier cache
    expect((await f.http().delete(`/api/v1/admin/api-keys/${made.body.data.id}`).set('Authorization', admin.bearer)).status).toBe(204);
    expect((await f.http().get('/metrics').set('X-API-Key', key)).status).toBe(401);
    expect((await f.http().delete(`/api/v1/admin/api-keys/${made.body.data.id}`).set('Authorization', admin.bearer)).status).toBe(404);

    const short = await create(admin.bearer, { name: 'short', level: 'admin', expiresInDays: 1 });
    await ApiKeyModel.updateOne({ id: short.body.data.id }, { expiresAt: new Date(Date.now() - 1000) });
    expect((await f.http().get('/metrics').set('X-API-Key', short.body.data.key)).status).toBe(401);
  });

  it('rotation returns a new secret, revokes the old one, keeps level and scopes', async () => {
    const admin = await makeAdmin(f);
    const made = await create(admin.bearer, { name: 'ops', level: 'admin', scopes: ['metrics'] });
    const old = made.body.data.key as string;
    const rot = await f.http().post(`/api/v1/admin/api-keys/${made.body.data.id}/rotate`).set('Authorization', admin.bearer);
    expect(rot.status).toBe(201);
    expect(rot.body.data).toMatchObject({ level: 'admin', scopes: ['metrics'], revokedId: made.body.data.id });
    expect(rot.body.data.key).not.toBe(old);
    expect((await f.http().get('/metrics').set('X-API-Key', rot.body.data.key)).status).toBe(200);
    expect((await f.http().get('/metrics').set('X-API-Key', old)).status).toBe(401);
    expect((await f.http().post(`/api/v1/admin/api-keys/${made.body.data.id}/rotate`).set('Authorization', admin.bearer)).status).toBe(404);

    const active = await f.http().get('/api/v1/admin/api-keys').set('Authorization', admin.bearer);
    expect(active.body.data).toHaveLength(1);
    const all = await f.http().get('/api/v1/admin/api-keys?includeRevoked=true').set('Authorization', admin.bearer);
    expect(all.body.data).toHaveLength(2);
  });

  it('validates input strictly', async () => {
    const admin = await makeAdmin(f);
    for (const bad of [
      { level: 'mobile' },
      { name: 'x', level: 'root' },
      { name: 'x', level: 'mobile', scopes: ['BAD SCOPE'] },
      { name: 'x', level: 'mobile', expiresInDays: 0 },
      { name: 'x', level: 'mobile', keyHash: 'injected' },
    ]) {
      expect((await create(admin.bearer, bad)).status).toBe(422);
    }
    expect(await ApiKeyModel.countDocuments()).toBe(0);
  });
});
