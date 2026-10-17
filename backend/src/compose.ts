import type { Express } from 'express';
import { createApp, type AppDeps, type ModuleRegistrar } from './app.js';
import { UserRepository } from './modules/users/user.repository.js';
import type { AuthFlags, IdTokenVerifier, PasskeyGate } from './modules/auth/auth.ports.js';
import { AuthService } from './modules/auth/auth.service.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { FirebaseIdTokenVerifier } from './modules/auth/firebase-verifier.js';
import { SessionService } from './modules/auth/session.service.js';
import { WebAuthnService } from './modules/auth/webauthn.service.js';
import { webauthnRoutes } from './modules/auth/webauthn.routes.js';
import path from 'node:path';
import { SocialRepository } from './modules/social/social.repository.js';
import { SocialService } from './modules/social/social.service.js';
import { socialRoutes } from './modules/social/social.routes.js';
import { PushService, type PushProvider } from './modules/notifications/push.service.js';
import { NotificationService } from './modules/notifications/notification.service.js';
import { notificationRoutes } from './modules/notifications/notification.routes.js';
import { UserService, type StorageProvider } from './modules/users/user.service.js';
import { userRoutes } from './modules/users/user.routes.js';
import { DiscoverService, type DiscoverConfig } from './modules/discover/discover.service.js';
import { discoverRoutes } from './modules/discover/discover.routes.js';
import { ChatService } from './modules/chat/chat.service.js';
import { chatRoutes } from './modules/chat/chat.routes.js';
import { DemoReplyService } from './modules/chat/demo-reply.js';
import { HistoryService } from './modules/history/history.service.js';
import { historyRoutes } from './modules/history/history.routes.js';
import { ReportService } from './modules/reports/report.service.js';
import { reportRoutes } from './modules/reports/report.routes.js';
import { RecaptchaVerifier, type CaptchaVerifier } from './modules/contact/captcha.js';
import { contactRoutes } from './modules/contact/contact.routes.js';
import { cachedRepository } from './core/cache/index.js';
import { GemService } from './modules/ledger/gem.service.js';
import { GiftRepository } from './modules/gifts/gift.repository.js';
import { GiftService } from './modules/gifts/gift.service.js';
import { giftRoutes } from './modules/gifts/gift.routes.js';
import { PackRepository, VipPlanRepository } from './modules/store/store.repository.js';
import { VipService } from './modules/store/vip.service.js';
import { storeRoutes } from './modules/store/store.routes.js';
import { PaymentService } from './modules/payments/payment.service.js';
import { paymentRoutes } from './modules/payments/payment.routes.js';
import { PaymentProviderFactory, PaymentProviders } from './modules/payments/provider.factory.js';
import type { PaymentConfigProvider } from './modules/payments/payment.types.js';
import type { Redis } from 'ioredis';
import { MemoryMatchQueue, RedisMatchQueue, type MatchQueue } from './modules/matching/queue.js';
import { MemorySessionStore, RedisSessionStore, type MatchSessionStore } from './modules/matching/session-store.js';
import { MatchingService, defaultMatchingConfig, type MatchingConfig } from './modules/matching/matching.service.js';
import { PresenceService, type PresenceConfig } from './modules/matching/presence.service.js';
import { IceService, type IceConfigProvider } from './modules/webrtc/ice.service.js';
import { iceRoutes } from './modules/webrtc/ice.routes.js';
import { SwitchableNotifier, type RealtimeDeps } from './realtime/realtime.js';
import { SecretBox } from './core/security/crypto.js';
import { SettingsService } from './modules/settings/settings.service.js';
import {
  MailService, firebaseCredentials, settingsAuthFlags, settingsCaptcha, settingsDiscover, settingsIce, settingsPayments,
  settingsPresence, settingsPush, settingsStorage,
} from './modules/settings/settings.providers.js';
import { PageService } from './modules/content/page.service.js';
import { LanguageService } from './modules/content/language.service.js';
import { contentRoutes } from './modules/content/content.routes.js';
import { settingsRoutes } from './modules/settings/settings.routes.js';
import { AdminUserService } from './modules/admin/users/admin-users.service.js';
import { adminUserRoutes } from './modules/admin/users/admin-users.routes.js';
import { demoUserRoutes } from './modules/admin/demo/demo-users.js';
import { moderationRoutes } from './modules/admin/moderation/moderation.routes.js';
import { CatalogService } from './modules/admin/catalog/catalog.service.js';
import { catalogRoutes } from './modules/admin/catalog/catalog.routes.js';
import { reportingRoutes } from './modules/admin/reporting/reporting.routes.js';
import { BackupService } from './modules/admin/backup/backup.service.js';
import { backupRoutes } from './modules/admin/backup/backup.routes.js';
import { InstallService } from './modules/install/install.service.js';
import { installRoutes } from './modules/install/install.routes.js';
import { registerHealth } from './modules/health/health.routes.js';
import { AuditService } from './modules/admin/audit.service.js';
import { ApiKeyService } from './modules/admin/api-keys/api-keys.service.js';
import { apiKeyRoutes } from './modules/admin/api-keys/api-keys.routes.js';

