import express, { type Express } from 'express';
import path from 'node:path';
import type { Env } from './config/env.js';
import type { Cache } from './core/cache/index.js';
import type { AppEventBus } from './core/events/index.js';
import { versionNegotiation, type Metrics } from './core/http/index.js';
import type { Logger } from './core/logger/index.js';
import type { CursorCodec } from './core/pagination/index.js';
import type { TokenService } from './core/security/tokens.js';
import { RouteRegistry, type PipelineDeps } from './gateway/index.js';
import { accessLog } from './middleware/access-log.js';
import type { ApiKeyVerifier, SessionRevocationPort, UserStatusPort } from './middleware/authenticate.js';
import { errorHandler, notFound } from './middleware/error-handler.js';
import { IdempotencyService, type IdempotencyStore } from './middleware/idempotency.js';
import { createPolicies, type RateLimitStore } from './middleware/rate-limit.js';
import { requestId } from './middleware/request-id.js';
import { compress, corsAllowList, enforceHttps, noStore, parseTrustProxy, securityHeaders } from './middleware/security.js';

export const API_VERSION = '1';
export const API_PREFIX = `/api/v${API_VERSION}`;

export interface HealthCheck {
  name: string;
  run(): Promise<{ ok: boolean; detail?: Record<string, unknown> }>;
}

/** Everything the application needs, injected — so tests can swap any piece. */
export interface AppDeps {
  env: Env;
  log: Logger;
  cache: Cache;
  events: AppEventBus;
  metrics: Metrics;
  tokens: TokenService;
  cursor: CursorCodec;
  rateStore: RateLimitStore;
  userStatus: UserStatusPort;
  apiKeys: ApiKeyVerifier;
  sessionRevocations?: SessionRevocationPort;
  idempotencyStore: IdempotencyStore;
  healthChecks: HealthCheck[];
  /** Directory served at /images and /videos (local storage). */
  publicDir?: string;
}

export interface ModuleContext {
  /** Routes served under /api/v1 */
  v1: RouteRegistry;
  /** Unversioned operational routes (/health/*, /metrics) */
  root: RouteRegistry;
  deps: AppDeps;
}
export type ModuleRegistrar = (ctx: ModuleContext) => void;

/**
 * Builds the Express app. No listening, no I/O — safe to call from tests.
 * Pipeline: requestId → accessLog → https → helmet → cors → compression → static → no-store
 *           → global rate limit → routes (per-route chain) → 404 → problem+json errors.
 */
export function createApp(deps: AppDeps, modules: ModuleRegistrar[]): Express {
  const { env } = deps;
  const app = express();

  app.disable('x-powered-by');
  app.disable('etag');
  app.set('trust proxy', parseTrustProxy(env.TRUST_PROXY));
  app.set('query parser', 'simple'); // flat query strings only: no `?a[$ne]=1` operator injection

  app.use(requestId());
  app.use(accessLog(deps.log, deps.metrics));
  app.use(enforceHttps(env));
  app.use(securityHeaders(env));
  app.use(corsAllowList(env));
  app.use(compress());

  if (deps.publicDir) {
    const opts = { maxAge: '30d', immutable: true, index: false, dotfiles: 'ignore' as const, fallthrough: true };
    app.use('/images', express.static(path.join(deps.publicDir, 'images'), opts));
    app.use('/videos', express.static(path.join(deps.publicDir, 'videos'), opts));
  }

  app.use(noStore);

  const policies = createPolicies(env, deps.rateStore);
  app.use(policies.global);

  const pipeline: PipelineDeps = {
    authDeps: { tokens: deps.tokens, users: deps.userStatus, revoked: deps.sessionRevocations },
    apiKeys: deps.apiKeys,
    policies,
    idempotency: new IdempotencyService(deps.idempotencyStore),
    adminIpAllowlist: env.ADMIN_IP_ALLOWLIST,
    bodyLimit: env.BODY_LIMIT,
    validateResponses: !env.isProd,
    readOnlyAdmin: env.DEMO_MODE,
  };

  const v1 = new RouteRegistry();
  const root = new RouteRegistry();
  const ctx: ModuleContext = { v1, root, deps };
  for (const register of modules) register(ctx);

  root.mount(app, pipeline);

  const v1Router = express.Router();
  v1Router.use(versionNegotiation({ supported: [API_VERSION], current: API_VERSION }, API_VERSION));
  v1.mount(v1Router, pipeline);
  app.use(API_PREFIX, v1Router);

  // Remember the registries so tooling (OpenAPI generation, boot self-checks) can inspect them.
  app.locals.registries = { v1, root };

  app.use(notFound);
  app.use(errorHandler(env));
  return app;
}
