import type { Redis } from 'ioredis';
import path from 'node:path';
import type { AppDeps, HealthCheck } from './app.js';
import type { Env } from './config/env.js';
import { MemoryLruCache, RedisCache, type Cache } from './core/cache/index.js';
import { createEventBus } from './core/events/index.js';
import { Metrics } from './core/http/index.js';
import { createAsyncLogger, type AsyncLogger } from './core/logger/index.js';
import { CursorCodec } from './core/pagination/index.js';
import { TokenService } from './core/security/tokens.js';
import { dbHealth } from './infra/db/connection.js';
import { MongoApiKeyVerifier } from './infra/db/api-key-verifier.js';
import { MongoIdempotencyStore } from './infra/db/idempotency-store.js';
import { MongoUserStatus } from './infra/db/user-status.js';
import { createRedis } from './infra/redis/client.js';
import { CachedUserStatus } from './middleware/authenticate.js';
import { MemoryRateStore, RedisRateStore, type RateLimitStore } from './middleware/rate-limit.js';

export interface Container {
  deps: AppDeps;
  redis: Redis | undefined;
  logger: AsyncLogger;
  shutdown(): Promise<void>;
}

/**
 * Composition root: the only place that knows which concrete implementation is used.
 * Redis present → shared cache + rate limits (multi-instance); absent → in-process equivalents.
 */
export function buildContainer(env: Env): Container {
  const logger = createAsyncLogger({ level: env.LOG_LEVEL, flushMs: env.LOG_FLUSH_MS });
  const log = logger.logger;
  const redis = createRedis(env.REDIS_URL, log);

  const cache: Cache = redis
    ? new RedisCache(redis as never, 'vm:cache:', env.CACHE_TTL_SECONDS)
    : new MemoryLruCache({ defaultTtlSeconds: env.CACHE_TTL_SECONDS });
  const memoryRate = redis ? undefined : new MemoryRateStore();
  const rateStore: RateLimitStore = redis ? new RedisRateStore(redis as never) : memoryRate!;

  const events = createEventBus(log);
  const userStatus = new CachedUserStatus(new MongoUserStatus(), cache);
  events.on('user.banned', ({ userId }) => userStatus.invalidate(userId));
  events.on('user.deleted', ({ userId }) => userStatus.invalidate(userId));

  const healthChecks: HealthCheck[] = [
    {
      name: 'mongo',
      run: async () => {
        const h = await dbHealth(env.MONGO_MAX_POOL_SIZE);
        return { ok: h.state === 'connected' && h.pingMs !== null, detail: { pingMs: h.pingMs, poolMax: h.poolMax } };
      },
    },
  ];
  if (redis) {
    healthChecks.push({ name: 'redis', run: async () => ({ ok: (await redis.ping()) === 'PONG' }) });
  }

  const deps: AppDeps = {
    env,
    log,
    cache,
    events,
    metrics: new Metrics(true),
    tokens: new TokenService({
      secret: env.JWT_SECRET,
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      accessTtlSeconds: env.ACCESS_TOKEN_TTL_SECONDS,
    }),
    cursor: new CursorCodec(env.JWT_SECRET),
    rateStore,
    userStatus,
    apiKeys: new MongoApiKeyVerifier(cache),
    idempotencyStore: new MongoIdempotencyStore(),
    healthChecks,
    publicDir: path.resolve(process.cwd(), 'public'),
  };

  return {
    deps,
    redis,
    logger,
    async shutdown() {
      memoryRate?.close();
      events.clear();
      if (redis) await redis.quit().catch(() => redis.disconnect());
    },
  };
}
