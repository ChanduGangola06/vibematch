import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  GiftModel, LanguageModel, MessageModel, PackModel, PageModel, RefreshTokenModel, SettingModel, UserModel, syncIndexes,
} from '../../src/infra/db/models/index.js';
import { buildFullApp, makeAdmin, registerUser, strongPassword, type FullApp } from '../helpers/full-app.js';
import { clearTestDb, startTestDb, stopTestDb } from '../helpers/mongo.js';

type U = Awaited<ReturnType<typeof registerUser>>;

const ndjson = (r: any, cb: (e: Error | null, b: unknown) => void) => {
  let d = '';
  r.on('data', (c: Buffer) => (d += c));
  r.on('end', () => cb(null, d));
};

describe('backup & restore', () => {
  let f: FullApp;
  let admin: U;
  beforeAll(async () => {
    await startTestDb();
    await syncIndexes();
  });
  afterAll(stopTestDb);
  beforeEach(async () => {
    await clearTestDb();
    f = buildFullApp();
    admin = await makeAdmin(f);
  });

  const exportBackup = async (secrets = false): Promise<string> =>
    (await f.http().get(`/api/v1/admin/backup?includeSecrets=${secrets}`).set('Authorization', admin.bearer).buffer(true).parse(ndjson)).body as string;
  const restore = (file: string | Buffer, fields: Record<string, string> = {}) => {
    const r = f.http().post('/api/v1/admin/backup/restore').set('Authorization', admin.bearer);
    for (const [k, v] of Object.entries(fields)) r.field(k, v);
    return r.attach('backup', Buffer.from(file), { filename: 'b.ndjson', contentType: 'application/x-ndjson' });
  };

  async function seed() {
    const a = await registerUser(f, 'alice');
    const b = await registerUser(f, 'bobby');
    await f.http().put(`/api/v1/users/${b.id}/follow`).set('Authorization', a.bearer);
    await GiftModel.create({ name: 'Rose', price: 5, imagePath: '/images/gift/r.svg' });
    await PackModel.create({ name: 'Small', price: 1, gems: 10 });
    await PageModel.create({ title: 'T', slug: 'terms', content: '<p>x</p>' });
    await LanguageModel.create({ code: 'en', name: 'English', translations: { 'a．b': 'c' } });
    await MessageModel.create({ senderId: a.id, receiverId: b.id, conversationKey: 'k', text: 'hi' });
    await f.http().put('/api/v1/admin/settings/payments').set('Authorization', admin.bearer).send({ stripeSecretKey: 'sk_live_TOPSECRET', stripePublicKey: 'pk_x' });
    await f.http().put('/api/v1/admin/settings/general').set('Authorization', admin.bearer).send({ siteName: 'Backup Co' });
    return { a, b };
  }

  it('exports a streamed NDJSON file with a header, no secrets by default, and nothing sensitive from other collections', async () => {
    await seed();
    await f.http().post('/api/v1/auth/login').send({ identifier: 'alice', password: strongPassword });
    const res = await f.http().get('/api/v1/admin/backup').set('Authorization', admin.bearer).buffer(true).parse(ndjson);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/x-ndjson');
    expect(res.headers['content-disposition']).toMatch(/vibematch-backup-\d{4}-\d{2}-\d{2}\.ndjson/);
    const text = res.body as string;
    const rows = text.trim().split('\n').map((l) => JSON.parse(l));
    expect(rows[0]._meta).toMatchObject({ format: 'vibematch-backup', version: 2, includeSecrets: false });
    const collections = new Set(rows.slice(1).map((r) => r.c));
    expect(collections).toEqual(new Set(['users', 'follows', 'messages', 'gifts', 'packs', 'pages', 'languages', 'settings', 'gemLedger', 'notifications']));

    expect(text).not.toMatch(/passwordHash|\$2[aby]\$/);
    expect(text).not.toContain('TOPSECRET');
    expect(text).not.toMatch(/v1:[\w-]+:[\w-]+:[\w-]+/); // not even the encrypted secret
    expect(text).not.toMatch(/fcmTokens|failedLogins/);
    expect(text).not.toMatch(/tokenHash|keyHash|credentialId|requestHash/); // tokens, api keys, passkeys, idempotency
    expect(text).toContain('pk_x'); // non-secret settings are kept
    expect(text).toContain('Backup Co');
    expect(await RefreshTokenModel.countDocuments()).toBeGreaterThan(0);
    await audit('backup.export');
  });

  const audit = async (action: string) =>
    expect((await f.http().get(`/api/v1/admin/audit-log?action=${action}`).set('Authorization', admin.bearer)).body.data.length).toBeGreaterThanOrEqual(1);

  it('with includeSecrets the password hashes and (still encrypted) secrets are included', async () => {
    await seed();
    const text = await exportBackup(true);
    expect(text).toMatch(/\$2[aby]\$/);
    expect(text).toMatch(/v1:[\w-]+:[\w-]+:[\w-]+/);
    expect(text).not.toContain('TOPSECRET'); // encrypted at rest, so still unreadable
  });

  it('round trip: export → wipe → restore reproduces the data, and logins still work with secrets', async () => {
    const { a } = await seed();
    const file = await exportBackup(true);
    const before = {
      users: await UserModel.countDocuments(), messages: await MessageModel.countDocuments(), gifts: await GiftModel.countDocuments(),
      settings: await SettingModel.countDocuments(),
    };
    await clearTestDb();
    f = buildFullApp(); // fresh caches, as after a restart

    // an empty database has no admin to authenticate with, so restore through the service (what a CLI would do)
    const dry = await f.services.backup.restore(Buffer.from(file), { mode: 'dry-run' });
    expect(dry.applied).toBe(false);
    expect(dry.errors).toEqual([]);
    expect(dry.collections.users).toMatchObject({ valid: before.users, invalid: 0, written: 0 });
    expect(await UserModel.countDocuments()).toBe(0); // dry-run wrote nothing

    const applied = await f.services.backup.restore(Buffer.from(file), { mode: 'merge' });
    expect(applied.applied).toBe(true);
    expect(await UserModel.countDocuments()).toBe(before.users);
    expect(await MessageModel.countDocuments()).toBe(before.messages);
    expect(await GiftModel.countDocuments()).toBe(before.gifts);
    expect(await SettingModel.countDocuments()).toBe(before.settings);

    const login = await f.http().post('/api/v1/auth/login').send({ identifier: 'alice', password: strongPassword });
    expect(login.status).toBe(200);
    expect(login.body.data.user.id).toBe(a.id);
    expect((await f.services.settings.get('general')).siteName).toBe('Backup Co');
    expect((await f.services.settings.get('payments')).stripeSecretKey).toBe('sk_live_TOPSECRET'); // decrypts with the same key
    const lang = await LanguageModel.findOne({ code: 'en' }).lean();
    expect(Object.keys(lang!.translations as object)).toEqual(['a．b']);
    expect(await applyTwice()).toBe(before.users); // idempotent merge
  });
  const applyTwice = async () => {
    const file = await exportBackup(true);
    await f.services.backup.restore(Buffer.from(file), { mode: 'merge' });
    return UserModel.countDocuments();
  };

  it('restore endpoint: dry-run by default, apply needs confirm=RESTORE', async () => {
    await seed();
    const file = await exportBackup();
    const dry = await restore(file);
    expect(dry.status).toBe(200);
    expect(dry.body.data).toMatchObject({ mode: 'dry-run', applied: false, errors: [] });
    expect((await restore(file, { mode: 'merge' })).status).toBe(400); // no confirm
    expect((await restore(file, { mode: 'merge', confirm: 'yes' })).status).toBe(400);
    const ok = await restore(file, { mode: 'merge', confirm: 'RESTORE' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.applied).toBe(true);
    expect((await restore(file, { mode: 'nuke', confirm: 'RESTORE' })).status).toBe(400);
    expect((await f.http().post('/api/v1/admin/backup/restore').set('Authorization', admin.bearer)).status).toBe(400); // no file
  });

  it('validates content: bad JSON, unknown collections, schema violations and foreign files are reported, and nothing is applied', async () => {
    const file = await exportBackup();
    const header = file.split('\n')[0]!;
    const bad = [
      header,
      'not json at all',
      JSON.stringify({ c: 'refresh_tokens', d: { tokenHash: 'x' } }),
      JSON.stringify({ c: 'gifts', d: { name: 'No price' } }),
      JSON.stringify({ c: 'packs', d: { name: 'Neg', price: -5, gems: 10 } }),
      JSON.stringify({ c: 'packs', d: 'a string' }),
      JSON.stringify({ c: 'packs', d: { name: 'Fine', price: 1, gems: 5 } }),
    ].join('\n');
    const dry = await restore(bad);
    expect(dry.status).toBe(200);
    expect(dry.body.data.collections.packs).toMatchObject({ lines: 3, valid: 1, invalid: 2 });
    expect(dry.body.data.collections.gifts).toMatchObject({ invalid: 1 });
    const messages = dry.body.data.errors.map((e: { message: string }) => e.message).join(' | ');
    expect(messages).toMatch(/Not valid JSON/);
    expect(messages).toMatch(/Unknown collection/);

    const apply = await restore(bad, { mode: 'merge', confirm: 'RESTORE' });
    expect(apply.status).toBe(400);
    expect(apply.body.detail).toMatch(/invalid line/);
    expect(await PackModel.countDocuments()).toBe(0);

    expect((await restore('{"hello":"world"}\n')).status).toBe(400); // missing header
    expect((await restore(JSON.stringify({ _meta: { format: 'vibematch-backup', version: 99 } }))).status).toBe(400);
    expect((await restore(JSON.stringify({ _meta: { format: 'other', version: 1 } }))).status).toBe(400);
  });

  it('unknown fields are dropped rather than written (whitelisting at the schema)', async () => {
    const file = await exportBackup();
    const header = file.split('\n')[0]!;
    const doc = JSON.stringify({ c: 'packs', d: { name: 'P', price: 1, gems: 5, $where: 'sleep(1000)', evil: { $ne: 1 } } });
    const res = await restore(`${header}\n${doc}`, { mode: 'merge', confirm: 'RESTORE' });
    expect(res.status).toBe(200);
    const pack = await PackModel.findOne({ name: 'P' }).lean();
    expect(pack).not.toHaveProperty('evil');
    expect(pack).not.toHaveProperty('$where');
  });

  it('replace mode wipes only the collections present in the file and refuses a users file with no admin', async () => {
    await seed();
    await PackModel.create({ name: 'Extra', price: 2, gems: 20 });
    const header = (await exportBackup()).split('\n')[0]!;

    const onlyPack = `${header}\n${JSON.stringify({ c: 'packs', d: { name: 'Solo', price: 1, gems: 5 } })}`;
    expect((await restore(onlyPack, { mode: 'replace', confirm: 'RESTORE' })).status).toBe(200);
    expect((await PackModel.find().lean()).map((p) => p.name)).toEqual(['Solo']);
    expect(await GiftModel.countDocuments()).toBe(1); // untouched
    expect(await UserModel.countDocuments()).toBe(3);

    const noAdmin = `${header}\n${JSON.stringify({ c: 'users', d: { username: 'only', usernameLower: 'only', role: 'user' } })}`;
    const refused = await restore(noAdmin, { mode: 'replace', confirm: 'RESTORE' });
    expect(refused.status).toBe(400);
    expect(refused.body.detail).toMatch(/locked out/);
    expect(await UserModel.countDocuments()).toBe(3);
  });

  it('is admin-only and size/format limited', async () => {
    const u = await registerUser(f, 'peon');
    expect((await f.http().get('/api/v1/admin/backup').set('Authorization', u.bearer)).status).toBe(403);
    expect((await f.http().post('/api/v1/admin/backup/restore').set('Authorization', u.bearer)).status).toBe(403);
    expect((await f.http().get('/api/v1/admin/backup')).status).toBe(401);
  });
});

describe('installer', () => {
  let f: FullApp;
  beforeAll(async () => {
    await startTestDb();
    await syncIndexes();
  });
  afterAll(stopTestDb);
  beforeEach(async () => {
    await clearTestDb();
    f = buildFullApp();
  });

  const body = { adminUsername: 'owner', adminEmail: 'Owner@Example.com', adminPassword: strongPassword, siteName: 'My Chat', siteUrl: 'https://chat.example.com' };

  it('reports not installed, then installs once: admin + settings + default language and pages', async () => {
    const before = await f.http().get('/api/v1/install/status');
    expect(before.body.data).toMatchObject({ installed: false, database: { connected: true, transactions: true } });

    const res = await f.http().post('/api/v1/install/complete').send(body);
    expect(res.status).toBe(201);
    expect((await f.http().get('/api/v1/install/status')).body.data.installed).toBe(true);

    const login = await f.http().post('/api/v1/auth/login').send({ identifier: 'owner@example.com', password: strongPassword });
    expect(login.body.data.user).toMatchObject({ role: 'admin', username: 'owner', email: 'owner@example.com' });
    expect((await f.http().get('/api/v1/settings/public')).body.data.general).toMatchObject({ siteName: 'My Chat', siteUrl: 'https://chat.example.com' });
    expect((await f.http().get('/api/v1/languages')).body.data.map((l: { code: string }) => l.code)).toEqual(['en']);
    expect((await f.http().get('/api/v1/pages')).body.data.map((p: { slug: string }) => p.slug).sort()).toEqual(['privacy-policy', 'terms-of-service']);
  });

  it('refuses a second install — and never deletes existing data (v1 wiped all users)', async () => {
    await f.http().post('/api/v1/install/complete').send(body);
    const other = await registerUser(f, 'regular');
    const again = await f.http().post('/api/v1/install/complete').send({ ...body, adminUsername: 'hacker', adminEmail: 'h@x.co' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('already_installed');
    expect(await UserModel.countDocuments({ username: 'hacker' })).toBe(0);
    expect(await UserModel.countDocuments({ id: other.id })).toBe(1);
    expect(await UserModel.countDocuments()).toBe(2);
  });

  it('is refused when an admin already exists even without the install marker (existing deployments)', async () => {
    await UserModel.create({ username: 'old', usernameLower: 'old', role: 'admin' });
    expect((await f.http().get('/api/v1/install/status')).body.data.installed).toBe(true);
    expect((await f.http().post('/api/v1/install/complete').send(body)).status).toBe(409);
  });

  it('concurrent installs create exactly one admin', async () => {
    const results = await Promise.all(
      ['a', 'b', 'c', 'd'].map((x) => f.http().post('/api/v1/install/complete').send({ ...body, adminUsername: `owner_${x}`, adminEmail: `${x}@example.com` })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409).length).toBe(3);
    expect(await UserModel.countDocuments({ role: 'admin' })).toBe(1);
  });

  it('a failed install releases the claim so it can be retried', async () => {
    await UserModel.create({ username: 'owner', usernameLower: 'owner', role: 'user' }); // username clash
    const failed = await f.http().post('/api/v1/install/complete').send(body);
    expect(failed.status).toBe(409);
    expect(failed.body.code).toBe('duplicate');
    expect((await f.http().get('/api/v1/install/status')).body.data.installed).toBe(false);
    expect((await f.http().post('/api/v1/install/complete').send({ ...body, adminUsername: 'owner2' })).status).toBe(201);
  });

  it('validates the wizard input', async () => {
    for (const bad of [
      { ...body, adminPassword: 'password123' }, { ...body, adminPassword: 'short' }, { ...body, adminEmail: 'nope' }, { ...body, adminUsername: 'a b' },
      { ...body, siteUrl: 'ftp://x' }, { ...body, siteUrl: 'javascript:alert(1)' }, { ...body, siteName: '' }, { ...body, role: 'admin' }, {},
    ]) {
      expect((await f.http().post('/api/v1/install/complete').send(bad)).status, JSON.stringify(bad).slice(0, 60)).toBe(422);
    }
    expect(await UserModel.countDocuments()).toBe(0);
  });
});
