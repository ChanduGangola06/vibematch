import http from 'node:http';
import { EnvError, getEnv } from './config/env.js';
import { buildContainer } from './container.js';
import { connectDb, disconnectDb } from './infra/db/connection.js';
import { composeApp } from './compose.js';
import { attachRealtime } from './realtime/realtime.js';

const SHUTDOWN_GRACE_MS = 10_000;

async function main(): Promise<void> {
  const env = getEnv();
  const container = buildContainer(env);
  const { log } = container.deps;

  await connectDb(env, log);
  const { app, realtime: realtimeDeps } = composeApp(container.deps, { redis: container.redis });
  const server = http.createServer(app);
  const realtime = attachRealtime(server, realtimeDeps);
  // Keep-alive longer than typical LB idle timeouts to avoid sporadic 502s from the edge.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 30_000;

  await new Promise<void>((resolve) => server.listen(env.PORT, env.HOST, resolve));
  log.info({ port: env.PORT, env: env.NODE_ENV }, 'api listening');

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    log.info({ signal }, 'shutting down');
    const force = setTimeout(() => {
      log.error('forced exit after grace period');
      container.logger.close();
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    force.unref();
    try {
      // Socket.IO's close() also stops the HTTP listener; drop idle keep-alive sockets so it can finish.
      server.closeIdleConnections();
      const closed = realtime.close();
      setTimeout(() => server.closeAllConnections(), 3000).unref();
      await closed;
      await container.shutdown();
      await disconnectDb();
    } finally {
      container.logger.close();
      clearTimeout(force);
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => log.error({ err }, 'unhandledRejection'));
}

main().catch((err) => {
  // Logger may not exist yet (bad env), so write straight to stderr.
  process.stderr.write(`${err instanceof EnvError ? err.message : String((err as Error).stack ?? err)}\n`);
  process.exit(1);
});
