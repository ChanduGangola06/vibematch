import { Redis } from 'ioredis';
import { RedisMemoryServer } from 'redis-memory-server';

let server: RedisMemoryServer | undefined;
const clients: Redis[] = [];

/** Starts a REAL Redis (compiled on first use, then cached) — fakes cannot catch Lua / protocol mistakes. */
export async function startTestRedis(): Promise<Redis> {
  server = await RedisMemoryServer.create();
  return newRedis();
}

export async function newRedis(): Promise<Redis> {
  const c = new Redis({ host: await server!.getHost(), port: await server!.getPort(), maxRetriesPerRequest: 2 });
  clients.push(c);
  return c;
}

export async function stopTestRedis(): Promise<void> {
  for (const c of clients) c.disconnect();
  clients.length = 0;
  await server?.stop();
  server = undefined;
}
