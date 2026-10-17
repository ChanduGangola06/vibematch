import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RefreshTokenModel, UserModel, GemLedgerModel, syncIndexes } from '../../src/infra/db/models/index.js';
import { buildFullApp, registerUser, strongPassword } from '../helpers/full-app.js';
import { clearTestDb, startTestDb, stopTestDb } from '../helpers/mongo.js';

describe('auth', () => {
  const f = buildFullApp({ LOGIN_MAX_ATTEMPTS: '3', LOGIN_LOCK_MINUTES: '5' });
  beforeAll(async () => {
    await startTestDb();
    await syncIndexes();
  });
  afterAll(stopTestDb);
  beforeEach(clearTestDb);

  describe('register', () => {
    it('creates an account, hashes the password, grants the signup bonus, never returns secrets', async () => {
      const res = await f.http().post('/api/v1/auth/register').send({ username: 'Alice_01', email: 'Alice@Example.com', password: strongPassword, gender: 'female', name: 'Alice' });
      expect(res.status).toBe(201);
      const { user, tokens, status, isNewUser } = res.body.data;
      expect(status).toBe('authenticated');
      expect(isNewUser).toBe(true);
      expect(user).toMatchObject({ username: 'alice_01', email: 'alice@example.com', role: 'user', gems: 300, isGuest: false, gender: 'female' });
      expect(user.avatar).toMatch(/^\/images\/avatars\/female-\d+\.svg$/);
      expect(tokens).toMatchObject({ tokenType: 'Bearer', expiresIn: 900 });
      expect(tokens.refreshToken.length).toBeGreaterThan(50);
      expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|\$2[aby]\$/);

      const stored = await UserModel.findOne({ id: user.id }).select('+passwordHash').lean();
      expect(stored?.passwordHash).toMatch(/^\$2[aby]\$/);
      expect(stored?.passwordHash).not.toContain(strongPassword);
      const ledger = await GemLedgerModel.find({ userId: user.id }).lean();
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({ delta: 300, balanceAfter: 300, reason: 'signup_bonus' });
    });

    it('stores the refresh token only as a hash', async () => {
      const u = await registerUser(f, 'bob');
      const rows = await RefreshTokenModel.find({ userId: u.id }).lean();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.tokenHash).not.toBe(u.refreshToken);
      expect(JSON.stringify(rows)).not.toContain(u.refreshToken);
    });

    it('rejects duplicates (username case-insensitive, e-mail) with specific codes', async () => {
      await registerUser(f, 'carol');
      const dupUser = await f.http().post('/api/v1/auth/register').send({ username: 'CAROL', email: 'other@example.com', password: strongPassword });
      expect(dupUser.status).toBe(409);
      expect(dupUser.body.code).toBe('username_taken');
      const dupMail = await f.http().post('/api/v1/auth/register').send({ username: 'carol2', email: 'CAROL@example.com', password: strongPassword });
      expect(dupMail.status).toBe(409);
      expect(dupMail.body.code).toBe('email_taken');
    });

    it.each([
      ['short username', { username: 'ab' }],
      ['bad characters', { username: 'bad name!' }],
      ['reserved', { username: 'admin' }],
      ['guest prefix', { username: 'guest_1234' }],
      ['bad email', { email: 'nope' }],
      ['short password', { password: 'abc123' }],
      ['common password', { password: 'password123' }],
      ['password > 72 bytes', { password: 'a'.repeat(73) }],
      ['underage', { age: 12 }],
      ['unknown field (mass assignment)', { role: 'admin' }],
      ['gems injection', { gems: 99999 }],
    ])('validates: %s', async (_name, patch) => {
      const res = await f.http().post('/api/v1/auth/register').send({ username: 'validuser', email: 'v@example.com', password: strongPassword, ...patch });
      expect(res.status).toBe(422);
      expect(await UserModel.countDocuments()).toBe(0);
    });

    it('derives the country from the edge header, not from a third-party lookup', async () => {
      const res = await f.http().post('/api/v1/auth/register').set('CF-IPCountry', 'de').send({ username: 'dieter', email: 'd@example.com', password: strongPassword });
      expect(res.body.data.user).toMatchObject({ country: 'Germany', countryCode: 'DE' });
    });
  });

  describe('login', () => {
    it('logs in by username or e-mail (case-insensitive) and returns a working token', async () => {
      await registerUser(f, 'dave');
      for (const identifier of ['dave', 'DAVE', 'dave@example.com', 'Dave@Example.com']) {
        const res = await f.http().post('/api/v1/auth/login').send({ identifier, password: strongPassword });
        expect(res.status, identifier).toBe(200);
        const me = await f.http().get('/api/v1/auth/me').set('Authorization', `Bearer ${res.body.data.tokens.accessToken}`);
        expect(me.body.data.username).toBe('dave');
      }
    });

    it('L1 regression: an unknown user with any password is rejected and NO account is created', async () => {
      const res = await f.http().post('/api/v1/auth/login').send({ identifier: 'ghost', password: 'whatever123' });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('invalid_credentials');
      expect(await UserModel.countDocuments()).toBe(0);
    });

    it('gives the same answer for unknown user and wrong password (no enumeration)', async () => {
      await registerUser(f, 'erin');
      const wrong = await f.http().post('/api/v1/auth/login').send({ identifier: 'erin', password: 'not-the-password' });
      const unknown = await f.http().post('/api/v1/auth/login').send({ identifier: 'nobody', password: 'not-the-password' });
      expect(wrong.status).toBe(401);
      expect(unknown.status).toBe(401);
      expect(wrong.body.detail).toBe(unknown.body.detail);
      expect(wrong.body.code).toBe(unknown.body.code);
    });

    it('locks the account after repeated failures, even for the right password, and unlocks later', async () => {
      const u = await registerUser(f, 'frank');
      for (let i = 0; i < 3; i++) {
        expect((await f.http().post('/api/v1/auth/login').send({ identifier: 'frank', password: 'bad-password-1' })).status).toBe(401);
      }
      const locked = await f.http().post('/api/v1/auth/login').send({ identifier: 'frank', password: strongPassword });
      expect(locked.status).toBe(429);
      expect(Number(locked.headers['retry-after'])).toBeGreaterThan(200);
      await UserModel.updateOne({ id: u.id }, { $set: { lockedUntil: new Date(Date.now() - 1000) } });
      const ok = await f.http().post('/api/v1/auth/login').send({ identifier: 'frank', password: strongPassword });
      expect(ok.status).toBe(200);
      expect((await UserModel.findOne({ id: u.id }).lean())?.failedLogins).toBe(0);
    });

    it('a banned user cannot log in or use an existing token', async () => {
      const u = await registerUser(f, 'gina');
      await UserModel.updateOne({ id: u.id }, { isBanned: true });
      const res = await f.http().post('/api/v1/auth/login').send({ identifier: 'gina', password: strongPassword });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('account_banned');
      await f.deps.events.emitAndWait('user.banned', { userId: u.id, banned: true });
      const me = await f.http().get('/api/v1/auth/me').set('Authorization', u.bearer);
      expect(me.status).toBe(403);
    });

    it('re-hashes legacy low-cost bcrypt hashes on login', async () => {
      const bcrypt = (await import('bcryptjs')).default;
      await UserModel.create({ username: 'legacy', usernameLower: 'legacy', emailLower: 'l@example.com', email: 'l@example.com', passwordHash: bcrypt.hashSync('Legacy-pass-9', 3) });
      const bumped = buildFullApp({ BCRYPT_COST: '6' });
      expect((await bumped.http().post('/api/v1/auth/login').send({ identifier: 'legacy', password: 'Legacy-pass-9' })).status).toBe(200);
      const after = await UserModel.findOne({ usernameLower: 'legacy' }).select('+passwordHash').lean();
      expect(bcrypt.getRounds(after!.passwordHash!)).toBe(6);
    });

    it('accounts without a password (social-only) cannot be used with the password flow', async () => {
      await UserModel.create({ username: 'sociallo', usernameLower: 'sociallo' });
      expect((await f.http().post('/api/v1/auth/login').send({ identifier: 'sociallo', password: '' })).status).toBe(422);
      expect((await f.http().post('/api/v1/auth/login').send({ identifier: 'sociallo', password: 'x' })).status).toBe(401);
    });
  });

  describe('guest', () => {
    it('creates a restricted guest account', async () => {
      const res = await f.http().post('/api/v1/auth/guest');
      expect(res.status).toBe(201);
      expect(res.body.data.user).toMatchObject({ role: 'guest', isGuest: true, gems: 0 });
      expect(res.body.data.user.username).toMatch(/^guest_[0-9a-f]{7}$/);
      const me = await f.http().get('/api/v1/auth/me').set('Authorization', `Bearer ${res.body.data.tokens.accessToken}`);
      expect(me.status).toBe(200);
    });

    it('can be disabled from settings', async () => {
      const off = buildFullApp({}, { authFlags: { guestLoginEnabled: async () => false, providerEnabled: async () => true, signupBonusGems: async () => 0 } });
      const res = await off.http().post('/api/v1/auth/guest');
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('guest_login_disabled');
    });
  });

  describe('refresh tokens (OAuth2 rotation)', () => {
    it('rotates: the old token dies, the new one works, same session id', async () => {
      const u = await registerUser(f, 'henry');
      const r1 = await f.http().post('/api/v1/auth/refresh').send({ refreshToken: u.refreshToken });
      expect(r1.status).toBe(200);
      const next = r1.body.data.tokens;
      expect(next.refreshToken).not.toBe(u.refreshToken);
      expect(f.deps.tokens.verifyAccess(next.accessToken).sid).toBe(f.deps.tokens.verifyAccess(u.accessToken).sid);
      const r2 = await f.http().post('/api/v1/auth/refresh').send({ refreshToken: next.refreshToken });
      expect(r2.status).toBe(200);
    });

    it('reuse of a rotated token revokes the whole family (including the newest token and access token)', async () => {
      const u = await registerUser(f, 'iris');
      const r1 = await f.http().post('/api/v1/auth/refresh').send({ refreshToken: u.refreshToken });
      const newest = r1.body.data.tokens;
      const replay = await f.http().post('/api/v1/auth/refresh').send({ refreshToken: u.refreshToken });
      expect(replay.status).toBe(401);
      expect(replay.body.code).toBe('refresh_token_reuse');
      expect((await f.http().post('/api/v1/auth/refresh').send({ refreshToken: newest.refreshToken })).status).toBe(401);
      const me = await f.http().get('/api/v1/auth/me').set('Authorization', `Bearer ${newest.accessToken}`);
      expect(me.status).toBe(401);
      expect(me.body.code).toBe('session_revoked');
    });

    it('concurrent refreshes with the same token: at most one succeeds', async () => {
      const u = await registerUser(f, 'jack');
      const results = await Promise.all(Array.from({ length: 5 }, () => f.http().post('/api/v1/auth/refresh').send({ refreshToken: u.refreshToken })));
      expect(results.filter((r) => r.status === 200).length).toBeLessThanOrEqual(1);
    });

    it('rejects unknown, expired, banned-user and missing tokens', async () => {
      const u = await registerUser(f, 'kate');
      expect((await f.http().post('/api/v1/auth/refresh').send({ refreshToken: 'x'.repeat(64) })).body.code).toBe('invalid_refresh_token');
      expect((await f.http().post('/api/v1/auth/refresh').send({})).status).toBe(400);
      await RefreshTokenModel.updateMany({ userId: u.id }, { expiresAt: new Date(Date.now() - 1000) });
      expect((await f.http().post('/api/v1/auth/refresh').send({ refreshToken: u.refreshToken })).body.code).toBe('refresh_token_expired');
      const v = await registerUser(f, 'liam');
      await UserModel.updateOne({ id: v.id }, { isBanned: true });
      expect((await f.http().post('/api/v1/auth/refresh').send({ refreshToken: v.refreshToken })).body.code).toBe('account_banned');
    });
  });

  describe('web clients: refresh token in an httpOnly cookie', () => {
    it('sets a hardened cookie, omits the token from the body, and refreshes from the cookie', async () => {
      const res = await f.http().post('/api/v1/auth/register').set('X-Client-Type', 'web').send({ username: 'mona', email: 'm@example.com', password: strongPassword });
      expect(res.body.data.tokens.refreshToken).toBeUndefined();
      const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!;
      expect(cookie).toMatch(/^vm_rt=/);
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Strict/i);
      expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
      const refreshed = await f.http().post('/api/v1/auth/refresh').set('X-Client-Type', 'web').set('Cookie', cookie.split(';')[0]!).send({});
      expect(refreshed.status).toBe(200);
      expect(refreshed.body.data.tokens.accessToken).toBeTruthy();
      expect(refreshed.body.data.tokens.refreshToken).toBeUndefined();
    });

    it('logout clears the cookie and kills the session immediately', async () => {
      const res = await f.http().post('/api/v1/auth/register').set('X-Client-Type', 'web').send({ username: 'nina', email: 'n@example.com', password: strongPassword });
      const access = `Bearer ${res.body.data.tokens.accessToken}`;
      const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
      const out = await f.http().post('/api/v1/auth/logout').set('Authorization', access).set('Cookie', cookie).send({});
      expect(out.status).toBe(204);
      expect((out.headers['set-cookie'] as unknown as string[])[0]).toMatch(/vm_rt=;/);
      expect((await f.http().get('/api/v1/auth/me').set('Authorization', access)).body.code).toBe('session_revoked');
      expect((await f.http().post('/api/v1/auth/refresh').set('Cookie', cookie).send({})).status).toBe(401);
    });
  });

  describe('logout & password change', () => {
    it('logout with only the refresh token works (expired access token case)', async () => {
      const u = await registerUser(f, 'omar');
      expect((await f.http().post('/api/v1/auth/logout').send({ refreshToken: u.refreshToken })).status).toBe(204);
      expect((await f.http().post('/api/v1/auth/refresh').send({ refreshToken: u.refreshToken })).status).toBe(401);
    });

    it('changing the password needs the old one, and signs out other sessions only', async () => {
      const u = await registerUser(f, 'pia');
      const other = await f.http().post('/api/v1/auth/login').send({ identifier: 'pia', password: strongPassword });
      const otherBearer = `Bearer ${other.body.data.tokens.accessToken}`;

      expect((await f.http().put('/api/v1/auth/password').set('Authorization', u.bearer).send({ oldPassword: 'wrong-one', newPassword: 'Another-Str0ng-pw' })).status).toBe(401);
      const ok = await f.http().put('/api/v1/auth/password').set('Authorization', u.bearer).send({ oldPassword: strongPassword, newPassword: 'Another-Str0ng-pw' });
      expect(ok.status).toBe(204);

      expect((await f.http().get('/api/v1/auth/me').set('Authorization', u.bearer)).status).toBe(200); // current session kept
      expect((await f.http().get('/api/v1/auth/me').set('Authorization', otherBearer)).body.code).toBe('session_revoked');
      expect((await f.http().post('/api/v1/auth/login').send({ identifier: 'pia', password: strongPassword })).status).toBe(401);
      expect((await f.http().post('/api/v1/auth/login').send({ identifier: 'pia', password: 'Another-Str0ng-pw' })).status).toBe(200);
      expect((await f.http().put('/api/v1/auth/password').set('Authorization', u.bearer).send({ oldPassword: 'Another-Str0ng-pw', newPassword: 'password123' })).status).toBe(422);
    });

    it('/auth/me requires authentication', async () => {
      expect((await f.http().get('/api/v1/auth/me')).status).toBe(401);
    });
  });

  describe('OAuth2 token endpoint (RFC 6749 / 7009)', () => {
    it('password grant via form-encoded body', async () => {
      await registerUser(f, 'quinn');
      const res = await f.http().post('/api/v1/auth/token').type('form').send({ grant_type: 'password', username: 'quinn', password: strongPassword });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ token_type: 'Bearer', expires_in: 900 });
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers.pragma).toBe('no-cache');
      expect(res.body.data.access_token).toBeTruthy();
    });

    it('refresh_token grant rotates; revoke always answers 200', async () => {
      const u = await registerUser(f, 'rosa');
      const r = await f.http().post('/api/v1/auth/token').type('form').send({ grant_type: 'refresh_token', refresh_token: u.refreshToken });
      expect(r.status).toBe(200);
      const revoke = await f.http().post('/api/v1/auth/revoke').type('form').send({ token: r.body.data.refresh_token });
      expect(revoke.status).toBe(200);
      expect((await f.http().post('/api/v1/auth/revoke').type('form').send({ token: 'z'.repeat(64) })).status).toBe(200);
      expect((await f.http().post('/api/v1/auth/token').type('form').send({ grant_type: 'refresh_token', refresh_token: r.body.data.refresh_token })).status).toBe(401);
    });

    it('rejects unknown grants and missing parameters', async () => {
      expect((await f.http().post('/api/v1/auth/token').type('form').send({ grant_type: 'client_credentials' })).status).toBe(422);
      expect((await f.http().post('/api/v1/auth/token').type('form').send({ grant_type: 'password', username: 'x' })).status).toBe(422);
    });
  });

  describe('social sign-in (Firebase ID token)', () => {
    const token = 'a'.repeat(40);
    it('creates an account on first use, signs in on the second, and does not duplicate', async () => {
      f.verifier.identities.set(token, { provider: 'google', uid: 'g-123', email: 'sam@gmail.com', emailVerified: true, name: 'Sam Smith', picture: 'https://lh3.example.com/a.jpg' });
      const first = await f.http().post('/api/v1/auth/social').send({ idToken: token });
      expect(first.status).toBe(201);
      expect(first.body.data.isNewUser).toBe(true);
      expect(first.body.data.user).toMatchObject({ email: 'sam@gmail.com', gems: 300, avatar: 'https://lh3.example.com/a.jpg', name: 'Sam Smith' });
      const second = await f.http().post('/api/v1/auth/social').send({ idToken: token });
      expect(second.status).toBe(200);
      expect(second.body.data.user.id).toBe(first.body.data.user.id);
      expect(await UserModel.countDocuments()).toBe(1);
    });

    it('links to an existing account only when the e-mail is verified by the provider', async () => {
      const u = await registerUser(f, 'tara');
      f.verifier.identities.set('v'.repeat(40), { provider: 'google', uid: 'g-1', email: 'tara@example.com', emailVerified: true });
      const linked = await f.http().post('/api/v1/auth/social').send({ idToken: 'v'.repeat(40) });
      expect(linked.body.data.user.id).toBe(u.id);

      f.verifier.identities.set('u'.repeat(40), { provider: 'facebook', uid: 'fb-9', email: 'tara@example.com', emailVerified: false });
      const separate = await f.http().post('/api/v1/auth/social').send({ idToken: 'u'.repeat(40) });
      expect(separate.status).toBe(201);
      expect(separate.body.data.user.id).not.toBe(u.id); // unverified e-mail must not take over an account
      expect(separate.body.data.user.email).toBeUndefined();
    });

    it('rejects invalid tokens, disabled providers and non-https avatars', async () => {
      expect((await f.http().post('/api/v1/auth/social').send({ idToken: 'n'.repeat(40) })).body.code).toBe('id_token_invalid');
      const off = buildFullApp({}, { authFlags: { guestLoginEnabled: async () => true, providerEnabled: async (p) => p !== 'apple', signupBonusGems: async () => 10 } });
      off.verifier.identities.set('p'.repeat(40), { provider: 'apple', uid: 'a-1' });
      expect((await off.http().post('/api/v1/auth/social').send({ idToken: 'p'.repeat(40) })).body.code).toBe('provider_disabled');
      f.verifier.identities.set('h'.repeat(40), { provider: 'twitter', uid: 't-1', name: 'x', picture: 'http://insecure.example/a.jpg' });
      const res = await f.http().post('/api/v1/auth/social').send({ idToken: 'h'.repeat(40) });
      expect(res.body.data.user.avatar).toMatch(/^\/images\/avatars\//);
    });

    it('generated usernames are unique and valid', async () => {
      for (let i = 0; i < 3; i++) {
        f.verifier.identities.set(`${i}`.repeat(40), { provider: 'phone', uid: `ph-${i}`, name: 'Same Name' });
      }
      const names = new Set<string>();
      for (let i = 0; i < 3; i++) names.add((await f.http().post('/api/v1/auth/social').send({ idToken: `${i}`.repeat(40) })).body.data.user.username);
      expect(names.size).toBe(3);
      for (const n of names) expect(n).toMatch(/^[a-z0-9_]{3,20}$/);
    });
  });

  describe('rate limiting on auth routes', () => {
    it('throttles login attempts per IP+account', async () => {
      const lim = buildFullApp({ RATE_LIMIT_AUTH: '3' });
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) codes.push((await lim.http().post('/api/v1/auth/login').send({ identifier: 'target', password: 'guess-guess' })).status);
      expect(codes).toEqual([401, 401, 401, 429, 429]);
    });
  });
});
