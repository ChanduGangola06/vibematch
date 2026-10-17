import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Env } from '../../config/env.js';
import type { AppEventBus } from '../../core/events/index.js';
import type { Logger } from '../../core/logger/index.js';
import { createMailer, renderTemplate, type MailPort } from '../../infra/mail/index.js';
import { LazyPushAdapter, createFcmFromServiceAccount, NullPushAdapter, type PushPort } from '../../infra/push/index.js';
import { LocalStorage, createStorage, type StoragePort, type StorageSettings } from '../../infra/storage/index.js';
import { UserModel } from '../../infra/db/models/user.js';
import type { AuthFlags } from '../auth/auth.ports.js';
import type { CaptchaConfigProvider } from '../contact/captcha.js';
import type { DiscoverConfig } from '../discover/discover.service.js';
import type { PresenceConfig } from '../matching/presence.service.js';
import type { PushProvider } from '../notifications/push.service.js';
import type { PaymentConfig, PaymentConfigProvider } from '../payments/payment.types.js';
import type { StorageProvider } from '../users/user.service.js';
import type { IceConfig, IceConfigProvider } from '../webrtc/ice.service.js';
import type { SettingsService } from './settings.service.js';

const fingerprint = (v: unknown) => createHash('sha1').update(JSON.stringify(v)).digest('hex');

/** Adapters from the admin-editable settings to the small ports each module depends on. */
export function settingsAuthFlags(s: SettingsService): AuthFlags {
  return {
    guestLoginEnabled: async () => (await s.get('auth')).guestLogin,
    providerEnabled: async (p) => (await s.get('auth'))[`${p}Login` as 'googleLogin'] !== false,
    signupBonusGems: async () => (await s.get('general')).bonusGems,
  };
}

export const settingsCaptcha = (s: SettingsService): CaptchaConfigProvider => ({
  get: async () => {
    const p = await s.get('plugins');
    return { enabled: p.enableRecaptcha, secret: p.recaptchaSecretKey };
  },
});

export const settingsDiscover = (s: SettingsService): DiscoverConfig => ({
  mode: async () => (await s.get('general')).discoverGridUsers,
});

export const settingsPresence = (s: SettingsService): PresenceConfig => ({
  show: async () => (await s.get('general')).showOnlineUsers,
  fakeExtra: async () => (await s.get('general')).fakeOnlineUsersCount,
});

export const settingsIce = (s: SettingsService): IceConfigProvider => ({
  get: async (): Promise<IceConfig> => {
    const w = await s.get('webrtc');
    switch (w.activeWebrtcProvider) {
      case 'twilio': return w.twilioAccountSid && w.twilioAuthToken ? { provider: 'twilio', accountSid: w.twilioAccountSid, authToken: w.twilioAuthToken } : { provider: 'default' };
      case 'metered': return w.meteredApiKey ? { provider: 'metered', apiKey: w.meteredApiKey, appName: w.meteredAppName || undefined } : { provider: 'default' };
      case 'xirsys': return w.xirsysDomain && w.xirsysSecret ? { provider: 'xirsys', domain: w.xirsysDomain, secret: w.xirsysSecret, channel: w.xirsysChannel || undefined } : { provider: 'default' };
      default: return { provider: 'default' };
    }
  },
});

/** Service-account JSON for Firebase Admin: admin setting first, environment as fallback. */
export const firebaseCredentials = (s: SettingsService, env: Env) => async (): Promise<string | undefined> => {
  const fromSettings = (await s.get('auth')).firebaseServiceAccount;
  return fromSettings || env.FIREBASE_SERVICE_ACCOUNT_JSON;
};

export function settingsPush(s: SettingsService, env: Env): PushProvider {
  let cached: { fp: string; push: PushPort } | undefined;
  return {
    async get() {
      const json = await firebaseCredentials(s, env)();
      if (!json || json.length < 10) return new NullPushAdapter();
      const fp = fingerprint(json);
      if (cached?.fp !== fp) cached = { fp, push: new LazyPushAdapter(() => createFcmFromServiceAccount(json)) };
      return cached.push;
    },
  };
}

export function settingsPayments(s: SettingsService, env: Env): PaymentConfigProvider {
  return {
    async get(): Promise<PaymentConfig> {
      const p = await s.get('payments');
      const cfg: PaymentConfig = { currency: p.currency };
      if (p.stripeEnabled && p.stripeSecretKey) cfg.stripe = { secretKey: p.stripeSecretKey, ...(p.stripeWebhookSecret ? { webhookSecret: p.stripeWebhookSecret } : {}) };
      if (p.paypalEnabled && p.paypalClientId && p.paypalSecret) cfg.paypal = { clientId: p.paypalClientId, clientSecret: p.paypalSecret, env: p.paypalEnv, ...(p.paypalWebhookId ? { webhookId: p.paypalWebhookId } : {}) };
      if (p.razorpayEnabled && p.razorpayKeyId && p.razorpayKeySecret) cfg.razorpay = { keyId: p.razorpayKeyId, keySecret: p.razorpayKeySecret, currency: p.razorpayCurrency, ...(p.razorpayWebhookSecret ? { webhookSecret: p.razorpayWebhookSecret } : {}) };
      const gjson = p.googleServiceAccountJson || env.GOOGLE_SERVICE_ACCOUNT_JSON;
      if (p.googlePayEnabled && gjson) cfg.google = { serviceAccountJson: gjson, packageName: p.androidPackageName || env.ANDROID_PACKAGE_NAME };
      if (p.applePayEnabled) cfg.apple = { sharedSecret: p.appleSharedSecret || env.APPLE_SHARED_SECRET };
      return cfg;
    },
  };
}

