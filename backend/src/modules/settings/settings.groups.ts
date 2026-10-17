import { z, type ZodObject, type ZodRawShape } from 'zod';

/** Only http(s) or site-relative links: `javascript:` / `data:` URLs can never be stored. */
const link = z
  .string()
  .max(500)
  .refine((v) => v === '' || /^(https?:\/\/|\/)/i.test(v), 'Must be an http(s) URL or a /relative path');
const text = (max = 200) => z.string().max(max);
const flag = z.boolean();
const secret = z.string().max(8000);

const emailTemplate = (name: string, body: string): string => `<div style="background-color:#0F172A;color:#ffffff;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;padding:40px 20px;text-align:center;">
  <div style="max-width:600px;margin:0 auto;background-color:#1E293B;border-radius:16px;padding:40px;">
    <h1 style="color:#00E676;margin-bottom:20px;font-size:28px;">${name}</h1>
    <p style="font-size:16px;line-height:1.6;color:#cbd5e1;">Hi <strong>%nameuser%</strong>,</p>
    ${body}
  </div>
</div>`;

export const DEFAULT_WELCOME_TEMPLATE = emailTemplate(
  'Welcome to VibeMatch!',
  `<p style="font-size:16px;line-height:1.6;color:#cbd5e1;">We're thrilled to have you join our community! Get ready to meet new people, make connections and enjoy the best video chat platform.</p>`,
);
export const DEFAULT_PURCHASE_TEMPLATE = emailTemplate(
  'Payment Successful!',
  `<p style="font-size:16px;line-height:1.6;color:#cbd5e1;">Thank you for your purchase. We've successfully processed your payment for <strong style="color:#00E676;">%packname%</strong> (%price%).</p>`,
);

export interface GroupDef {
  schema: ZodObject<ZodRawShape>;
  defaults: Record<string, unknown>;
  /** Encrypted at rest, masked in admin reads, write-only. */
  secrets: readonly string[];
  /** Safe for anonymous clients (web bootstrap / mobile /init). */
  publicFields: readonly string[];
}

const platformSchema = z.object({
  privacyUrl: link, termsUrl: link, rateUrl: link, updateUrl: link,
  versionCode: text(20), forceUpdate: flag,
  adsEnabled: flag, adsProvider: z.enum(['none', 'google', 'applovin', 'facebook', 'multi']),
  admobEnabled: flag, admobAppId: text(), admobBannerId: text(), admobInterstitialId: text(),
  applovinEnabled: flag, applovinSdkKey: text(), applovinBannerId: text(), applovinInterstitialId: text(),
  facebookEnabled: flag, facebookAppId: text(), facebookBannerId: text(), facebookInterstitialId: text(),
}).partial().strict();