/** Seams for tests (fake Firebase) and for later modules that supply real implementations (settings-backed flags). */
export interface Overrides {
  idTokenVerifier?: IdTokenVerifier;
  authFlags?: AuthFlags;
  passkeyGate?: PasskeyGate;
  storage?: StorageProvider;
  push?: PushProvider;
  discoverConfig?: DiscoverConfig;
  captcha?: CaptchaVerifier;
  demoReplyDelayMs?: number;
  paymentConfig?: PaymentConfigProvider;
  paymentFactory?: PaymentProviderFactory;
  /** Shared Redis (optional): queue, sessions and presence become cluster-wide. */
  redis?: Redis | undefined;
  matchingConfig?: Partial<MatchingConfig>;
  presenceConfig?: PresenceConfig;
  iceConfig?: IceConfigProvider;
  iceFetch?: typeof fetch;
}

export interface Services {
  users: UserRepository;
  sessions: SessionService;
  auth: AuthService;
  webauthn: WebAuthnService;
  audit: AuditService;
  apiKeys: ApiKeyService;
  social: SocialService;
  notifications: NotificationService;
  userService: UserService;
  discover: DiscoverService;
  chat: ChatService;
  history: HistoryService;
  gems: GemService;
  gifts: GiftService;
  vip: VipService;
  packs: PackRepository;
  payments: PaymentService;
  matching: MatchingService;
  presence: PresenceService;
  ice: IceService;
  settings: SettingsService;
  mail: MailService;
  pages: PageService;
  languages: LanguageService;
  adminUsers: AdminUserService;
  catalog: CatalogService;
  backup: BackupService;
  install: InstallService;
}

/**
 * Wires services → routes → app. Server and tests share this, so what we test is what runs.
 * Add new modules by constructing their services here and pushing their registrar.
 */
