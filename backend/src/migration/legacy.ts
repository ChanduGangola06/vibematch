import type { mongo } from 'mongoose';
import type { SecretBox } from '../core/security/crypto.js';
import type { PURCHASE_PROVIDERS } from '../infra/db/models/commerce.js';
import { GemLedgerModel, GiftModel, PackModel, PurchaseModel, VipPlanModel } from '../infra/db/models/commerce.js';
import { LanguageModel, PageModel, SettingModel } from '../infra/db/models/content.js';
import {
  ContactMessageModel, ConversationModel, FollowModel, MatchModel, MessageModel, NotificationModel, ReportModel,
} from '../infra/db/models/social.js';
import { UserModel } from '../infra/db/models/user.js';
import { GROUPS, GROUP_NAMES } from '../modules/settings/settings.groups.js';
import { conversationKey } from '../modules/chat/chat.service.js';
import { USERNAME_RE } from '../modules/users/user.schemas.js';

type Db = mongo.Db;
type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface MigrationOptions {
  /** Read-only handle on the v1 database. */
  source: Db;
  /** false = dry run: read, map, validate and count, but write nothing. */
  apply: boolean;
  secretBox?: SecretBox | undefined;
  /** Keep the v1 demo admin account (`demo`/`demo123`). Off by default: it ships with a published password. */
  keepDemoAdmin?: boolean;
}

export interface MigrationReport {
  apply: boolean;
  counts: Record<string, { read: number; written: number; skipped: number }>;
  warnings: string[];
}

const GENDERS = new Set(['male', 'female', 'other']);
const iso = (v: unknown): Date | undefined => {
  const d = v ? new Date(v as string) : undefined;
  return d && !Number.isNaN(d.getTime()) ? d : undefined;
};
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number.isFinite(Number(v)) ? Number(v) : fallback);

/** Legacy "mm:ss" or "hh:mm:ss" → seconds. */
export function parseDuration(s: unknown): number {
  if (typeof s === 'number') return Math.max(0, Math.round(s));
  const parts = String(s ?? '').split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/** v1 usernames were free text lower-cased with illegal characters replaced; make them satisfy the v2 rules. */
export function cleanUsername(raw: string, taken: Set<string>): string {
  let u = raw.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 20);
  if (u.length < 3) u = `${u}_user`.slice(0, 20);
  let candidate = u;
  for (let i = 1; taken.has(candidate) || !USERNAME_RE.test(candidate); i++) candidate = `${u.slice(0, 16)}_${i}`.slice(0, 20);
  taken.add(candidate);
  return candidate;
}

export function mapProvider(method: unknown): (typeof PURCHASE_PROVIDERS)[number] | null {
  const m = String(method ?? '').toLowerCase();
  if (m.includes('stripe')) return 'stripe';
  if (m.includes('paypal')) return 'paypal';
  if (m.includes('razorpay')) return 'razorpay';
  if (m.includes('google')) return 'google';
  if (m.includes('apple')) return 'apple';
  return null;
}

/** Flat v1 settings document → v2 groups. */
export function mapSettings(legacy: Doc, box?: SecretBox): { groups: Record<string, Record<string, unknown>>; dropped: string[] } {
  const groups: Record<string, Record<string, unknown>> = {};
  const used = new Set<string>(['_id', '__v', 'type']);
  const enc = (v: string) => (box && v ? box.encrypt(v) : v);

  for (const name of GROUP_NAMES) {
    const def = GROUPS[name];
    if (name === 'mobile') continue;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(def.schema.shape)) {
      const alias = key === 'paypalEnv' ? undefined : key;
      if (!alias || legacy[alias] === undefined || legacy[alias] === null) continue;
      used.add(alias);
      let v: unknown = legacy[alias];
      const shape = (def.schema.shape as Record<string, { _zod?: { def?: { type?: string } } }>)[key];
      const type = shape?._zod?.def?.type;
      if (type === 'number') v = num(v);
      else if (type === 'boolean') v = Boolean(v);
      else if (typeof v !== 'string' && type === 'string') v = String(v);
      out[key] = (def.secrets as readonly string[]).includes(key) ? enc(String(v)) : v;
    }
    if (Object.keys(out).length) groups[name] = out;
  }

  // legacy: androidAdsEnabled, iosAdmobAppId … → mobile.{android,ios}.{adsEnabled,admobAppId …}
  const mobile: Record<string, Record<string, unknown>> = { android: {}, ios: {} };
  for (const platform of ['android', 'ios'] as const) {
    for (const [k, v] of Object.entries(legacy)) {
      if (!k.startsWith(platform) || k.length === platform.length) continue;
      const field = k[platform.length]!.toLowerCase() + k.slice(platform.length + 1);
      if (field in (GROUPS.mobile.schema.shape.android as unknown as { shape: Record<string, unknown> }).shape) {
        mobile[platform]![field] = v;
        used.add(k);
      }
    }
  }
  if (Object.keys(mobile.android!).length || Object.keys(mobile.ios!).length) groups.mobile = mobile;

  return { groups, dropped: Object.keys(legacy).filter((k) => !used.has(k)) };
}

