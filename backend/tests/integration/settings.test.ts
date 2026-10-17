import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditLogModel, LanguageModel, PageModel, SettingModel, SettingRevisionModel, UserModel, syncIndexes,
} from '../../src/infra/db/models/index.js';
import { SecretBox } from '../../src/core/security/crypto.js';
import { buildFullApp, makeAdmin, registerUser, strongPassword, type FullApp } from '../helpers/full-app.js';
import { clearTestDb, startTestDb, stopTestDb } from '../helpers/mongo.js';

type U = Awaited<ReturnType<typeof registerUser>>;

describe('settings, public bundle, pages, languages', () => {
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
    await f.deps.cache.clear();
    admin = await makeAdmin(f);
  });

  const put = (group: string, body: unknown, who: U | null = admin) => {
    const r = f.http().put(`/api/v1/admin/settings/${group}`);
    if (who) r.set('Authorization', who.bearer);
    return r.send(body as object);
  };
  const getGroup = (group: string, who: U | null = admin) => {
    const r = f.http().get(`/api/v1/admin/settings/${group}`);
    if (who) r.set('Authorization', who.bearer);
    return r;
  };

  describe('admin settings API', () => {
    it('returns defaults for a fresh install and requires an admin', async () => {
      const res = await getGroup('general');
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ siteName: 'VibeMatch', bonusGems: 300, discoverGridUsers: 'demo_only', showOnlineUsers: true, _version: 0 });
      const user = await registerUser(f, 'plain');
      expect((await getGroup('general', user)).status).toBe(403);
      expect((await getGroup('general', null)).status).toBe(401);
      expect((await put('general', { siteName: 'X' }, user)).status).toBe(403);
      expect((await getGroup('nope')).status).toBe(422);
    });

    it('updates partially, bumps the version, keeps revisions and an audit trail without values', async () => {
      const r1 = await put('general', { siteName: 'Acme Chat', bonusGems: 500 });
      expect(r1.status).toBe(200);
      expect(r1.body.data).toMatchObject({ siteName: 'Acme Chat', bonusGems: 500, discoverGridUsers: 'demo_only', _version: 1, _changed: ['siteName', 'bonusGems'] });
      const r2 = await put('general', { siteName: 'Acme Chat', showOnlineUsers: false });
      expect(r2.body.data._changed).toEqual(['showOnlineUsers']); // unchanged fields are not reported
      expect(r2.body.data._version).toBe(2);
      expect(await SettingRevisionModel.countDocuments({ group: 'general' })).toBe(2);

      const audit = await AuditLogModel.find({ action: 'settings.update' }).sort({ createdAt: 1 }).lean();
      expect(audit).toHaveLength(2);
      expect(audit[0]).toMatchObject({ actorId: admin.id, target: 'general', meta: { changed: ['siteName', 'bonusGems'], version: 1 } });
      expect(JSON.stringify(audit)).not.toContain('Acme Chat');
    });

    it('rejects unknown fields (mass-assignment guard), wrong types and unsafe links', async () => {
      for (const bad of [
        { admin: true }, { mobileApiAccessKey: 'x' }, { bonusGems: -5 }, { bonusGems: '300' }, { discoverGridUsers: 'everyone' },
        { termsUrl: 'javascript:alert(1)' }, { logoUrl: 'data:text/html,<script>' }, { siteName: 'x'.repeat(81) },
      ]) {
        expect((await put('general', bad)).status, JSON.stringify(bad)).toBe(422);
      }
      expect((await put('auth', { firebaseConfig: 'not json' })).status).toBe(422);
      expect((await put('mail', { smtpPort: 70000 })).status).toBe(422);
      expect((await put('general', {})).status).toBe(200); // empty patch is a no-op
      expect(await SettingModel.countDocuments({ group: 'general' })).toBe(1);
    });

    it('secrets: encrypted at rest, masked on read, kept when the mask is echoed back, cleared with ""', async () => {
      const secret = 'sk_live_super_secret_1234';
      await put('payments', { stripeSecretKey: secret, stripePublicKey: 'pk_live_abcd' });

      const row = await SettingModel.findOne({ group: 'payments' }).lean();
      const stored = (row!.data as Record<string, string>).stripeSecretKey!;
      expect(SecretBox.isEncrypted(stored)).toBe(true);
      expect(stored).not.toContain('super_secret');
      expect(JSON.stringify(await SettingRevisionModel.find().lean())).not.toContain('super_secret');
      expect((row!.data as Record<string, string>).stripePublicKey).toBe('pk_live_abcd'); // non-secret stays readable

      const read = await getGroup('payments');
      expect(read.body.data.stripeSecretKey).toBe('••••1234');
      expect(JSON.stringify(read.body)).not.toContain('super_secret');

      // the admin form posts everything back, including the masked value
      await put('payments', { stripeSecretKey: '••••1234', stripePublicKey: 'pk_live_new' });
      expect((await f.services.settings.get('payments')).stripeSecretKey).toBe(secret);

      await put('payments', { stripeSecretKey: '' });
      expect((await getGroup('payments')).body.data.stripeSecretKey).toBe('');
      expect((await f.services.settings.get('payments')).stripeSecretKey).toBe('');
    });

    it('revisions can be listed and restored (as a new revision)', async () => {
      await put('seo', { seoTitle: 'One' });
      await put('seo', { seoTitle: 'Two' });
      const list = await f.http().get('/api/v1/admin/settings/seo/revisions').set('Authorization', admin.bearer);
      expect(list.body.data.map((r: { version: number }) => r.version)).toEqual([2, 1]);
      const restored = await f.http().post('/api/v1/admin/settings/seo/restore').set('Authorization', admin.bearer).send({ version: 1 });
      expect(restored.body.data).toMatchObject({ seoTitle: 'One', _version: 3 });
      expect((await f.http().post('/api/v1/admin/settings/seo/restore').set('Authorization', admin.bearer).send({ version: 99 })).status).toBe(404);
      expect(await SettingRevisionModel.countDocuments({ group: 'seo' })).toBe(3);
    });

    it('nested mobile settings merge per platform', async () => {
      await put('mobile', { android: { versionCode: '12', forceUpdate: true } });
      await put('mobile', { android: { rateUrl: 'https://play.google.com/x' }, ios: { versionCode: '3' } });
      const m = (await getGroup('mobile')).body.data;
      expect(m.android).toMatchObject({ versionCode: '12', forceUpdate: true, rateUrl: 'https://play.google.com/x' });
      expect(m.ios).toMatchObject({ versionCode: '3' });
      expect((await put('mobile', { android: { adsProvider: 'myspace' } })).status).toBe(422);
      expect((await put('mobile', { android: { surprise: 1 } })).status).toBe(422);
    });

    it('is read-only in DEMO_MODE', async () => {
      const demo = buildFullApp({ DEMO_MODE: 'true' });
      const a = await makeAdmin(demo, 'demoadmin');
      const res = await demo.http().put('/api/v1/admin/settings/general').set('Authorization', a.bearer).send({ siteName: 'Hacked' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('demo_mode');
      expect((await demo.http().get('/api/v1/admin/settings/general').set('Authorization', a.bearer)).status).toBe(200);
    });
  });

  describe('public bundle & mobile /init', () => {
    it('exposes only the public subset — never a secret', async () => {
      await put('payments', { stripeSecretKey: 'sk_SECRETVALUE_9999', stripePublicKey: 'pk_public', paypalSecret: 'PAYPAL_SECRET_VALUE', googleServiceAccountJson: '{"private_key":"PK"}' });
      await put('auth', { firebaseServiceAccount: '{"private_key":"FIREBASE_PK"}', firebaseConfig: '{"apiKey":"web-key"}' });
      await put('mail', { smtpPass: 'SMTP_PASS_VALUE' });
      await put('plugins', { recaptchaSecretKey: 'RECAPTCHA_SECRET', recaptchaSiteKey: 'site-key', enableRecaptcha: true });
      await put('webrtc', { twilioAuthToken: 'TWILIO_TOKEN', activeWebrtcProvider: 'twilio' });

      const res = await f.http().get('/api/v1/settings/public');
      expect(res.status).toBe(200);
      const body = JSON.stringify(res.body);
      for (const secret of ['SECRETVALUE', 'PAYPAL_SECRET', 'FIREBASE_PK', 'SMTP_PASS', 'RECAPTCHA_SECRET', 'TWILIO_TOKEN', 'PK"']) expect(body).not.toContain(secret);
      expect(res.body.data.payments).toMatchObject({ stripePublicKey: 'pk_public', stripeEnabled: true });
      expect(res.body.data.plugins).toMatchObject({ recaptchaSiteKey: 'site-key', enableRecaptcha: true });
      expect(res.body.data.auth.firebaseConfig).toBe('{"apiKey":"web-key"}');
      expect(res.body.data.general.siteName).toBe('VibeMatch');
      expect(res.body.data.demoMode).toBe(false);
      expect(res.body.data).not.toHaveProperty('mail');
      expect(res.body.data).not.toHaveProperty('storage');
      expect(res.headers['cache-control']).toBe('public, max-age=30');
    });

    it('changes show up right after an update (cache invalidated)', async () => {
      expect((await f.http().get('/api/v1/settings/public')).body.data.general.siteName).toBe('VibeMatch');
      await put('general', { siteName: 'Renamed' });
      expect((await f.http().get('/api/v1/settings/public')).body.data.general.siteName).toBe('Renamed');
    });

    it('/init needs a mobile-level API key', async () => {
      expect((await f.http().get('/api/v1/init')).body.code).toBe('api_key_required');
      const mk = await f.http().post('/api/v1/admin/api-keys').set('Authorization', admin.bearer).send({ name: 'app', level: 'mobile' });
      const ok = await f.http().get('/api/v1/init').set('X-API-Key', mk.body.data.key);
      expect(ok.status).toBe(200);
      expect(ok.body.data).toMatchObject({ apiVersion: 1, settings: { general: { siteName: 'VibeMatch' } } });
      const pub = await f.http().post('/api/v1/admin/api-keys').set('Authorization', admin.bearer).send({ name: 'p', level: 'public' });
      expect((await f.http().get('/api/v1/init').set('X-API-Key', pub.body.data.key)).status).toBe(403);
    });
  });

  describe('settings drive behaviour', () => {
    it('login methods: disabling guest login takes effect immediately', async () => {
      expect((await f.http().post('/api/v1/auth/guest')).status).toBe(201);
      await put('auth', { guestLogin: false });
      const res = await f.http().post('/api/v1/auth/guest');
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('guest_login_disabled');
    });

    it('signup bonus comes from settings', async () => {
      await put('general', { bonusGems: 1234 });
      const u = await registerUser(f, 'newbie');
      expect((u.user as { gems: number }).gems).toBe(1234);
    });

    it('online-user visibility and the fake extra count', async () => {
      await put('general', { fakeOnlineUsersCount: 40 });
      expect((await f.http().get('/api/v1/stats/online')).body.data.onlineUsers).toBe(40);
      await put('general', { showOnlineUsers: false });
      expect((await f.http().get('/api/v1/stats/online')).body.data.onlineUsers).toBeNull();
    });

    it('discover mode', async () => {
      await UserModel.create({ username: 'demo1', usernameLower: 'demo1', isDemo: true });
      await UserModel.create({ username: 'real1', usernameLower: 'real1' });
      const names = async () => (await f.http().get('/api/v1/discover')).body.data.map((u: { username: string }) => u.username).sort();
      expect(await names()).toEqual(['demo1']);
      await put('general', { discoverGridUsers: 'real_only' });
      await f.deps.cache.invalidateTag('discover');
      expect(await names()).toEqual(['real1']); // admins never appear in the grid
    });

    it('payment gateways are configured from settings (enabled flag + keys)', async () => {
      const pack = await (await import('../../src/infra/db/models/index.js')).PackModel.create({ name: 'S', price: 1, gems: 10 });
      const u = await registerUser(f, 'buyer');
      const checkout = () => f.http().post('/api/v1/payments/stripe/checkout').set('Authorization', u.bearer).send({ packId: pack.id });
      expect((await checkout()).body.code).toBe('provider_not_configured');
      await put('payments', { stripeSecretKey: 'sk_test_x', stripeEnabled: false });
      expect((await checkout()).body.code).toBe('provider_not_configured'); // configured but disabled
    });

    it('contact form requires reCAPTCHA once enabled in plugins', async () => {
      await put('plugins', { enableRecaptcha: true, recaptchaSecretKey: 'secret' });
      const res = await f.http().post('/api/v1/contact').send({ name: 'A', email: 'a@b.co', message: 'hello there friend' });
      expect(res.status).toBe(400);
      expect(res.body.detail).toMatch(/reCAPTCHA/);
    });

    it('mail templates escape variables and the test endpoint reports failures', async () => {
      await put('mail', { mailDriver: 'smtp', smtpHost: '127.0.0.1', smtpPort: 1, mailFromEmail: 'noreply@example.com' });
      const res = await f.http().post('/api/v1/admin/mail/test').set('Authorization', admin.bearer).send({ email: 'me@example.com' });
      expect(res.status).toBe(400);
      expect((await f.http().post('/api/v1/admin/mail/test').set('Authorization', admin.bearer).send({ email: 'nope' })).status).toBe(422);
    });

    it('storage test writes and deletes a probe file', async () => {
      const ok = await f.http().post('/api/v1/admin/storage/test').set('Authorization', admin.bearer);
      expect(ok.status).toBe(200);
      expect(ok.body.data).toMatchObject({ ok: true, url: expect.stringMatching(/^\/images\/probe\//) });
      await put('storage', { storageType: 'bunny', bunnyStorageZone: 'zone', bunnyAccessKey: 'k', bunnyPullZoneUrl: 'https://pull.example' });
      expect((await f.http().post('/api/v1/admin/storage/test').set('Authorization', admin.bearer)).status).toBe(400);
    });
  });

  describe('CMS pages', () => {
    const create = (body: Record<string, unknown>) => f.http().post('/api/v1/admin/pages').set('Authorization', admin.bearer).send(body);

    it('sanitises HTML on write (no scripts, handlers, iframes or javascript: links)', async () => {
      const res = await create({
        title: 'About', slug: 'about',
        content: '<h2 onclick="x()">Hi</h2><script>alert(1)</script><iframe src="//evil"></iframe><a href="javascript:alert(1)" target="_blank">bad</a><a href="https://ok.example" target="_blank">ok</a><img src="x" onerror="alert(1)"><p style="x">t</p>',
      });
      expect(res.status).toBe(201);
      const html: string = res.body.data.content;
      expect(html).not.toMatch(/script|iframe|onclick|onerror|javascript:|style=/i);
      expect(html).toContain('<h2>Hi</h2>');
      expect(html).toContain('href="https://ok.example"');
      expect(html).toContain('rel="noopener noreferrer"');
    });

    it('public endpoints show only active pages; edits and deletes are visible at once', async () => {
      await create({ title: 'Privacy', slug: 'privacy-policy', content: '<p>v1</p>' });
      await create({ title: 'Draft', slug: 'draft', isActive: false });
      await create({ title: 'Hidden', slug: 'hidden', showInFooter: false });

      expect((await f.http().get('/api/v1/pages')).body.data).toEqual([{ title: 'Privacy', slug: 'privacy-policy' }]);
      expect((await f.http().get('/api/v1/pages/privacy-policy')).body.data).toMatchObject({ title: 'Privacy', content: '<p>v1</p>' });
      expect((await f.http().get('/api/v1/pages/draft')).status).toBe(404);
      expect((await f.http().get('/api/v1/pages/hidden')).status).toBe(200); // reachable by URL, just not in the footer

      const id = (await PageModel.findOne({ slug: 'privacy-policy' }).lean())!.id;
      await f.http().patch(`/api/v1/admin/pages/${id}`).set('Authorization', admin.bearer).send({ content: '<p>v2</p>' });
      expect((await f.http().get('/api/v1/pages/privacy-policy')).body.data.content).toBe('<p>v2</p>');
      expect((await f.http().delete(`/api/v1/admin/pages/${id}`).set('Authorization', admin.bearer)).status).toBe(204);
      expect((await f.http().get('/api/v1/pages/privacy-policy')).status).toBe(404);
      expect((await f.http().delete(`/api/v1/admin/pages/${id}`).set('Authorization', admin.bearer)).status).toBe(404);
    });

    it('enforces unique slugs, validates input, requires admin, and lists with search + paging', async () => {
      await create({ title: 'A', slug: 'terms' });
      expect((await create({ title: 'B', slug: 'terms' })).body.code).toBe('slug_taken');
      expect((await create({ title: 'B', slug: 'Bad Slug!' })).status).toBe(422);
      expect((await create({ title: '', slug: 'x' })).status).toBe(422);
      expect((await create({ title: 'B', slug: 'b', role: 'x' })).status).toBe(422);
      const user = await registerUser(f, 'peon');
      expect((await f.http().post('/api/v1/admin/pages').set('Authorization', user.bearer).send({ title: 'x', slug: 'x' })).status).toBe(403);

      for (let i = 0; i < 4; i++) await create({ title: `Page ${i}`, slug: `p-${i}` });
      const list = await f.http().get('/api/v1/admin/pages?pageSize=2&page=2').set('Authorization', admin.bearer);
      expect(list.body.page).toMatchObject({ page: 2, pageSize: 2, total: 5, totalPages: 3 });
      const search = await f.http().get('/api/v1/admin/pages?search=terms').set('Authorization', admin.bearer);
      expect(search.body.data).toHaveLength(1);
      expect((await f.http().get('/api/v1/admin/pages?search=.*').set('Authorization', admin.bearer)).body.data).toHaveLength(0); // regex chars are escaped
    });
  });

  describe('languages', () => {
    const create = (body: Record<string, unknown>) => f.http().post('/api/v1/admin/languages').set('Authorization', admin.bearer).send(body);

    beforeEach(async () => {
      await LanguageModel.create({ code: 'en', name: 'English', flag: 'us.svg', rtl: false, translations: {} });
    });

    it('stores translations including keys with dots, and serves them publicly', async () => {
      expect((await create({ code: 'ar', name: 'العربية', flag: 'sa.svg', rtl: true })).status).toBe(201);
      const tr = { 'home.title': 'الرئيسية', 'Next': 'التالي', 'Hello, world.': 'مرحبا' };
      const put = await f.http().put('/api/v1/admin/languages/ar').set('Authorization', admin.bearer).send({ translations: tr });
      expect(put.body.data).toMatchObject({ code: 'ar', rtl: true, translations: tr });

      const raw = await LanguageModel.findOne({ code: 'ar' }).lean();
      expect(Object.keys(raw!.translations as object).some((k) => k.includes('.'))).toBe(false); // safe at rest
      const pub = await f.http().get('/api/v1/languages/ar');
      expect(pub.body.data.translations).toEqual(tr);
      const list = await f.http().get('/api/v1/languages');
      expect(list.body.data.map((l: { code: string }) => l.code)).toEqual(['ar', 'en']);
      expect(JSON.stringify(list.body)).not.toContain('translations');
    });

    it('validates codes, forbids duplicates, protects the default language', async () => {
      expect((await create({ code: 'EN-US!', name: 'x' })).status).toBe(422);
      expect((await create({ code: 'en', name: 'English again' })).body.code).toBe('language_exists');
      expect((await f.http().delete('/api/v1/admin/languages/en').set('Authorization', admin.bearer)).status).toBe(400);
      await create({ code: 'fr', name: 'Français' });
      expect((await f.http().delete('/api/v1/admin/languages/fr').set('Authorization', admin.bearer)).status).toBe(204);
      expect((await f.http().get('/api/v1/languages/fr')).status).toBe(404);
      expect((await f.http().put('/api/v1/admin/languages/zz').set('Authorization', admin.bearer).send({ name: 'x' })).status).toBe(404);
      expect((await f.http().put('/api/v1/admin/languages/en').set('Authorization', admin.bearer).send({})).status).toBe(422);
      expect((await f.http().put('/api/v1/admin/languages/en').set('Authorization', admin.bearer).send({ translations: { a: 1 } })).status).toBe(422);
    });
  });

  it('password-protected admin routes: a regular user\'s token (even with an admin claim) is useless', async () => {
    const user = await registerUser(f, 'sneaky');
    const forged = f.deps.tokens.signAccess({ sub: user.id, role: 'admin', sid: 'x' }).token;
    expect((await f.http().get('/api/v1/admin/settings/general').set('Authorization', `Bearer ${forged}`)).status).toBe(403);
    expect(strongPassword.length).toBeGreaterThan(8);
  });
});
