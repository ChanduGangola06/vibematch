import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthChallengeModel, AuthCredentialModel, UserModel, syncIndexes } from '../../src/infra/db/models/index.js';
import { SoftAuthenticator } from '../helpers/authenticator.js';
import { buildFullApp, makeAdmin, registerUser, strongPassword, type FullApp } from '../helpers/full-app.js';
import { clearTestDb, startTestDb, stopTestDb } from '../helpers/mongo.js';

describe('WebAuthn (passkeys)', () => {
  let f: FullApp;
  beforeAll(async () => {
    await startTestDb();
    await syncIndexes();
    f = buildFullApp();
  });
  afterAll(stopTestDb);
  beforeEach(clearTestDb);

  async function enrol(bearer: string, authn = new SoftAuthenticator(), label = 'My laptop') {
    const opts = await f.http().post('/api/v1/auth/webauthn/register/options').set('Authorization', bearer);
    expect(opts.status).toBe(200);
    const res = await f.http().post('/api/v1/auth/webauthn/register/verify').set('Authorization', bearer).send({ credential: authn.register(opts.body.data), label });
    return { res, authn, options: opts.body.data };
  }

  it('an admin can register a passkey and list it', async () => {
    const admin = await makeAdmin(f);
    const { res, authn } = await enrol(admin.bearer);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ id: authn.id, label: 'My laptop' });
    const list = await f.http().get('/api/v1/auth/webauthn/credentials').set('Authorization', admin.bearer);
    expect(list.body.data).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toMatch(/publicKey/);
  });

  it('non-admins and anonymous callers cannot register', async () => {
    const user = await registerUser(f, 'plainuser');
    expect((await f.http().post('/api/v1/auth/webauthn/register/options').set('Authorization', user.bearer)).status).toBe(403);
    expect((await f.http().post('/api/v1/auth/webauthn/register/options')).status).toBe(401);
  });

  it('rejects wrong challenge, wrong origin, and a replayed registration', async () => {
    const admin = await makeAdmin(f);
    const a = new SoftAuthenticator();
    const o1 = await f.http().post('/api/v1/auth/webauthn/register/options').set('Authorization', admin.bearer);
    const badChallenge = await f.http().post('/api/v1/auth/webauthn/register/verify').set('Authorization', admin.bearer).send({ credential: a.register(o1.body.data, { challenge: 'AAAA' }) });
    expect(badChallenge.status).toBe(400);

    const o2 = await f.http().post('/api/v1/auth/webauthn/register/options').set('Authorization', admin.bearer);
    const badOrigin = await f.http().post('/api/v1/auth/webauthn/register/verify').set('Authorization', admin.bearer).send({ credential: a.register(o2.body.data, { origin: 'https://evil.example' }) });
    expect(badOrigin.status).toBe(400);

    const o3 = await f.http().post('/api/v1/auth/webauthn/register/options').set('Authorization', admin.bearer);
    const cred = a.register(o3.body.data);
    expect((await f.http().post('/api/v1/auth/webauthn/register/verify').set('Authorization', admin.bearer).send({ credential: cred })).status).toBe(201);
    const replay = await f.http().post('/api/v1/auth/webauthn/register/verify').set('Authorization', admin.bearer).send({ credential: cred });
    expect(replay.status).toBe(400); // challenge was consumed
  });

  it('step-up: password login for an admin with a required passkey returns a challenge token, then the passkey completes it', async () => {
    const admin = await makeAdmin(f, 'boss');
    const { authn } = await enrol(admin.bearer);
    expect((await f.http().put('/api/v1/auth/webauthn/require').set('Authorization', admin.bearer).send({ required: true })).status).toBe(200);

    const pw = await f.http().post('/api/v1/auth/login').send({ identifier: 'boss', password: strongPassword });
    expect(pw.status).toBe(200);
    expect(pw.body.data.status).toBe('passkey_required');
    expect(pw.body.data.tokens).toBeUndefined();
    const { challengeToken } = pw.body.data;

    const opts = await f.http().post('/api/v1/auth/webauthn/login/options').send({ challengeToken });
    expect(opts.status).toBe(200);
    expect(opts.body.data.options.allowCredentials[0].id).toBe(authn.id);

    const verify = await f.http().post('/api/v1/auth/webauthn/login/verify').send({ challengeToken, credential: authn.assert(opts.body.data.options) });
    expect(verify.status).toBe(200);
    expect(verify.body.data).toMatchObject({ status: 'authenticated', user: { username: 'boss', role: 'admin' } });
    const me = await f.http().get('/api/v1/auth/me').set('Authorization', `Bearer ${verify.body.data.tokens.accessToken}`);
    expect(me.status).toBe(200);

    // The challenge token and assertion are single-use.
    const replay = await f.http().post('/api/v1/auth/webauthn/login/verify').send({ challengeToken, credential: authn.assert(opts.body.data.options) });
    expect(replay.status).toBe(401);
  });

  it('OAuth2 password grant cannot bypass a required passkey', async () => {
    const admin = await makeAdmin(f, 'boss2');
    await enrol(admin.bearer);
    await f.http().put('/api/v1/auth/webauthn/require').set('Authorization', admin.bearer).send({ required: true });
    const res = await f.http().post('/api/v1/auth/token').type('form').send({ grant_type: 'password', username: 'boss2', password: strongPassword });
    expect(res.status).toBe(400);
    expect(res.body.access_token).toBeUndefined();
  });

  it('REQUIRE_ADMIN_PASSKEY applies to every admin that owns a passkey; regular users are unaffected', async () => {
    const strict = buildFullApp({ REQUIRE_ADMIN_PASSKEY: 'true' });
    const admin = await makeAdmin(strict, 'strictboss');
    const opts = await strict.http().post('/api/v1/auth/webauthn/register/options').set('Authorization', admin.bearer);
    const a = new SoftAuthenticator();
    await strict.http().post('/api/v1/auth/webauthn/register/verify').set('Authorization', admin.bearer).send({ credential: a.register(opts.body.data) });
    expect((await strict.http().post('/api/v1/auth/login').send({ identifier: 'strictboss', password: strongPassword })).body.data.status).toBe('passkey_required');
    await registerUser(strict, 'regular');
    expect((await strict.http().post('/api/v1/auth/login').send({ identifier: 'regular', password: strongPassword })).body.data.status).toBe('authenticated');
  });

  it('passwordless sign-in by username works for admins with passkeys only', async () => {
    const admin = await makeAdmin(f, 'solo');
    const { authn } = await enrol(admin.bearer);
    const opts = await f.http().post('/api/v1/auth/webauthn/login/options').send({ username: 'solo' });
    expect(opts.status).toBe(200);
    const ok = await f.http().post('/api/v1/auth/webauthn/login/verify').send({ challengeToken: opts.body.data.challengeToken, credential: authn.assert(opts.body.data.options) });
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe('authenticated');

    await registerUser(f, 'nopasskey');
    expect((await f.http().post('/api/v1/auth/webauthn/login/options').send({ username: 'nopasskey' })).body.code).toBe('passkey_unavailable');
    expect((await f.http().post('/api/v1/auth/webauthn/login/options').send({ username: 'ghost' })).body.code).toBe('passkey_unavailable');
    expect((await f.http().post('/api/v1/auth/webauthn/login/options').send({})).status).toBe(400);
  });

  it('rejects an assertion from a different authenticator, wrong origin, expired token and a regressed counter', async () => {
    const admin = await makeAdmin(f, 'sec');
    const { authn } = await enrol(admin.bearer);

    const start = async () => {
      const o = await f.http().post('/api/v1/auth/webauthn/login/options').send({ username: 'sec' });
      return { token: o.body.data.challengeToken as string, options: o.body.data.options };
    };

    let s = await start();
    expect((await f.http().post('/api/v1/auth/webauthn/login/verify').send({ challengeToken: s.token, credential: new SoftAuthenticator().assert(s.options) })).body.code).toBe('passkey_unknown');

    s = await start();
    expect((await f.http().post('/api/v1/auth/webauthn/login/verify').send({ challengeToken: s.token, credential: authn.assert(s.options, { origin: 'https://evil.example' }) })).body.code).toBe('passkey_invalid');

    s = await start();
    const forged = authn.assert(s.options);
    forged.response.signature = Buffer.from('not a signature').toString('base64url');
    expect((await f.http().post('/api/v1/auth/webauthn/login/verify').send({ challengeToken: s.token, credential: forged })).body.code).toBe('passkey_invalid');

    s = await start();
    expect((await f.http().post('/api/v1/auth/webauthn/login/verify').send({ challengeToken: s.token, credential: authn.assert(s.options) })).status).toBe(200);

    s = await start();
    expect((await f.http().post('/api/v1/auth/webauthn/login/verify').send({ challengeToken: s.token, credential: authn.assert(s.options, { counter: 1 }) })).body.code).toBe('passkey_invalid'); // counter regression → possible cloned authenticator

    s = await start();
    await AuthChallengeModel.updateOne({ key: `login:${s.token}` }, { expiresAt: new Date(Date.now() - 1000) });
    expect((await f.http().post('/api/v1/auth/webauthn/login/verify').send({ challengeToken: s.token, credential: authn.assert(s.options) })).body.code).toBe('challenge_expired');
  });

  it('cannot require a passkey without one; removing the last passkey clears the requirement', async () => {
    const admin = await makeAdmin(f, 'mgr');
    expect((await f.http().put('/api/v1/auth/webauthn/require').set('Authorization', admin.bearer).send({ required: true })).body.code).toBe('no_passkey');
    const { authn } = await enrol(admin.bearer);
    await f.http().put('/api/v1/auth/webauthn/require').set('Authorization', admin.bearer).send({ required: true });
    expect((await f.http().delete(`/api/v1/auth/webauthn/credentials/${authn.id}`).set('Authorization', admin.bearer)).status).toBe(204);
    expect((await UserModel.findOne({ id: admin.id }).lean())?.requirePasskey).toBe(false);
    expect(await AuthCredentialModel.countDocuments()).toBe(0);
    expect((await f.http().delete(`/api/v1/auth/webauthn/credentials/${authn.id}`).set('Authorization', admin.bearer)).status).toBe(404);
    expect((await f.http().post('/api/v1/auth/login').send({ identifier: 'mgr', password: strongPassword })).body.data.status).toBe('authenticated');
  });
});
