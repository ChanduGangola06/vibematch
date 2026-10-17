import { Redis } from 'ioredis';
import type { Logger } from '../../core/logger/index.js';

/** Optional shared Redis connection. Returns undefined when REDIS_URL is not configured. */
export function createRedis(url: string | undefined, log?: Logger): Redis | undefined {
  if (!url) return undefined;
  const client = new Redis(url, {
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
    lazyConnect: false,
    retryStrategy: (times) => Math.min(times * 200, 3000),
  });
  client.on('error', (err) => log?.error({ err: err.message }, 'redis error'));
  client.on('ready', () => log?.info('redis ready'));
  return client;
}
