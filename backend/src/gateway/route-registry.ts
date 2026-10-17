import express, { type RequestHandler, type Response, type Router, type Request } from 'express';
import type { z} from 'zod';
import { type ZodType } from 'zod';
import { AppError, ForbiddenError, UnauthorizedError } from '../core/errors/index.js';
import type { OffsetMeta, PageMeta } from '../core/pagination/index.js';
import type { ApiKeyLevel } from '../core/security/api-key.js';
import type { Role } from '../core/security/tokens.js';
import type { AuthContext } from '../core/http/types.js';
import { type IdempotencyMode, type IdempotencyService } from '../middleware/idempotency.js';
import { sanitizeBody } from '../middleware/sanitize.js';
import { authorize, authenticate, apiKeyGuard, type ApiKeyVerifier, type AuthenticateDeps } from '../middleware/authenticate.js';
import type { PolicyName } from '../middleware/rate-limit.js';
import { ipAllowlist } from '../middleware/ip-allowlist.js';
import { ResponseBuilder } from '../core/http/response.js';

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';
/**
 * public   – no authentication
 * optional – token optional, attached when valid
 * user     – any authenticated account whose role is in `roles` (default user + admin)
 * admin    – role admin only (+ admin rate-limit and IP allow-list)
 */
export type AuthMode = 'public' | 'optional' | 'user' | 'admin';

export interface RouteSchemas {
  params?: ZodType;
  query?: ZodType;
  body?: ZodType;
  /** Validated in development/test only, to catch contract drift early. */
  response?: ZodType;
}

type Out<S, K extends keyof RouteSchemas, Fallback> = S extends { [P in K]: infer T }
  ? T extends ZodType
    ? z.output<T>
    : Fallback
  : Fallback;

export interface HandlerContext<S extends RouteSchemas, A extends AuthMode> {
  params: Out<S, 'params', Record<string, string>>;
  query: Out<S, 'query', Record<string, string>>;
  body: Out<S, 'body', undefined>;
  auth: A extends 'user' | 'admin' ? AuthContext : AuthContext | undefined;
  req: Request;
  res: Response;
}

export interface RouteResult {
  status?: number;
  data?: unknown;
  page?: PageMeta | OffsetMeta;
  headers?: Record<string, string>;
}

/** Return from a handler that wrote the response itself (streams, redirects, files). */
export const HANDLED = Symbol('handled');

export interface RouteDef<S extends RouteSchemas = RouteSchemas, A extends AuthMode = AuthMode> {
  method: HttpMethod;
  path: string;
  summary: string;
  tags?: string[];
  auth: A;
  /** For `auth: 'user'`. Defaults to ['user', 'admin']; guests must be listed explicitly. */
  roles?: Role[];
  /** Header `X-API-Key` required with at least this level. */
  apiKey?: ApiKeyLevel;
  rateLimit?: PolicyName;
  idempotent?: IdempotencyMode;
  /** How the body is read. Default `json`. `multipart` requires `middleware`. */
  body?: 'json' | 'form' | 'raw' | 'none';
  /** Extra middleware run after authorization (e.g. multer upload). */
  middleware?: RequestHandler[];
  schema?: S;
  /** OpenAPI-only: describe a request body the schema cannot express (multipart uploads). */
  docs?: { requestBody?: Record<string, unknown> };
  handler: (ctx: HandlerContext<S, A>) => Promise<RouteResult | typeof HANDLED | void>;
}

export interface PipelineDeps {
  authDeps: AuthenticateDeps;
  apiKeys: ApiKeyVerifier;
  policies: Record<PolicyName, RequestHandler>;
  idempotency: IdempotencyService;
  adminIpAllowlist: readonly string[];
  bodyLimit: string;
  validateResponses: boolean;
  /** DEMO_MODE: the public demo instance must not be changed through the admin API. */
  readOnlyAdmin?: boolean;
}

export interface RouteDescription {
  method: HttpMethod;
  path: string;
  summary: string;
  tags: string[];
  auth: AuthMode;
  roles: Role[];
  apiKey: ApiKeyLevel | undefined;
  rateLimit: PolicyName;
  idempotent: IdempotencyMode | undefined;
  schema: RouteSchemas;
  docs: { requestBody?: Record<string, unknown> };
  /** Body encoding the pipeline expects. */
  body: 'json' | 'form' | 'raw' | 'none';
}

