import { parseEnv } from '../config/env.js';
import { buildContainer } from '../container.js';
import { composeApp } from '../compose.js';
import type { RouteDescription } from '../gateway/index.js';
import { buildOpenApi } from './openapi.js';

/** Builds the OpenAPI document without a database: composing the app only registers routes. */
export function generateOpenApi(): Record<string, unknown> {
  const env = parseEnv({
    NODE_ENV: 'test', MONGODB_URI: 'mongodb://127.0.0.1:27017/docs', JWT_SECRET: 'docs-only-secret-docs-only-secret-1234',
    LOG_LEVEL: 'silent', PUBLIC_URL: 'https://api.example.com',
  });
  const container = buildContainer(env);
  try {
    const { app } = composeApp(container.deps);
    const reg = app.locals.registries as { v1: { describe(): RouteDescription[] } };
    return buildOpenApi(reg.v1.describe(), { title: 'VibeMatch API', version: '2.0.0', serverUrl: '/api/v1' });
  } finally {
    container.logger.close();
  }
}
