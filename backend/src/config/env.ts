import { z } from 'zod';

const csv = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const bool = (def: boolean) => z.stringbool().default(def);
const int = (def: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max).default(def);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(3000, 1, 65535),
  HOST: z.string().default('0.0.0.0'),
  PUBLIC_URL: z.string().url().default('http://localhost:3000'),
  TRUST_PROXY: z.string().default('loopback'),
  CORS_ORIGINS: csv,
  BODY_LIMIT: z.string().default('1mb'),

  MONGODB_URI: z.string().regex(/^mongodb(\+srv)?:\/\//, 'must start with mongodb:// or mongodb+srv://'),
  MONGO_MAX_POOL_SIZE: int(20, 1, 500),
  MONGO_MIN_POOL_SIZE: int(2, 0, 100),
  MONGO_SERVER_SELECTION_TIMEOUT_MS: int(10_000, 100),
  MONGO_SOCKET_TIMEOUT_MS: int(45_000, 1000),
  MONGO_MAX_IDLE_TIME_MS: int(60_000, 1000),
  MONGO_AUTO_INDEX: bool(true),
  REDIS_URL: z.string().optional(),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_ISSUER: z.string().default('vibematch'),
  JWT_AUDIENCE: z.string().default('vibematch-clients'),
  ACCESS_TOKEN_TTL_SECONDS: int(900, 60, 86_400),
  REFRESH_TOKEN_TTL_DAYS: int(30, 1, 365),
  BCRYPT_COST: int(12, 4, 15),
  LOGIN_MAX_ATTEMPTS: int(5, 1, 100),
  LOGIN_LOCK_MINUTES: int(15, 1, 1440),
  SETTINGS_ENCRYPTION_KEY: z.string().optional(),

  ADMIN_IP_ALLOWLIST: csv,
  REQUIRE_ADMIN_PASSKEY: bool(false),
  WEBAUTHN_RP_ID: z.string().default('localhost'),
  WEBAUTHN_RP_NAME: z.string().default('VibeMatch'),
  WEBAUTHN_ORIGINS: csv,

  RATE_LIMIT_WINDOW_MS: int(60_000, 1000),
  RATE_LIMIT_GLOBAL: int(300, 1),
  RATE_LIMIT_USER: int(240, 1),
  RATE_LIMIT_AUTH: int(10, 1),
  RATE_LIMIT_SENSITIVE: int(20, 1),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_FLUSH_MS: int(1000, 50),

  DEMO_MODE: bool(false),
  /** Serve GET /openapi.json (handy in development; off by default in production). */
  EXPOSE_OPENAPI: bool(false),
  HISTORY_TTL_DAYS: int(180, 1),
  AUDIT_TTL_DAYS: int(365, 1),
  CACHE_TTL_SECONDS: int(60, 1),

  ANDROID_PACKAGE_NAME: z.string().default('com.vibematch.app'),
  PAYPAL_ENV: z.enum(['sandbox', 'live']).default('sandbox'),
  PAYMENT_CURRENCY: z.string().length(3).default('USD'),
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  /** Firebase Admin credentials (social sign-in verification + FCM). The admin settings page can override it. */
  FIREBASE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  APPLE_SHARED_SECRET: z.string().optional(),
});

type RawEnv = z.infer<typeof schema>;

export interface Env extends RawEnv {
  readonly isProd: boolean;
  readonly isTest: boolean;
  /** Origins allowed by CORS. */
  readonly corsOrigins: readonly string[];
}

export class EnvError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n - ${issues.join('\n - ')}`);
    this.name = 'EnvError';
  }
}

const PLACEHOLDER_SECRETS = /change[-_ ]?me|your[-_ ]?(jwt[-_ ]?)?secret|example|placeholder|vibe_sec_/i;

export function parseEnv(source: NodeJS.ProcessEnv | Record<string, string | undefined>): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    throw new EnvError(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  const raw = parsed.data;
  const problems: string[] = [];

  if (raw.NODE_ENV === 'production') {
    if (new URL(raw.PUBLIC_URL).protocol !== 'https:') problems.push('PUBLIC_URL must use https in production');
    if (PLACEHOLDER_SECRETS.test(raw.JWT_SECRET)) problems.push('JWT_SECRET looks like a placeholder; generate a random one');
    if (!raw.SETTINGS_ENCRYPTION_KEY) problems.push('SETTINGS_ENCRYPTION_KEY is required in production');
    if (raw.CORS_ORIGINS.length === 0) problems.push('CORS_ORIGINS must list the allowed origins in production');
    if (raw.WEBAUTHN_RP_ID === 'localhost') problems.push('WEBAUTHN_RP_ID must be your domain in production');
  }
  if (raw.CORS_ORIGINS.includes('*')) problems.push('CORS_ORIGINS must not contain "*"');
  if (raw.SETTINGS_ENCRYPTION_KEY && Buffer.from(raw.SETTINGS_ENCRYPTION_KEY, 'base64').length !== 32) {
    problems.push('SETTINGS_ENCRYPTION_KEY must be 32 bytes, base64 encoded (openssl rand -base64 32)');
  }
  if (raw.MONGO_MIN_POOL_SIZE > raw.MONGO_MAX_POOL_SIZE) {
    problems.push('MONGO_MIN_POOL_SIZE must not exceed MONGO_MAX_POOL_SIZE');
  }
  if (problems.length) throw new EnvError(problems);

  return Object.freeze({
    ...raw,
    isProd: raw.NODE_ENV === 'production',
    isTest: raw.NODE_ENV === 'test',
    corsOrigins: Object.freeze([...raw.CORS_ORIGINS]),
  });
}

let cached: Env | undefined;

/** Singleton accessor: parsed once, fails fast at boot. */
export function getEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}

/** Test helper — never call in production code. */
export function resetEnvForTests(): void {
  cached = undefined;
}