const METHODS: readonly HttpMethod[] = ['get', 'post', 'put', 'patch', 'delete'];
const AUTH_MODES: readonly AuthMode[] = ['public', 'optional', 'user', 'admin'];
const HAS_BODY = new Set<HttpMethod>(['post', 'put', 'patch']);

/** Zod objects are made strict so unknown keys are rejected (whitelisting, mass-assignment guard). */
function strictify(schema: ZodType | undefined): ZodType | undefined {
  if (!schema) return schema;
  const s = schema as unknown as { strict?: () => ZodType; _zod?: { def?: { type?: string } } };
  return s._zod?.def?.type === 'object' && typeof s.strict === 'function' ? s.strict() : schema;
}

/**
 * The API gateway's route table. Routes can only be declared through `add`, which refuses
 * anything without an explicit auth mode (deny by default), and every route runs through the same
 * ordered pipeline when mounted.
 */
export class RouteRegistry {
  private readonly routes: RouteDef<RouteSchemas, AuthMode>[] = [];

  add<S extends RouteSchemas, A extends AuthMode>(def: RouteDef<S, A>): this {
    this.assertValid(def as RouteDef);
    const normalized = {
      ...def,
      schema: def.schema
        ? { ...def.schema, params: strictify(def.schema.params), query: strictify(def.schema.query), body: strictify(def.schema.body) }
        : undefined,
    } as unknown as RouteDef;
    this.routes.push(normalized);
    return this;
  }

  private assertValid(def: RouteDef): void {
    const id = `${String(def.method).toUpperCase()} ${def.path}`;
    if (!METHODS.includes(def.method)) throw new Error(`Route ${id}: invalid method`);
    if (!def.path?.startsWith('/')) throw new Error(`Route ${id}: path must start with "/"`);
    if (!def.summary) throw new Error(`Route ${id}: summary is required`);
    if (!AUTH_MODES.includes(def.auth)) {
      throw new Error(`Route ${id}: "auth" must be declared (${AUTH_MODES.join(' | ')}) — routes are deny-by-default`);
    }
    if (typeof def.handler !== 'function') throw new Error(`Route ${id}: handler missing`);
    if (def.roles && def.auth !== 'user') throw new Error(`Route ${id}: "roles" only applies to auth: 'user'`);
    if (def.auth === 'public' && def.method !== 'get' && def.idempotent === 'required') {
      // allowed: public POSTs (e.g. contact) may still demand keys
    }
    if (this.routes.some((r) => r.method === def.method && r.path === def.path)) {
      throw new Error(`Route ${id}: declared twice`);
    }
  }

  describe(): RouteDescription[] {
    return this.routes.map((r) => ({
      method: r.method,
      path: r.path,
      summary: r.summary,
      tags: r.tags ?? [],
      auth: r.auth,
      roles: r.auth === 'admin' ? ['admin'] : (r.roles ?? ['user', 'admin']),
      apiKey: r.apiKey,
      rateLimit: r.rateLimit ?? (r.auth === 'admin' ? 'admin' : 'user'),
      idempotent: r.idempotent,
      schema: r.schema ?? {},
      docs: r.docs ?? {},
      body: r.body ?? 'json',
    }));
  }

  get size(): number {
    return this.routes.length;
  }

  mount(router: Router, deps: PipelineDeps): Router {
    for (const def of this.routes) {
      const chain = this.buildChain(def, deps);
      router[def.method](def.path, ...chain);
    }
    return router;
  }

