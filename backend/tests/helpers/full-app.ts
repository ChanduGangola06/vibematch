import type { Express } from 'express';
import request from 'supertest';
import { composeApp, type Overrides, type Services } from '../../src/compose.js';
import type { AppDeps } from '../../src/app.js';
import type { RealtimeDeps } from '../../src/realtime/realtime.js';
import { MemoryLruCache } from '../../src/core/cache/index.js';
import { createEventBus } from '../../src/core/events/index.js';
import { Metrics } from '../../src/core/http/index.js';
import { createAsyncLogger } from '../../src/core/logger/index.js';
import { CursorCodec } from '../../src/core/pagination/index.js';
import { TokenService } from '../../src/core/security/tokens.js';
import { MongoApiKeyVerifier } from '../../src/infra/db/api-key-verifier.js';
import { MongoIdempotencyStore } from '../../src/infra/db/idempotency-store.js';
import { MongoUserStatus } from '../../src/infra/db/user-status.js';
import { CachedUserStatus } from '../../src/middleware/authenticate.js';
import { MemoryRateStore, RedisRateStore } from '../../src/middleware/rate-limit.js';
import { RedisCache } from '../../src/core/cache/index.js';
import type { Redis } from 'ioredis';
import type { IdTokenVerifier, VerifiedIdentity } from '../../src/modules/auth/auth.ports.js';
import { testEnv } from './app.js';

export class FakeIdTokenVerifier implements IdTokenVerifier {
  /** token string → identity. Unknown tokens are rejected like an invalid Firebase token. */
  readonly identities = new Map<string, VerifiedIdentity>();
  async verify(idToken: string): Promise<VerifiedIdentity> {
    const i = this.identities.get(idToken);
    if (!i) {
      const { UnauthorizedError } = await import('../../src/core/errors/index.js');
      throw new UnauthorizedError('ID token invalid or expired', 'id_token_invalid');
    }
    return i;
  }
}

export interface FullApp {
  app: Express;
  deps: AppDeps;
  services: Services;
  realtimeDeps: RealtimeDeps;
  verifier: FakeIdTokenVerifier;
  userStatus: CachedUserStatus;
  http: () => ReturnType<typeof request>;
}

export function buildFullApp(
  envOverrides: Record<string, string | undefined> = {},
  overrides: Overrides = {},
  infra: { redis?: Redis; prefix?: string } = {},
): FullApp {
  const env = testEnv(envOverrides);
  const cache = infra.redis ? new RedisCache(infra.redis as never, `${infra.prefix ?? `t${Math.random().toString(36).slice(2, 7)}`}:cache:`) : new MemoryLruCache();
  const events = createEventBus();
  const userStatus = new CachedUserStatus(new MongoUserStatus(), cache, 1);
  events.on('user.banned', ({ userId }) => userStatus.invalidate(userId));
  const verifier = new FakeIdTokenVerifier();
  const deps: AppDeps = {
    env,
    log: createAsyncLogger({ level: 'silent', flushMs: 1000 }).logger,
    cache,
    events,
    metrics: new Metrics(false),
    tokens: new TokenService({ secret: env.JWT_SECRET, issuer: env.JWT_ISSUER, audience: env.JWT_AUDIENCE, accessTtlSeconds: env.ACCESS_TOKEN_TTL_SECONDS }),
    cursor: new CursorCodec(env.JWT_SECRET),
    rateStore: infra.redis ? new RedisRateStore(infra.redis as never, `${infra.prefix ?? `rl${Math.random().toString(36).slice(2, 7)}`}:rl:`) : new MemoryRateStore(),
    userStatus,
    apiKeys: new MongoApiKeyVerifier(cache),
    idempotencyStore: new MongoIdempotencyStore(),
    healthChecks: [],
  };
  const { app, services, realtime } = composeApp(deps, { idTokenVerifier: verifier, ...(infra.redis ? { redis: infra.redis } : {}), ...overrides });
  return { app, deps, services, realtimeDeps: realtime, verifier, userStatus, http: () => request(app) };
}

export const strongPassword = 'Tr0ub4dor&3-horse';

export async function registerUser(
  f: FullApp,
  username: string,
  extra: Record<string, unknown> = {},
): Promise<{ id: string; accessToken: string; refreshToken: string; bearer: string; user: Record<string, unknown> }> {
  const res = await f.http().post('/api/v1/auth/register').send({
    username,
    email: `${username}@example.com`,
    password: strongPassword,
    ...extra,
  });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  const { user, tokens } = res.body.data;
  return { id: user.id, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, bearer: `Bearer ${tokens.accessToken}`, user };
}

export async function makeAdmin(f: FullApp, username = 'boss') {
  const u = await registerUser(f, username);
  const { UserModel } = await import('../../src/infra/db/models/user.js');
  await UserModel.updateOne({ id: u.id }, { role: 'admin' });
  await f.userStatus.invalidate(u.id);
  return u;
}
