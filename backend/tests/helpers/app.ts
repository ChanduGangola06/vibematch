import type { Express } from 'express';
import { parseEnv, type Env } from '../../src/config/env.js';
import { createApp, type AppDeps, type HealthCheck, type ModuleRegistrar } from '../../src/app.js';
import { MemoryLruCache } from '../../src/core/cache/index.js';
import { createEventBus } from '../../src/core/events/index.js';
import { Metrics } from '../../src/core/http/index.js';
import { createAsyncLogger } from '../../src/core/logger/index.js';
import { CursorCodec } from '../../src/core/pagination/index.js';
import { generateApiKey, type ApiKeyLevel } from '../../src/core/security/api-key.js';
import { TokenService, type Role } from '../../src/core/security/tokens.js';
import type { ApiKeyVerifier, UserStatus, UserStatusPort, VerifiedApiKey } from '../../src/middleware/authenticate.js';
import type { IdempotencyStore, StoredRecord } from '../../src/middleware/idempotency.js';
import { MemoryRateStore } from '../../src/middleware/rate-limit.js';
import { registerHealth } from '../../src/modules/health/health.routes.js';

export const TEST_JWT_SECRET = 'test-only-jwt-secret-0123456789abcdef0123456789';

export function testEnv(overrides: Record<string, string | undefined> = {}): Env {
  return parseEnv({
    NODE_ENV: 'test',
    MONGODB_URI: 'mongodb://127.0.0.1:27017/x',
    JWT_SECRET: TEST_JWT_SECRET,
    CORS_ORIGINS: 'http://allowed.test',
    LOG_LEVEL: 'silent',
    BCRYPT_COST: '4',
    SETTINGS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    RATE_LIMIT_GLOBAL: '1000',
    RATE_LIMIT_USER: '1000',
    RATE_LIMIT_AUTH: '1000',
    RATE_LIMIT_SENSITIVE: '1000',
    ...overrides,
  });
}

export class FakeUsers implements UserStatusPort {
  readonly users = new Map<string, UserStatus>();
  calls = 0;
  set(id: string, s: Partial<UserStatus> = {}): this {
    this.users.set(id, { role: 'user', isBanned: false, ...s });
    return this;
  }
  async get(id: string) {
    this.calls++;
    return this.users.get(id) ?? null;
  }
}

export class FakeApiKeys implements ApiKeyVerifier {
  private readonly byHash = new Map<string, VerifiedApiKey>();
  issue(level: ApiKeyLevel, scopes: string[] = []): string {
    const k = generateApiKey(level);
    this.byHash.set(k.hash, { id: `key_${k.prefix}`, level, scopes });
    return k.plain;
  }
  async verify(hash: string) {
    return this.byHash.get(hash) ?? null;
  }
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  readonly rows = new Map<string, StoredRecord>();
  private k(s: string, k: string, r: string) {
    return `${s}|${k}|${r}`;
  }
  async claim(rec: { scope: string; key: string; route: string; requestHash: string; expiresAt: Date }) {
    const id = this.k(rec.scope, rec.key, rec.route);
    const ex = this.rows.get(id);
    if (ex) return ex;
    this.rows.set(id, { requestHash: rec.requestHash, status: 'in_progress' });
    return null;
  }
  async complete(s: string, k: string, r: string, status: number, body: unknown) {
    const row = this.rows.get(this.k(s, k, r));
    if (row) Object.assign(row, { status: 'completed', responseStatus: status, responseBody: body });
  }
  async release(s: string, k: string, r: string) {
    const row = this.rows.get(this.k(s, k, r));
    if (row?.status === 'in_progress') this.rows.delete(this.k(s, k, r));
  }
}

export interface TestApp {
  app: Express;
  deps: AppDeps;
  env: Env;
  users: FakeUsers;
  apiKeys: FakeApiKeys;
  tokens: TokenService;
  idempotency: MemoryIdempotencyStore;
  /** Bearer header for a user id (user must be registered via `users.set`). */
  bearer(userId: string, role?: Role): string;
}

export interface BuildOptions {
  env?: Record<string, string | undefined>;
  modules?: ModuleRegistrar[];
  healthChecks?: HealthCheck[];
  withHealth?: boolean;
}

export function buildTestApp(opts: BuildOptions = {}): TestApp {
  const env = testEnv(opts.env);
  const users = new FakeUsers();
  const apiKeys = new FakeApiKeys();
  const idempotency = new MemoryIdempotencyStore();
  const tokens = new TokenService({
    secret: env.JWT_SECRET,
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    accessTtlSeconds: env.ACCESS_TOKEN_TTL_SECONDS,
  });
  const { logger } = createAsyncLogger({ level: 'silent', flushMs: 1000 });
  const deps: AppDeps = {
    env,
    log: logger,
    cache: new MemoryLruCache(),
    events: createEventBus(),
    metrics: new Metrics(false),
    tokens,
    cursor: new CursorCodec(env.JWT_SECRET),
    rateStore: new MemoryRateStore(),
    userStatus: users,
    apiKeys,
    idempotencyStore: idempotency,
    healthChecks: opts.healthChecks ?? [],
  };
  const modules = [...(opts.withHealth === false ? [] : [registerHealth]), ...(opts.modules ?? [])];
  const app = createApp(deps, modules);
  return {
    app, deps, env, users, apiKeys, tokens, idempotency,
    bearer: (userId, role = 'user') => `Bearer ${tokens.signAccess({ sub: userId, role, sid: 'sess1' }).token}`,
  };
}