  private buildChain(def: RouteDef, deps: PipelineDeps): RequestHandler[] {
    const chain: RequestHandler[] = [];
    const routeId = `${def.method.toUpperCase()} ${def.path}`;

    chain.push((req, _res, next) => {
      req.routePattern = def.path;
      next();
    });

    // 1. body (before auth so per-account limiters can see the username; size-capped)
    const bodyKind = def.body ?? 'json';
    if (HAS_BODY.has(def.method) && bodyKind === 'json') {
      chain.push(express.json({ limit: deps.bodyLimit, strict: true, type: ['application/json', 'application/*+json'] }));
      chain.push(sanitizeBody);
    } else if (HAS_BODY.has(def.method) && bodyKind === 'form') {
      chain.push(express.urlencoded({ extended: false, limit: deps.bodyLimit, parameterLimit: 50 }));
      chain.push(sanitizeBody);
    } else if (bodyKind === 'raw') {
      chain.push(express.raw({ type: '*/*', limit: deps.bodyLimit }));
    }

    // 2. API key (optional unless required; always caps the level on admin routes)
    chain.push(
      apiKeyGuard(deps.apiKeys, {
        ...(def.apiKey ? { required: def.apiKey } : {}),
        ...(def.auth === 'admin' ? { cap: 'admin' as const } : {}),
      }),
    );

    // 3. authentication + authorization
    if (def.auth !== 'public') chain.push(authenticate(deps.authDeps, def.auth === 'optional' ? 'optional' : 'required'));
    if (def.auth === 'admin') chain.push(authorize(['admin']));
    if (def.auth === 'user') chain.push(authorize(def.roles ?? ['user', 'admin']));
    if (def.auth === 'admin') chain.push(ipAllowlist(deps.adminIpAllowlist));
    if (def.auth === 'admin' && def.method !== 'get' && deps.readOnlyAdmin) {
      chain.push((_req, _res, next) => next(new ForbiddenError('Demo mode is enabled: changes are disabled', 'demo_mode')));
    }

    // 4. rate limit
    // The global per-IP limiter already ran for every request; don't charge it a second time.
    const policy = def.rateLimit ?? (def.auth === 'admin' ? 'admin' : 'user');
    if (policy !== 'global') chain.push(deps.policies[policy]);

    // 5. route-specific middleware (uploads …)
    if (def.middleware?.length) chain.push(...def.middleware);

    // 6. validate + idempotency + handler
    chain.push(this.terminal(def, deps, routeId));
    return chain;
  }

  private terminal(def: RouteDef, deps: PipelineDeps, routeId: string): RequestHandler {
    const schema = def.schema ?? {};
    return async (req, res) => {
      const params = schema.params ? schema.params.parse(req.params) : req.params;
      const query = schema.query ? schema.query.parse(req.query) : req.query;
      const body = schema.body ? schema.body.parse(req.body ?? {}) : undefined;

      let idem: Extract<Awaited<ReturnType<IdempotencyService['begin']>>, { kind: 'proceed' }> | undefined;
      if (def.idempotent) {
        const outcome = await deps.idempotency.begin(req, def.idempotent, routeId);
        if (outcome.kind === 'replay') {
          res.setHeader('Idempotent-Replayed', 'true');
          if (outcome.status === 204) return void res.status(204).end();
          return void res.status(outcome.status).json(outcome.body);
        }
        idem = outcome;
      }

      try {
        const result = await def.handler({
          params, query, body, auth: req.auth as AuthContext, req, res,
        } as never);
        if (result === HANDLED || res.headersSent) {
          await idem?.complete(res.statusCode, null);
          return;
        }
        const r: RouteResult = result ?? {};
        const status = r.status ?? 200;
        if (deps.validateResponses && schema.response && r.data !== undefined) {
          // A response that violates its own contract is a server bug (500), never a client error (422).
          const check = schema.response.safeParse(r.data);
          if (!check.success) {
            throw new AppError(500, 'response_contract_violation', 'Internal server error', { detail: check.error.message, cause: check.error });
          }
        }

        if (status === 204 || r.data === undefined) {
          for (const [k, v] of Object.entries(r.headers ?? {})) res.setHeader(k, v);
          res.status(status === 200 ? 204 : status).end();
          await idem?.complete(status === 200 ? 204 : status, null);
          return;
        }
        const builder = new ResponseBuilder(r.data).status(status);
        if (r.page) builder.page(r.page);
        for (const [k, v] of Object.entries(r.headers ?? {})) builder.header(k, v);
        const built = builder.build(req.id);
        for (const [k, v] of Object.entries(built.headers)) res.setHeader(k, v);
        await idem?.complete(built.status, built.body);
        res.status(built.status).json(built.body);
      } catch (err) {
        await idem?.release().catch(() => {});
        throw err;
      }
    };
  }
}

/** Convenience for handlers: guard that throws if the account is not an admin. */
export function requireAdmin(auth: AuthContext | undefined): AuthContext {
  if (!auth) throw new UnauthorizedError();
  if (auth.role !== 'admin') throw new ForbiddenError();
  return auth;
}