export const GROUPS = {
  general: {
    schema: z.object({
      siteName: text(80), siteUrl: link, termsUrl: link, privacyUrl: link, logoUrl: link, faviconUrl: link,
      footerDescription: text(500), footerCopyright: text(200),
      bonusGems: z.number().int().min(0).max(1_000_000),
      discoverGridUsers: z.enum(['demo_only', 'real_only', 'real_no_guest', 'all']),
      showOnlineUsers: flag, fakeOnlineUsersCount: z.number().int().min(0).max(10_000_000),
      playStoreUrl: link, appStoreUrl: link, facebookUrl: link, instagramUrl: link, twitterUrl: link, tiktokUrl: link,
    }),
    defaults: {
      siteName: 'VibeMatch', siteUrl: '', termsUrl: '', privacyUrl: '', logoUrl: '/images/logo.png', faviconUrl: '/favicon.ico',
      footerDescription: '', footerCopyright: '© VibeMatch. All rights reserved.', bonusGems: 300, discoverGridUsers: 'demo_only',
      showOnlineUsers: true, fakeOnlineUsersCount: 0,
      playStoreUrl: '', appStoreUrl: '', facebookUrl: '', instagramUrl: '', twitterUrl: '', tiktokUrl: '',
    },
    secrets: [],
    publicFields: ['siteName', 'siteUrl', 'termsUrl', 'privacyUrl', 'logoUrl', 'faviconUrl', 'footerDescription', 'footerCopyright', 'showOnlineUsers', 'playStoreUrl', 'appStoreUrl', 'facebookUrl', 'instagramUrl', 'twitterUrl', 'tiktokUrl'],
  },
  seo: {
    schema: z.object({ seoTitle: text(120), seoDescription: text(320), seoKeywords: text(320) }),
    defaults: { seoTitle: 'VibeMatch - Video Chat', seoDescription: 'Meet new people worldwide.', seoKeywords: 'video chat, dating, meet' },
    secrets: [],
    publicFields: ['seoTitle', 'seoDescription', 'seoKeywords'],
  },
  auth: {
    schema: z.object({
      guestLogin: flag, phoneLogin: flag, googleLogin: flag, facebookLogin: flag, appleLogin: flag, twitterLogin: flag,
      /** Public Firebase web config (JSON). */
      firebaseConfig: z.string().max(5000).refine((v) => {
        if (v === '') return true;
        try { return typeof JSON.parse(v) === 'object'; } catch { return false; }
      }, 'Must be valid JSON'),
      firebaseServiceAccount: secret,
    }),
    defaults: { guestLogin: true, phoneLogin: true, googleLogin: true, facebookLogin: true, appleLogin: true, twitterLogin: true, firebaseConfig: '', firebaseServiceAccount: '' },
    secrets: ['firebaseServiceAccount'],
    publicFields: ['guestLogin', 'phoneLogin', 'googleLogin', 'facebookLogin', 'appleLogin', 'twitterLogin', 'firebaseConfig'],
  },
  mail: {
    schema: z.object({
      mailDriver: z.enum(['smtp', 'sendmail']), mailFromName: text(80), mailFromEmail: z.union([z.literal(''), z.email().max(254)]),
      smtpHost: text(255), smtpPort: z.number().int().min(1).max(65535), smtpUser: text(255), smtpPass: secret,
      templateWelcome: z.string().max(50_000), templatePurchase: z.string().max(50_000),
    }),
    defaults: {
      mailDriver: 'sendmail', mailFromName: 'VibeMatch', mailFromEmail: 'noreply@vibematch.com', smtpHost: '', smtpPort: 587, smtpUser: '', smtpPass: '',
      templateWelcome: DEFAULT_WELCOME_TEMPLATE, templatePurchase: DEFAULT_PURCHASE_TEMPLATE,
    },
    secrets: ['smtpPass'],
    publicFields: [],
  },
  payments: {
    schema: z.object({
      currency: z.string().length(3).transform((s) => s.toUpperCase()),
      stripeEnabled: flag, stripePublicKey: text(300), stripeSecretKey: secret, stripeWebhookSecret: secret,
      paypalEnabled: flag, paypalClientId: text(300), paypalSecret: secret, paypalEnv: z.enum(['sandbox', 'live']), paypalWebhookId: text(100),
      razorpayEnabled: flag, razorpayKeyId: text(300), razorpayKeySecret: secret, razorpayWebhookSecret: secret, razorpayCurrency: z.string().length(3).transform((s) => s.toUpperCase()),
      googlePayEnabled: flag, googleServiceAccountJson: secret, androidPackageName: text(150),
      applePayEnabled: flag, appleSharedSecret: secret,
    }),
    defaults: {
      currency: 'USD', stripeEnabled: true, stripePublicKey: '', stripeSecretKey: '', stripeWebhookSecret: '',
      paypalEnabled: true, paypalClientId: '', paypalSecret: '', paypalEnv: 'sandbox', paypalWebhookId: '',
      razorpayEnabled: true, razorpayKeyId: '', razorpayKeySecret: '', razorpayWebhookSecret: '', razorpayCurrency: 'INR',
      googlePayEnabled: true, googleServiceAccountJson: '', androidPackageName: '',
      applePayEnabled: true, appleSharedSecret: '',
    },
    secrets: ['stripeSecretKey', 'stripeWebhookSecret', 'paypalSecret', 'razorpayKeySecret', 'razorpayWebhookSecret', 'googleServiceAccountJson', 'appleSharedSecret'],
    publicFields: ['currency', 'stripeEnabled', 'stripePublicKey', 'paypalEnabled', 'paypalClientId', 'razorpayEnabled', 'razorpayKeyId', 'googlePayEnabled', 'applePayEnabled'],
  },
  storage: {
    schema: z.object({
      storageType: z.enum(['local', 's3', 'digitalocean', 'backblaze', 'gcp', 'bunny']),
      s3Region: text(60), s3Bucket: text(100), s3AccessKey: text(200), s3SecretKey: secret, s3PublicUrl: link,
      doEndpoint: link, doRegion: text(60), doBucket: text(100), doAccessKey: text(200), doSecretKey: secret, doPublicUrl: link,
      b2Endpoint: link, b2Region: text(60), b2Bucket: text(100), b2KeyId: text(200), b2AppKey: secret, b2PublicUrl: link,
      gcpBucket: text(100), gcpAccessKey: text(200), gcpSecretKey: secret, gcpPublicUrl: link,
      bunnyStorageZone: text(100), bunnyAccessKey: secret, bunnyPullZoneUrl: link,
    }),
    defaults: {
      storageType: 'local', s3Region: '', s3Bucket: '', s3AccessKey: '', s3SecretKey: '', s3PublicUrl: '',
      doEndpoint: '', doRegion: '', doBucket: '', doAccessKey: '', doSecretKey: '', doPublicUrl: '',
      b2Endpoint: '', b2Region: '', b2Bucket: '', b2KeyId: '', b2AppKey: '', b2PublicUrl: '',
      gcpBucket: '', gcpAccessKey: '', gcpSecretKey: '', gcpPublicUrl: '', bunnyStorageZone: '', bunnyAccessKey: '', bunnyPullZoneUrl: '',
    },
    secrets: ['s3SecretKey', 'doSecretKey', 'b2AppKey', 'gcpSecretKey', 'bunnyAccessKey'],
    publicFields: [],
  },
  webrtc: {
    schema: z.object({
      activeWebrtcProvider: z.enum(['default', 'twilio', 'metered', 'xirsys']),
      twilioAccountSid: text(100), twilioAuthToken: secret, meteredApiKey: secret, meteredAppName: text(100),
      xirsysDomain: text(100), xirsysSecret: secret, xirsysChannel: text(100),
    }),
    defaults: { activeWebrtcProvider: 'default', twilioAccountSid: '', twilioAuthToken: '', meteredApiKey: '', meteredAppName: '', xirsysDomain: '', xirsysSecret: '', xirsysChannel: 'MyFirstApp' },
    secrets: ['twilioAuthToken', 'meteredApiKey', 'xirsysSecret'],
    publicFields: [],
  },
  plugins: {
    schema: z.object({
      enableGoogleAnalytics: flag, googleAnalyticsId: text(60),
      enableRecaptcha: flag, recaptchaSiteKey: text(200), recaptchaSecretKey: secret, recaptchaVersion: z.enum(['v2', 'v3']),
      enableTawkto: flag, tawktoPropertyId: text(100),
    }),
    defaults: { enableGoogleAnalytics: false, googleAnalyticsId: '', enableRecaptcha: false, recaptchaSiteKey: '', recaptchaSecretKey: '', recaptchaVersion: 'v3', enableTawkto: false, tawktoPropertyId: '' },
    secrets: ['recaptchaSecretKey'],
    publicFields: ['enableGoogleAnalytics', 'googleAnalyticsId', 'enableRecaptcha', 'recaptchaSiteKey', 'recaptchaVersion', 'enableTawkto', 'tawktoPropertyId'],
  },
  pwa: {
    schema: z.object({
      pwaEnabled: flag, pwaPromptDelay: z.number().int().min(0).max(3600),
      imageOptimization: flag, minifyHtmlCss: flag, lazyLoadImages: flag, dbQueryCaching: flag,
    }),
    defaults: { pwaEnabled: false, pwaPromptDelay: 5, imageOptimization: true, minifyHtmlCss: true, lazyLoadImages: true, dbQueryCaching: false },
    secrets: [],
    publicFields: ['pwaEnabled', 'pwaPromptDelay', 'lazyLoadImages'],
  },
  mobile: {
    schema: z.object({ android: platformSchema, ios: platformSchema }),
    defaults: { android: {}, ios: {} },
    secrets: [],
    publicFields: ['android', 'ios'],
  },
} as const satisfies Record<string, GroupDef>;

export type GroupName = keyof typeof GROUPS;
export const GROUP_NAMES = Object.keys(GROUPS) as GroupName[];
export const isGroupName = (v: string): v is GroupName => v in GROUPS;

export type GroupData<G extends GroupName> = z.infer<(typeof GROUPS)[G]['schema']>;