/**
 * v1 → v2 data migration. Reads the old database through a plain driver handle and writes through the
 * v2 models (so every row is validated by the same schemas the API uses). Re-runnable: rows are upserted
 * by their natural id, nothing is deleted, and a dry run (the default in the CLI) writes nothing.
 */
export async function migrateLegacy(opts: MigrationOptions): Promise<MigrationReport> {
  const { source, apply } = opts;
  const report: MigrationReport = { apply, counts: {}, warnings: [] };
  const warn = (m: string) => report.warnings.length < 200 && report.warnings.push(m);
  const stat = (name: string) => (report.counts[name] ??= { read: 0, written: 0, skipped: 0 });
  const col = (name: string) => source.collection(name);
  const exists = async (name: string) => (await source.listCollections({ name }).toArray()).length > 0;
  const upsert = async (model: { updateOne: (...a: any[]) => Promise<unknown> }, name: string, filter: Doc, doc: Doc) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const s = stat(name);
    if (apply) await model.updateOne(filter, { $set: doc }, { upsert: true, timestamps: false, overwriteImmutable: true });
    s.written++;
  };

  // ---- users + admins ---------------------------------------------------------------------------
  const takenUsernames = new Set<string>();
  const takenEmails = new Set<string>();
  const idToUsername = new Map<string, string>();
  const userDocs: Doc[] = [];
  if (await exists('users')) userDocs.push(...(await col('users').find({}).toArray()));
  const admins: Doc[] = (await exists('admins')) ? await col('admins').find({}).toArray() : [];

  const baseUser = (u: Doc, role: 'user' | 'admin' | 'guest'): Doc => {
    const username = cleanUsername(String(u.username ?? u.id ?? 'user'), takenUsernames);
    if (username !== String(u.username ?? '').toLowerCase()) warn(`user ${u.id}: username "${u.username}" became "${username}"`);
    const email = typeof u.email === 'string' && u.email.includes('@') ? u.email.trim() : undefined;
    let usableEmail = email;
    if (email) {
      if (takenEmails.has(email.toLowerCase()) || /@guest\./.test(email)) {
        if (!/@guest\./.test(email)) warn(`user ${u.id}: duplicate e-mail ${email} dropped`);
        usableEmail = undefined;
      } else takenEmails.add(email.toLowerCase());
    }
    return {
      id: String(u.id ?? u._id), username, usernameLower: username, name: u.name ?? '', ...(usableEmail ? { email: usableEmail, emailLower: usableEmail.toLowerCase() } : {}),
      ...(u.passwordHash ? { passwordHash: u.passwordHash } : {}), role,
      avatar: u.avatar ?? '', gender: GENDERS.has(u.gender) ? u.gender : '', country: u.country ?? '', countryCode: u.countryCode ?? '',
      ...(u.age >= 13 && u.age <= 120 ? { age: u.age } : {}), bio: String(u.bio ?? '').slice(0, 500), phone: u.phone ?? '', address: u.address ?? '',
      gems: Math.max(0, num(u.gems)), likesCount: Math.max(0, num(u.likesCount)), followersCount: 0, followingCount: 0,
      ...(iso(u.vipExpiry) ? { vipExpiry: iso(u.vipExpiry) } : {}), isBanned: Boolean(u.isBanned), isDemo: Boolean(u.isDemo), isOnline: false,
      videoUrl: u.videoUrl ?? '', fcmTokens: u.fcmToken ? [String(u.fcmToken)] : [],
      createdAt: iso(u.createdAt) ?? new Date(), updatedAt: new Date(),
    };
  };

  const migratedUsers: Doc[] = [];
  for (const u of userDocs) {
    stat('users').read++;
    const isGuest = /^guest_/.test(String(u.username ?? ''));
    const doc = baseUser(u, u.role === 'admin' ? 'admin' : isGuest ? 'guest' : 'user');
    migratedUsers.push(doc);
    idToUsername.set(doc.id, doc.username);
  }
  for (const a of admins) {
    stat('admins').read++;
    if (a.username === 'demo' && !opts.keepDemoAdmin) {
      stat('admins').skipped++;
      warn('v1 demo admin ("demo"/"demo123") not migrated — it uses a published password');
      continue;
    }
    if (migratedUsers.some((m) => m.id === String(a.id ?? a._id))) { stat('admins').skipped++; continue; }
    migratedUsers.push(baseUser(a, 'admin'));
  }
  for (const doc of migratedUsers) await upsert(UserModel, 'users', { id: doc.id }, doc);

  // ---- follow graph (arrays on users → edges) -----------------------------------------------------
  const knownIds = new Set(migratedUsers.map((m) => m.id));
  const followCounts = new Map<string, { followers: number; following: number }>();
  const bump = (id: string, k: 'followers' | 'following') => {
    const c = followCounts.get(id) ?? { followers: 0, following: 0 };
    c[k]++;
    followCounts.set(id, c);
  };
  const edges = new Set<string>();
  for (const u of userDocs) {
    for (const target of (u.following ?? []) as string[]) {
      if (!knownIds.has(target) || target === u.id) continue;
      edges.add(`${u.id}>${target}`);
    }
    for (const follower of (u.followers ?? []) as string[]) {
      if (!knownIds.has(follower) || follower === u.id) continue;
      edges.add(`${follower}>${u.id}`);
    }
  }
  for (const e of edges) {
    const [followerId, followeeId] = e.split('>') as [string, string];
    stat('follows').read++;
    await upsert(FollowModel, 'follows', { followerId, followeeId }, { followerId, followeeId });
    bump(followeeId, 'followers');
    bump(followerId, 'following');
  }
  if (apply) {
    for (const [id, c] of followCounts) await UserModel.updateOne({ id }, { $set: { followersCount: c.followers, followingCount: c.following } }, { timestamps: false });
  }

  // ---- gem ledger opening balances ----------------------------------------------------------------
  for (const u of migratedUsers.filter((m) => m.gems > 0)) {
    await upsert(GemLedgerModel, 'gemLedger', { refType: 'migration', refId: u.id, reason: 'admin_adjust' }, {
      userId: u.id, delta: u.gems, balanceAfter: u.gems, reason: 'admin_adjust', refType: 'migration', refId: u.id, createdAt: new Date(),
    });
  }

  // ---- catalogue ------------------------------------------------------------------------------------
  const simple = async (legacyName: string, name: string, model: any, map: (d: Doc) => Doc | null, key: (d: Doc) => Doc) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!(await exists(legacyName))) return;
    for (const d of await col(legacyName).find({}).toArray()) {
      stat(name).read++;
      const doc = map(d);
      if (!doc) { stat(name).skipped++; continue; }
      await upsert(model, name, key(doc), doc);
    }
  };
  await simple('gifts', 'gifts', GiftModel, (d) => ({ id: String(d.id ?? d._id), name: d.name, price: Math.max(0, num(d.price)), imagePath: d.imagePath ?? '', createdAt: iso(d.createdAt) ?? new Date() }), (d) => ({ id: d.id }));
  await simple('packs', 'packs', PackModel, (d) => ({
    id: String(d.id ?? d._id), name: d.name, description: d.description ?? '', price: Math.max(0, num(d.price)), gems: Math.max(1, Math.round(num(d.gems, 1))), popular: Boolean(d.popular),
    ...(d.googlePayId ? { googlePayId: d.googlePayId } : {}), ...(d.applePayId ? { applePayId: d.applePayId } : {}), createdAt: iso(d.createdAt) ?? new Date(),
  }), (d) => ({ id: d.id }));
  await simple('vipplans', 'vipPlans', VipPlanModel, (d) => ({
    id: String(d.id ?? d._id), name: d.name, description: d.description ?? '', priceGems: Math.max(0, Math.round(num(d.priceGems))), durationDays: Math.max(1, Math.round(num(d.durationDays, 30))), popular: Boolean(d.popular), createdAt: iso(d.createdAt) ?? new Date(),
  }), (d) => ({ id: d.id }));
  await simple('pages', 'pages', PageModel, (d) => (/^[a-z0-9-]{1,80}$/.test(String(d.slug ?? '').toLowerCase()) ? {
    id: `page_${String(d._id)}`, title: d.title, slug: String(d.slug).toLowerCase(), content: d.content ?? '', showInFooter: d.showInFooter !== false, isActive: d.isActive !== false, createdAt: iso(d.createdAt) ?? new Date(),
  } : null), (d) => ({ slug: d.slug }));

  // ---- social data ----------------------------------------------------------------------------------
  await simple('notifications', 'notifications', NotificationModel, (d) => ({
    id: String(d.id ?? d._id), userId: d.userId, type: d.type === 'follow' ? 'follow' : 'system', fromUserId: d.fromUserId, fromUserName: d.fromUserName,
    fromUserUsername: d.fromUserUsername, fromUserAvatar: d.fromUserAvatar, isRead: Boolean(d.isRead), createdAt: iso(d.timestamp) ?? new Date(),
  }), (d) => ({ id: d.id }));
  await simple('reports', 'reports', ReportModel, (d) => (d.reportedUserId ? {
    id: String(d.id ?? d._id), reporterId: d.reporterId ?? 'guest', reportedUserId: d.reportedUserId, reason: String(d.reason ?? 'other').slice(0, 120),
    details: String(d.details ?? '').slice(0, 2000), status: ['pending', 'reviewed', 'resolved', 'dismissed'].includes(d.status) ? d.status : 'pending', createdAt: iso(d.timestamp) ?? new Date(),
  } : null), (d) => ({ id: d.id }));
  await simple('contactmessages', 'contactMessages', ContactMessageModel, (d) => (d.email && d.message ? {
    id: String(d.id ?? d._id), name: String(d.name ?? '').slice(0, 120), email: String(d.email).slice(0, 254), message: String(d.message).slice(0, 5000), ...(d.userId ? { userId: d.userId } : {}),
    status: ['unread', 'read', 'archived'].includes(d.status) ? d.status : 'unread', createdAt: iso(d.timestamp) ?? new Date(),
  } : null), (d) => ({ id: d.id }));
  await simple('histories', 'matches', MatchModel, (d) => (d.userId && d.partnerId ? {
    id: String(d.id ?? d._id), userId: d.userId, partnerId: d.partnerId, type: d.type === 'viewed_me' || d.type === 'view' ? 'view' : 'video_chat', durationSec: parseDuration(d.duration),
    partner: { name: d.partnerName, username: d.partnerUsername, avatar: d.partnerAvatar, country: d.partnerCountry, ...(d.partnerAge ? { age: d.partnerAge } : {}) }, createdAt: iso(d.timestamp) ?? new Date(),
  } : null), (d) => ({ id: d.id }));

  // ---- messages + rebuilt conversations --------------------------------------------------------------
  type Conv = { a: string; b: string; last: Doc; at: Date; unread: Record<string, number> };
  const convs = new Map<string, Conv>();
  await simple('messages', 'messages', MessageModel, (d) => {
    if (!d.senderId || !d.receiverId || d.senderId === d.receiverId) return null;
    const at = iso(d.timestamp) ?? new Date();
    const key = conversationKey(d.senderId, d.receiverId);
    const text = String(d.text ?? '').slice(0, 2000);
    const c: Conv = convs.get(key) ?? { a: d.senderId, b: d.receiverId, last: {}, at: new Date(0), unread: {} };
    if (at >= c.at) { c.at = at; c.last = { id: String(d.id ?? d._id), senderId: d.senderId, text: text || d.giftType || '', isGift: Boolean(d.isGift) }; }
    if (!d.isRead) c.unread[d.receiverId] = (c.unread[d.receiverId] ?? 0) + 1;
    convs.set(key, c);
    return {
      id: String(d.id ?? d._id), senderId: d.senderId, receiverId: d.receiverId, conversationKey: key, text,
      ...(d.isGift ? { gift: { id: 'legacy', name: d.giftType ?? 'Gift', image: '', cost: Math.max(0, num(d.giftAmount)) } } : {}), isRead: Boolean(d.isRead), createdAt: at,
    };
  }, (d) => ({ id: d.id }));
  for (const [key, c] of convs) {
    await upsert(ConversationModel, 'conversations', { key }, {
      key, participants: [c.a, c.b].sort(), lastMessage: c.last, lastMessageAt: c.at, unread: c.unread, clearedAt: {},
    });
  }

  // ---- purchases ---------------------------------------------------------------------------------------
  if (await exists('purchases')) {
    const packGems = new Map((await PackModel.find({}, { id: 1, gems: 1 }).lean()).map((p) => [p.id, p.gems]));
    for (const p of await col('packs').find({}).toArray().catch(() => [] as Doc[])) packGems.set(String(p.id ?? p._id), Math.max(1, Math.round(num(p.gems, 1))));
    for (const d of await col('purchases').find({}).toArray()) {
      stat('purchases').read++;
      const provider = mapProvider(d.paymentMethod);
      if (!provider || !d.id || !d.userId) { stat('purchases').skipped++; warn(`purchase ${d.id}: unknown payment method "${d.paymentMethod}" — skipped`); continue; }
      await upsert(PurchaseModel, 'purchases', { provider, providerTxnId: String(d.id) }, {
        id: `txn_legacy_${String(d._id)}`, userId: d.userId, username: d.username ?? '', provider, providerTxnId: String(d.id),
        ...(d.receiptHash ? { receiptHash: d.receiptHash } : {}), packId: d.packId ?? 'legacy', packName: d.packName ?? '', gems: packGems.get(d.packId) ?? 1,
        amount: Math.max(0, num(d.price)), currency: 'USD', status: 'completed', createdAt: iso(d.createdAt) ?? new Date(),
      });
    }
  }

  // ---- settings & languages ----------------------------------------------------------------------------
  if (await exists('settings')) {
    const all = await col('settings').find({}).toArray();
    const main = all.find((s) => s.type === 'admin_settings');
    if (main) {
      stat('settings').read++;
      const { groups, dropped } = mapSettings(main, opts.secretBox);
      if (dropped.length) warn(`settings fields not carried over: ${dropped.join(', ')}`);
      if (main.mobileApiAccessKey) warn('The v1 mobileApiAccessKey is replaced by leveled API keys — create a "mobile" key in Admin → API keys and put it in the new app.');
      for (const [group, data] of Object.entries(groups)) await upsert(SettingModel, 'settings', { group }, { group, data, version: 1 });
    }
    for (const l of all.filter((s) => s.type === 'language' && s.code)) {
      stat('languages').read++;
      const translations = Object.fromEntries(Object.entries((l.translations ?? {}) as Record<string, unknown>).filter(([, v]) => typeof v === 'string').map(([k, v]) => [k.replaceAll('.', '．'), v]));
      await upsert(LanguageModel, 'languages', { code: String(l.code).toLowerCase() }, { code: String(l.code).toLowerCase(), name: l.name ?? l.code, flag: l.flag ?? '', rtl: Boolean(l.rtl), translations });
    }
  }

  return report;
}