export function composeApp(deps: AppDeps, overrides: Overrides = {}): { app: Express; services: Services; realtime: RealtimeDeps } {
  const users = new UserRepository();
  const settings = new SettingsService(
    deps.cache,
    deps.env.SETTINGS_ENCRYPTION_KEY ? new SecretBox(deps.env.SETTINGS_ENCRYPTION_KEY) : undefined,
    deps.events,
  );
  const publicDir = deps.publicDir ?? path.resolve(process.cwd(), 'public');
  const mail = new MailService(settings, deps.events, deps.log);
  mail.listen();
  const sessions = new SessionService(deps.env, deps.tokens, users, deps.cache, deps.events);

  const verifier =
    overrides.idTokenVerifier ?? new FirebaseIdTokenVerifier(firebaseCredentials(settings, deps.env));

  const webauthn = new WebAuthnService(deps.env);

  const auth = new AuthService({
    env: deps.env,
    users,
    sessions,
    events: deps.events,
    flags: overrides.authFlags ?? settingsAuthFlags(settings),
    verifier,
    passkeys: overrides.passkeyGate ?? webauthn,
  });

  const audit = new AuditService(deps.log);
  const apiKeys = new ApiKeyService(deps.cache);

  const storage: StorageProvider = overrides.storage ?? settingsStorage(settings, publicDir);
  const socialRepo = new SocialRepository();
  const social = new SocialService(socialRepo, users, deps.events, deps.cursor);
  const userService = new UserService(deps.env, users, social, sessions, storage, deps.events, deps.cache);
  const push = new PushService(overrides.push ?? settingsPush(settings, deps.env), deps.log);
  const notifications = new NotificationService(deps.events, users, push, deps.cursor);
  notifications.listen();
  const discover = new DiscoverService(overrides.discoverConfig ?? settingsDiscover(settings), deps.cache);

  const chat = new ChatService(users, socialRepo, social, deps.events, deps.cursor);
  new DemoReplyService(deps.events, users, chat, deps.log, overrides.demoReplyDelayMs).listen();
  const gems = new GemService(deps.log);

  // Read-mostly catalogues: cache-aside (Decorator) with event-driven invalidation (Observer).
  const ttl = 300;
  const giftRepo = cachedRepository(new GiftRepository(), deps.cache, 'gifts', { list: { ttl, tags: ['gifts'] }, findById: { ttl, tags: ['gifts'] } });
  const packRepo = cachedRepository(new PackRepository(), deps.cache, 'packs', { list: { ttl, tags: ['packs'] }, findById: { ttl, tags: ['packs'] }, findByAnyId: { ttl, tags: ['packs'] } });
  const vipRepo = cachedRepository(new VipPlanRepository(), deps.cache, 'vip', { list: { ttl, tags: ['vip'] }, findById: { ttl, tags: ['vip'] } });
  deps.events.on('content.changed', async ({ kind }) => {
    if (kind === 'gifts') await giftRepo.invalidate('gifts');
    if (kind === 'packs') await packRepo.invalidate('packs');
    if (kind === 'vip') await vipRepo.invalidate('vip');
  });
  const giftService = new GiftService(giftRepo, gems, chat, users, deps.events);
  const vip = new VipService(vipRepo, gems, deps.events);

  const providers = new PaymentProviders(overrides.paymentConfig ?? settingsPayments(settings, deps.env), overrides.paymentFactory ?? new PaymentProviderFactory());
  const payments = new PaymentService(deps.env, providers, packRepo, gems, deps.events, deps.cursor, deps.log);

  // ---- realtime pieces (built here, attached to the HTTP server in server.ts) ----
  const redis = overrides.redis;
  const queue: MatchQueue = redis ? new RedisMatchQueue(redis as never) : new MemoryMatchQueue();
  const sessionStore: MatchSessionStore = redis ? new RedisSessionStore(redis as never) : new MemorySessionStore();
  const notifier = new SwitchableNotifier();
  const matching = new MatchingService(queue, sessionStore, users, notifier, deps.events, deps.log, { ...defaultMatchingConfig, ...overrides.matchingConfig });
  const presence = new PresenceService(() => 0, overrides.presenceConfig ?? settingsPresence(settings), redis as never);
  const ice = new IceService(overrides.iceConfig ?? settingsIce(settings), deps.cache, deps.log, overrides.iceFetch);

  const pages = new PageService(deps.cache, deps.events);
  const languages = new LanguageService(deps.cache, deps.events);
  deps.events.on('content.changed', async ({ kind }) => {
    if (kind === 'pages') await deps.cache.invalidateTag('pages');
    if (kind === 'languages') await deps.cache.invalidateTag('languages');
    if (kind === 'discover') await deps.cache.invalidateTag('discover');
  });

  const adminUsers = new AdminUserService(users, userService, sessions, gems, deps.events, deps.cache);
  const catalog = new CatalogService(storage, deps.events);

  const backup = new BackupService();
  const install = new InstallService(deps.env, settings);

  const history = new HistoryService(users, socialRepo, deps.cursor);
  const reports = new ReportService(users);
  const captcha = overrides.captcha ?? new RecaptchaVerifier(settingsCaptcha(settings));

  const registrars: ModuleRegistrar[] = [
    registerHealth,
    authRoutes(auth),
    webauthnRoutes(webauthn, auth),
    apiKeyRoutes(apiKeys, audit),
    userRoutes(userService),
    socialRoutes(social),
    notificationRoutes(notifications, push),
    discoverRoutes(discover),
    chatRoutes(chat),
    historyRoutes(history),
    reportRoutes(reports),
    contactRoutes(captcha),
    giftRoutes(giftService),
    storeRoutes(packRepo, vipRepo, vip),
    paymentRoutes(payments),
    iceRoutes(ice, () => presence.visibleCount()),
    settingsRoutes(settings, audit, mail, storage),
    contentRoutes(pages, languages, audit),
    adminUserRoutes(adminUsers, audit),
    demoUserRoutes(audit, deps.events),
    moderationRoutes(audit),
    catalogRoutes(catalog, audit),
    reportingRoutes(users, audit, deps.env.BCRYPT_COST),
    backupRoutes(backup, audit),
    installRoutes(install),
  ];
  const app = createApp({ ...deps, sessionRevocations: sessions }, registrars);
  const realtime: RealtimeDeps = {
    env: deps.env, log: deps.log, tokens: deps.tokens, userStatus: deps.userStatus, revocations: sessions, events: deps.events,
    metrics: deps.metrics, matching, chat, gifts: giftService, presence, notifier, redis,
  };
  return { app, realtime, services: { users, sessions, auth, webauthn, audit, apiKeys, social, notifications, userService, discover, chat, history, gems, gifts: giftService, vip, packs: packRepo, payments, matching, presence, ice, settings, mail, pages, languages, adminUsers, catalog, backup, install } };
}