/** Admin storage choice → a StoragePort. All S3-compatible vendors share one adapter. */
export function storageSettingsFor(st: Record<string, unknown>): StorageSettings {
  const g = st as Record<string, string>;
  switch (g.storageType) {
    case 's3':
      return { type: 's3', region: g.s3Region || 'us-east-1', bucket: g.s3Bucket!, accessKey: g.s3AccessKey!, secretKey: g.s3SecretKey!, ...(g.s3PublicUrl ? { publicBaseUrl: g.s3PublicUrl } : {}) };
    case 'digitalocean':
      return { type: 's3', region: g.doRegion || 'nyc3', bucket: g.doBucket!, accessKey: g.doAccessKey!, secretKey: g.doSecretKey!, endpoint: g.doEndpoint || `https://${g.doRegion}.digitaloceanspaces.com`, publicBaseUrl: g.doPublicUrl || `https://${g.doBucket}.${g.doRegion}.digitaloceanspaces.com` };
    case 'backblaze':
      return { type: 's3', region: g.b2Region || 'us-west-004', bucket: g.b2Bucket!, accessKey: g.b2KeyId!, secretKey: g.b2AppKey!, endpoint: g.b2Endpoint!, publicBaseUrl: g.b2PublicUrl || `${g.b2Endpoint}/${g.b2Bucket}` };
    case 'gcp':
      return { type: 's3', region: 'auto', bucket: g.gcpBucket!, accessKey: g.gcpAccessKey!, secretKey: g.gcpSecretKey!, endpoint: 'https://storage.googleapis.com', publicBaseUrl: g.gcpPublicUrl || `https://storage.googleapis.com/${g.gcpBucket}` };
    case 'bunny':
      return { type: 'bunny', storageZone: g.bunnyStorageZone!, accessKey: g.bunnyAccessKey!, pullZoneUrl: g.bunnyPullZoneUrl! };
    default:
      return { type: 'local' };
  }
}

export function settingsStorage(s: SettingsService, publicDir: string): StorageProvider {
  const localRoot = path.join(publicDir, 'images');
  let cached: { fp: string; store: StoragePort } | undefined;
  return {
    async get() {
      const cfg = storageSettingsFor((await s.get('storage')) as Record<string, unknown>);
      if (cfg.type === 'local') {
        cached = undefined;
        return new LocalStorage(localRoot, '/images');
      }
      const fp = fingerprint(cfg);
      if (cached?.fp !== fp) cached = { fp, store: createStorage(cfg, localRoot) };
      return cached.store;
    },
  };
}

/** Sends the system e-mails. Templates and SMTP come from settings; template variables are HTML-escaped. */
export class MailService {
  private cached: { fp: string; mailer: MailPort } | undefined;

  constructor(
    private readonly settings: SettingsService,
    private readonly events: AppEventBus,
    private readonly log: Logger,
    private readonly mailerFactory: typeof createMailer = createMailer,
  ) {}

  listen(): void {
    this.events.on('user.registered', async ({ email, name, isGuest }) => {
      if (!email || isGuest) return;
      const m = await this.settings.get('mail');
      if (m.templateWelcome) await this.send(email, 'Welcome to VibeMatch!', renderTemplate(m.templateWelcome, { nameuser: name }));
    });
    this.events.on('purchase.completed', async ({ userId, packName, amount }) => {
      const user = await UserModel.findOne({ id: userId }, { email: 1, name: 1, username: 1 }).lean();
      if (!user?.email) return;
      const m = await this.settings.get('mail');
      if (m.templatePurchase) {
        await this.send(user.email, 'Purchase Confirmation', renderTemplate(m.templatePurchase, { nameuser: user.name || user.username, packname: packName, price: amount }));
      }
    });
  }

  private async mailer(): Promise<MailPort> {
    const m = await this.settings.get('mail');
    const cfg = {
      driver: m.mailDriver, fromName: m.mailFromName || 'VibeMatch', fromEmail: m.mailFromEmail || 'noreply@localhost',
      smtpHost: m.smtpHost, smtpPort: m.smtpPort, smtpUser: m.smtpUser, smtpPass: m.smtpPass,
    };
    const fp = fingerprint(cfg);
    if (this.cached?.fp !== fp) this.cached = { fp, mailer: this.mailerFactory(cfg, this.log) };
    return this.cached.mailer;
  }

  async send(to: string, subject: string, html: string): Promise<boolean> {
    try {
      return await (await this.mailer()).send({ to, subject, html });
    } catch (err) {
      this.log.warn({ err }, 'mail failed');
      return false;
    }
  }

  sendTest(to: string): Promise<boolean> {
    return this.send(to, 'Test e-mail from VibeMatch', '<h1>Hello!</h1><p>Your mail settings work.</p>');
  }
}
