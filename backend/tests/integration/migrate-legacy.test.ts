import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SecretBox } from '../../src/core/security/crypto.js';
import {
  ConversationModel, FollowModel, GemLedgerModel, LanguageModel, MatchModel, MessageModel, PackModel, PageModel, PurchaseModel,
  SettingModel, UserModel, syncIndexes,
} from '../../src/infra/db/models/index.js';
import { cleanUsername, mapProvider, mapSettings, migrateLegacy, parseDuration } from '../../src/migration/legacy.js';
import { buildFullApp } from '../helpers/full-app.js';
import { clearTestDb, startTestDb, stopTestDb } from '../helpers/mongo.js';

describe('legacy (v1) → v2 migration', () => {
  const box = new SecretBox(Buffer.alloc(32, 7).toString('base64'));
  let legacy: mongoose.mongo.Db;
  const oldHash = bcrypt.hashSync('Old-Password-1', 4);

  beforeAll(async () => {
    await startTestDb();
    await syncIndexes();
    legacy = mongoose.connection.useDb('legacy_v1').db!;
  });
  afterAll(stopTestDb);
  beforeEach(async () => {
    await clearTestDb();
    await legacy.dropDatabase();
    await seedLegacy();
  });

  async function seedLegacy() {
    const day = new Date('2026-01-01T10:00:00Z');
    await legacy.collection('users').insertMany([
      { id: 'u1', username: 'alice', name: 'Alice', email: 'Alice@Example.com', passwordHash: oldHash, avatar: '/images/avatars/female-1.svg', gender: 'female', country: 'France', countryCode: 'FR', age: 25, gems: 120, likesCount: 4, bio: 'hi', followers: ['u2'], following: ['u2', 'ghost'], isOnline: true, role: 'user', createdAt: day, fcmToken: 'tok-1' },
      { id: 'u2', username: 'bob smith!', name: 'Bob', email: 'alice@example.com', passwordHash: oldHash, gender: 'attack-helicopter', gems: 0, followers: ['u1'], following: ['u1'], isBanned: true, role: 'user', vipExpiry: new Date('2030-01-01') },
      { id: 'guest_abc1234', username: 'guest_abc1234', name: 'Guest abc12', email: 'guest_abc1234@guest.vibematch.com', gems: 250, role: 'user' },
      { id: 'demo_x', username: 'demo_x', name: 'Demo X', isDemo: true, videoUrl: '/videos/x.mp4', gems: 0, role: 'user' },
      { id: 'u3', username: 'Alice', name: 'Second Alice', gems: 5, role: 'user' }, // username collides with u1 after lower-casing
      { id: 'adm1', username: 'owner', role: 'admin', passwordHash: oldHash, gems: 999999 },
    ]);
    await legacy.collection('admins').insertMany([
      { id: 'demo_admin', username: 'demo', passwordHash: bcrypt.hashSync('demo123', 4), role: 'admin' },
      { id: 'adm2', username: 'second_admin', passwordHash: oldHash, email: 'second@example.com', role: 'admin' },
    ]);
    await legacy.collection('gifts').insertOne({ id: 'g1', name: 'Rose', price: 40, imagePath: '/images/gift/rose.svg' });
    await legacy.collection('packs').insertOne({ id: 'pk1', name: 'Starter', price: 4.99, gems: 500, googlePayId: 'gems_500', popular: true });
    await legacy.collection('vipplans').insertOne({ id: 'v1', name: 'Month', priceGems: 500, durationDays: 30 });
    await legacy.collection('pages').insertMany([{ title: 'About', slug: 'about', content: '<p>x</p>', showInFooter: true, isActive: true }, { title: 'Bad', slug: 'Bad Slug!', content: '' }]);
    await legacy.collection('notifications').insertOne({ id: 'n1', userId: 'u2', fromUserId: 'u1', fromUserName: 'Alice', fromUserUsername: 'alice', type: 'follow', isRead: false, timestamp: new Date('2026-02-01') });
    await legacy.collection('reports').insertMany([{ id: 'r1', reporterId: 'guest', reportedUserId: 'u1', reason: 'spam', status: 'pending', timestamp: day }, { id: 'r2', reason: 'no target' }]);
    await legacy.collection('contactmessages').insertOne({ id: 'c1', name: 'Zed', email: 'zed@example.com', message: 'hello there', status: 'unread', timestamp: day });
    await legacy.collection('histories').insertMany([
      { id: 'h1', userId: 'u1', partnerId: 'u2', partnerName: 'Bob', partnerUsername: 'bob', type: 'video_chat', duration: '02:05', timestamp: day },
      { id: 'h2', userId: 'u2', partnerId: 'u1', partnerName: 'Alice', type: 'viewed_me', timestamp: day },
    ]);
    await legacy.collection('messages').insertMany([
      { id: 'm1', senderId: 'u1', receiverId: 'u2', text: 'hello', isRead: true, timestamp: new Date('2026-03-01T10:00:00Z') },
      { id: 'm2', senderId: 'u2', receiverId: 'u1', text: 'hi!', isRead: false, timestamp: new Date('2026-03-01T10:05:00Z') },
      { id: 'm3', senderId: 'u1', receiverId: 'u2', text: 'gift', isGift: true, giftType: 'Rose', giftAmount: 40, isRead: false, timestamp: new Date('2026-03-02T10:00:00Z') },
      { id: 'm4', senderId: 'u1', receiverId: 'u1', text: 'to myself' },
    ]);
    await legacy.collection('purchases').insertMany([
      { id: 'cs_test_1', userId: 'u1', username: 'alice', packId: 'pk1', packName: 'Starter', price: 4.99, paymentMethod: 'stripe', createdAt: day },
      { id: 'GPA.1', userId: 'u1', packId: 'pk1', price: 4.99, paymentMethod: 'google_in_app_purchase', receiptHash: 'abc' },
      { id: 'weird', userId: 'u1', packId: 'pk1', price: 1, paymentMethod: 'bitcoin' },
    ]);
    await legacy.collection('settings').insertMany([
      {
        type: 'admin_settings', siteName: 'Old Site', siteUrl: 'https://old.example', bonusGems: '350', discoverGridUsers: 'real_only', showOnlineUsers: false, fakeOnlineUsersCount: 12,
        guestLogin: false, googleLogin: true, firebaseConfig: '{"apiKey":"k"}', firebaseServiceAccount: '{"private_key":"PK"}',
        smtpHost: 'smtp.old', smtpPort: '2525', smtpPass: 'SMTPPW', mailDriver: 'smtp', stripeSecretKey: 'sk_live_OLD', stripePublicKey: 'pk_live_OLD', paypalSecret: 'PPSECRET',
        enableRecaptcha: true, recaptchaSecretKey: 'RCSECRET', activeWebrtcProvider: 'twilio', twilioAccountSid: 'AC1', twilioAuthToken: 'TWTOKEN',
        androidAdsEnabled: true, androidAdsProvider: 'google', androidAdmobAppId: 'ca-app-pub-1', iosVersionCode: '3', mobileApiAccessKey: 'legacy-key', licenseKey: 'LIC', gcpPrivateKey: 'GCPPK',
      },
      { type: 'language', code: 'en', name: 'English', flag: 'us.svg', rtl: false, translations: { 'home.title': 'Home', Next: 'Next', bad: 5 } },
      { type: 'language', code: 'ar', name: 'Arabic', rtl: true, translations: {} },
    ]);
  }

  const run = (apply: boolean, extra: { keepDemoAdmin?: boolean } = {}) => migrateLegacy({ source: legacy, apply, secretBox: box, ...extra });

  describe('helpers', () => {
    it('parses durations, providers and usernames', () => {
      expect(parseDuration('02:05')).toBe(125);
      expect(parseDuration('01:02:03')).toBe(3723);
      expect(parseDuration(42.4)).toBe(42);
      expect(parseDuration('x:y')).toBe(0);
      expect(parseDuration(undefined)).toBe(0);
      expect(mapProvider('apple_in_app_purchase')).toBe('apple');
      expect(mapProvider('Google_In_App')).toBe('google');
      expect(mapProvider('cash')).toBeNull();
      const taken = new Set<string>();
      expect(cleanUsername('Bob Smith!', taken)).toBe('bob_smith_');
      expect(cleanUsername('bob smith!', taken)).toBe('bob_smith__1');
      expect(cleanUsername('a', taken)).toMatch(/^a_user/);
      expect(cleanUsername('x'.repeat(40), new Set())).toHaveLength(20);
    });

    it('maps flat v1 settings into groups, converts types, encrypts secrets and reports what it dropped', () => {
      const { groups, dropped } = mapSettings({ siteName: 'S', bonusGems: '350', smtpPort: '2525', stripeSecretKey: 'sk', androidAdsEnabled: true, iosVersionCode: '3', licenseKey: 'x', type: 'admin_settings' }, box);
      expect(groups.general).toMatchObject({ siteName: 'S', bonusGems: 350 });
      expect(groups.mail).toMatchObject({ smtpPort: 2525 });
      expect(SecretBox.isEncrypted(groups.payments!.stripeSecretKey)).toBe(true);
      expect(groups.mobile).toEqual({ android: { adsEnabled: true }, ios: { versionCode: '3' } });
      expect(dropped).toEqual(['licenseKey']);
    });
  });

  it('dry run reads and counts everything but writes nothing', async () => {
    const report = await run(false);
    expect(report.apply).toBe(false);
    expect(report.counts.users).toMatchObject({ read: 6, written: 7 }); // 6 users + 1 migrated admin; "written" = would be written
    expect(await UserModel.countDocuments()).toBe(0);
    expect(await MessageModel.countDocuments()).toBe(0);
    expect(await SettingModel.countDocuments()).toBe(0);
  });

  it('migrates users: ids kept, passwords still work, usernames repaired, bad data neutralised', async () => {
    const report = await run(true);
    expect(await UserModel.countDocuments()).toBe(7); // 6 users + second_admin (demo admin skipped)
    const alice = await UserModel.findOne({ id: 'u1' }).select('+passwordHash').lean();
    expect(alice).toMatchObject({ username: 'alice', email: 'Alice@Example.com', emailLower: 'alice@example.com', role: 'user', gems: 120, fcmTokens: ['tok-1'], isOnline: false });
    expect(await bcrypt.compare('Old-Password-1', alice!.passwordHash!)).toBe(true);

    const bob = await UserModel.findOne({ id: 'u2' }).lean();
    expect(bob).toMatchObject({ username: 'bob_smith_', gender: '', isBanned: true });
    expect(bob).not.toHaveProperty('email'); // duplicate e-mail dropped
    expect(bob!.vipExpiry!.getFullYear()).toBe(2030);

    expect((await UserModel.findOne({ id: 'u3' }).lean())!.username).toBe('alice_1'); // collision resolved
    expect((await UserModel.findOne({ id: 'guest_abc1234' }).lean())).toMatchObject({ role: 'guest' });
    expect((await UserModel.findOne({ id: 'guest_abc1234' }).lean())).not.toHaveProperty('email');
    expect((await UserModel.findOne({ id: 'demo_x' }).lean())).toMatchObject({ isDemo: true, videoUrl: '/videos/x.mp4' });
    expect((await UserModel.find({ role: 'admin' }).lean()).map((a) => a.username).sort()).toEqual(['owner', 'second_admin']);
    expect(report.warnings.join('\n')).toMatch(/demo admin/);
    expect(report.warnings.join('\n')).toMatch(/duplicate e-mail/);

    // the v1 demo admin can be kept explicitly
    await clearTestDb();
    await run(true, { keepDemoAdmin: true });
    expect(await UserModel.countDocuments({ username: 'demo', role: 'admin' })).toBe(1);
  });

  it('turns follower arrays into edges with correct counters, ignoring dangling ids and self-follows', async () => {
    await run(true);
    expect(await FollowModel.countDocuments()).toBe(2); // u1→u2 and u2→u1 (deduplicated from both arrays); "ghost" dropped
    expect(await UserModel.findOne({ id: 'u1' }).lean()).toMatchObject({ followersCount: 1, followingCount: 1 });
    expect(await UserModel.findOne({ id: 'u2' }).lean()).toMatchObject({ followersCount: 1, followingCount: 1 });
  });

  it('creates ledger opening balances so the ledger sums to every balance', async () => {
    await run(true);
    const rows = await GemLedgerModel.aggregate<{ _id: string; sum: number }>([{ $group: { _id: '$userId', sum: { $sum: '$delta' } } }]);
    const users = await UserModel.find({ gems: { $gt: 0 } }).lean();
    expect(rows).toHaveLength(users.length);
    for (const u of users) expect(rows.find((r) => r._id === u.id)?.sum).toBe(u.gems);
  });

  it('migrates catalogue, pages (invalid slug skipped), social data, history and rebuilds conversations', async () => {
    const report = await run(true);
    expect(await PackModel.findOne({ id: 'pk1' }).lean()).toMatchObject({ gems: 500, googlePayId: 'gems_500', popular: true });
    expect(await PageModel.countDocuments()).toBe(1);
    expect(report.counts.pages).toMatchObject({ read: 2, skipped: 1 });
    expect(report.counts.reports).toMatchObject({ skipped: 1 });

    const hist = await MatchModel.find().sort({ id: 1 }).lean();
    expect(hist.map((h) => [h.type, h.durationSec])).toEqual([['video_chat', 125], ['view', 0]]);

    expect(await MessageModel.countDocuments()).toBe(3); // self-message dropped
    const gift = await MessageModel.findOne({ id: 'm3' }).lean();
    expect(gift).toMatchObject({ conversationKey: 'u1:u2', gift: { name: 'Rose', cost: 40 } });
    const conv = await ConversationModel.findOne({ key: 'u1:u2' }).lean();
    expect(conv).toMatchObject({ participants: ['u1', 'u2'], lastMessage: { id: 'm3', isGift: true }, unread: { u1: 1, u2: 1 } });
    expect(conv!.lastMessageAt.toISOString()).toBe('2026-03-02T10:00:00.000Z');
  });

  it('migrates purchases with the right provider, keeps replay protection, skips unknown methods', async () => {
    const report = await run(true);
    expect(await PurchaseModel.countDocuments()).toBe(2);
    expect(await PurchaseModel.findOne({ provider: 'stripe', providerTxnId: 'cs_test_1' }).lean()).toMatchObject({ userId: 'u1', gems: 500, amount: 4.99, status: 'completed' });
    expect(await PurchaseModel.findOne({ provider: 'google' }).lean()).toMatchObject({ receiptHash: 'abc' });
    expect(report.warnings.join('\n')).toMatch(/bitcoin/);
  });

  it('migrates settings into encrypted groups and languages with dotted keys preserved', async () => {
    const report = await run(true);
    f = buildFullApp();
    const s = f.services.settings;
    expect(await s.get('general')).toMatchObject({ siteName: 'Old Site', bonusGems: 350, discoverGridUsers: 'real_only', showOnlineUsers: false, fakeOnlineUsersCount: 12 });
    expect(await s.get('auth')).toMatchObject({ guestLogin: false, firebaseConfig: '{"apiKey":"k"}' });
    expect((await s.get('auth')).firebaseServiceAccount).toBe('{"private_key":"PK"}');
    expect(await s.get('mail')).toMatchObject({ smtpHost: 'smtp.old', smtpPort: 2525, smtpPass: 'SMTPPW', mailDriver: 'smtp' });
    expect(await s.get('payments')).toMatchObject({ stripePublicKey: 'pk_live_OLD', stripeSecretKey: 'sk_live_OLD', paypalSecret: 'PPSECRET' });
    expect(await s.get('plugins')).toMatchObject({ enableRecaptcha: true, recaptchaSecretKey: 'RCSECRET' });
    expect(await s.get('webrtc')).toMatchObject({ activeWebrtcProvider: 'twilio', twilioAuthToken: 'TWTOKEN' });
    expect((await s.get('mobile')).android).toMatchObject({ adsEnabled: true, adsProvider: 'google', admobAppId: 'ca-app-pub-1' });
    // secrets are encrypted in the database
    const stored = JSON.stringify((await SettingModel.find().lean()).map((x) => x.data));
    for (const plain of ['sk_live_OLD', 'SMTPPW', 'PPSECRET', 'RCSECRET', 'TWTOKEN']) expect(stored).not.toContain(plain);
    expect(report.warnings.join('\n')).toMatch(/mobileApiAccessKey/);
    expect(report.warnings.join('\n')).toMatch(/licenseKey.*gcpPrivateKey|gcpPrivateKey.*licenseKey/);

    const en = await LanguageModel.findOne({ code: 'en' }).lean();
    expect(en!.translations).toEqual({ 'home．title': 'Home', Next: 'Next' }); // non-string values dropped
    expect(await LanguageModel.countDocuments()).toBe(2);
  });

  it('is re-runnable: a second run changes nothing and creates no duplicates', async () => {
    await run(true);
    const counts = async () => ({
      users: await UserModel.countDocuments(), follows: await FollowModel.countDocuments(), messages: await MessageModel.countDocuments(),
      purchases: await PurchaseModel.countDocuments(), ledger: await GemLedgerModel.countDocuments(), settings: await SettingModel.countDocuments(),
      convs: await ConversationModel.countDocuments(),
    });
    const first = await counts();
    await run(true);
    expect(await counts()).toEqual(first);
  });

  it('an empty or partial v1 database migrates without errors', async () => {
    await legacy.dropDatabase();
    const report = await run(true);
    expect(report.counts).toEqual({});
    await legacy.collection('users').insertOne({ id: 'only', username: 'only_user' });
    expect((await run(true)).counts.users).toMatchObject({ read: 1 });
  });

  it('migrated users can log in through the real v2 API with their old password', async () => {
    await run(true);
    const login = await buildFullApp().http().post('/api/v1/auth/login').send({ identifier: 'alice', password: 'Old-Password-1' });
    expect(login.status).toBe(200);
    expect(login.body.data.user).toMatchObject({ id: 'u1', gems: 120 });
    expect((await buildFullApp().http().post('/api/v1/auth/login').send({ identifier: 'owner', password: 'Old-Password-1' })).body.data.user.role).toBe('admin');
  });
});

let f: ReturnType<typeof buildFullApp>;
