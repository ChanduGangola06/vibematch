import mongoose from 'mongoose';
import type { Env } from '../../config/env.js';
import type { Logger } from '../../core/logger/index.js';

export interface DbHealth {
  state: 'disconnected' | 'connected' | 'connecting' | 'disconnecting' | 'uninitialized';
  pingMs: number | null;
  poolMax: number;
}

const STATES: Record<number, DbHealth['state']> = {
  0: 'disconnected',
  1: 'connected',
  2: 'connecting',
  3: 'disconnecting',
  99: 'uninitialized',
};

/**
 * Connection pooling: the driver keeps `maxPoolSize` sockets open and multiplexes queries over
 * them, so requests never pay a TCP/TLS/auth handshake. Idle sockets are recycled after `maxIdleTimeMS`.
 */
export async function connectDb(env: Env, log?: Logger): Promise<typeof mongoose> {
  mongoose.set('strictQuery', true);
  mongoose.set('autoIndex', env.MONGO_AUTO_INDEX);

  mongoose.connection.on('disconnected', () => log?.warn('mongo disconnected'));
  mongoose.connection.on('reconnected', () => log?.info('mongo reconnected'));
  mongoose.connection.on('error', (err) => log?.error({ err }, 'mongo error'));

  await mongoose.connect(env.MONGODB_URI, {
    maxPoolSize: env.MONGO_MAX_POOL_SIZE,
    minPoolSize: env.MONGO_MIN_POOL_SIZE,
    maxIdleTimeMS: env.MONGO_MAX_IDLE_TIME_MS,
    serverSelectionTimeoutMS: env.MONGO_SERVER_SELECTION_TIMEOUT_MS,
    socketTimeoutMS: env.MONGO_SOCKET_TIMEOUT_MS,
    retryWrites: true,
    appName: 'vibematch-api',
  });
  log?.info({ db: mongoose.connection.name, poolMax: env.MONGO_MAX_POOL_SIZE }, 'mongo connected');
  return mongoose;
}

export async function dbHealth(poolMax = 0): Promise<DbHealth> {
  const state = STATES[mongoose.connection.readyState] ?? 'uninitialized';
  let pingMs: number | null = null;
  if (state === 'connected') {
    const t = performance.now();
    try {
      await mongoose.connection.db!.admin().ping();
      pingMs = Math.round((performance.now() - t) * 10) / 10;
    } catch {
      pingMs = null;
    }
  }
  return { state, pingMs, poolMax };
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}
