import type { Request, RequestHandler } from 'express';
import { ForbiddenError, UnauthorizedError } from '../core/errors/index.js';
import type { Cache } from '../core/cache/index.js';
import type { Role, TokenService } from '../core/security/tokens.js';
import { levelSatisfies, parseApiKey, type ApiKeyLevel } from '../core/security/api-key.js';

export interface UserStatus {
  role: Role;
  isBanned: boolean;
  username?: string;
}

/** Port: how authentication learns about the account behind a token. */
export interface UserStatusPort {
  get(userId: string): Promise<UserStatus | null>;
}

/** Decorator: caches status lookups briefly so auth does not hit the DB on every request. */
export class CachedUserStatus implements UserStatusPort {
  constructor(
    private readonly inner: UserStatusPort,
    private readonly cache: Cache,
    private readonly ttlSeconds = 15,
  ) {}

  async get(userId: string): Promise<UserStatus | null> {
    // `null` (unknown user) is cached too, as a sentinel, so token-spraying can't hammer the DB.
    return this.cache.wrap<UserStatus | null>(`ustatus:${userId}`, () => this.inner.get(userId), {
      ttl: this.ttlSeconds,
      tags: [`user:${userId}`],
    });
  }

  invalidate(userId: string): Promise<void> {
    return this.cache.invalidateTag(`user:${userId}`);
  }
}

const bearer = (req: Request): string | null => {
  const h = req.header('authorization');
  if (!h) return null;
  const [scheme, token, extra] = h.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token || extra !== undefined) return null;
  return token;
};

/** Lets logout / refresh-reuse kill access tokens before they expire (checked per request, cache-backed). */
export interface SessionRevocationPort {
  isRevoked(sessionId: string): Promise<boolean>;
}

export interface AuthenticateDeps {
  tokens: TokenService;
  users: UserStatusPort;
  revoked?: SessionRevocationPort | undefined;
}

/**
 * mode `required`: 401 without a valid token.
 * mode `optional`: attaches `req.auth` when a valid token is present, ignores a missing/invalid one.
 * Role always comes from the database (cached ~15 s), never from the token, so demotions and bans
 * apply almost immediately.
 */
export function authenticate(deps: AuthenticateDeps, mode: 'required' | 'optional'): RequestHandler {
  return async (req, _res, next) => {
    try {
      const token = bearer(req);
      if (!token) {
        if (mode === 'optional') return next();
        throw new UnauthorizedError('Missing bearer token');
      }
      let claims;
      try {
        claims = deps.tokens.verifyAccess(token);
      } catch (e) {
        if (mode === 'optional') return next();
        throw e;
      }
      if (deps.revoked && (await deps.revoked.isRevoked(claims.sid))) {
        if (mode === 'optional') return next();
        throw new UnauthorizedError('Session has ended', 'session_revoked');
      }
      const status = await deps.users.get(claims.sub);
      if (!status) {
        if (mode === 'optional') return next();
        throw new UnauthorizedError('Account no longer exists', 'account_not_found');
      }
      if (status.isBanned) {
        if (mode === 'optional') return next();
        throw new ForbiddenError('This account has been suspended', 'account_banned');
      }
      req.auth = { userId: claims.sub, role: status.role, sid: claims.sid, username: status.username ?? claims.username };
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function authorize(roles: readonly Role[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) return next(new UnauthorizedError());
    if (!roles.includes(req.auth.role)) return next(new ForbiddenError('Your role cannot perform this action', 'role_forbidden'));
    next();
  };
}

export interface VerifiedApiKey {
  id: string;
  level: ApiKeyLevel;
  scopes: string[];
}

/** Port implemented in modules/auth (API key repository + cache). */
export interface ApiKeyVerifier {
  verify(hash: string): Promise<VerifiedApiKey | null>;
}

/**
 * Leveled API keys.
 *  - `required` : header must be present and ≥ `level`.
 *  - otherwise  : header optional; if present it must be valid, and it *caps* the caller:
 *                 a `mobile` key can never reach a route that needs `admin`, even with an admin token.
 */
export function apiKeyGuard(verifier: ApiKeyVerifier, opts: { required?: ApiKeyLevel; cap?: ApiKeyLevel }): RequestHandler {
  return async (req, _res, next) => {
    try {
      const raw = req.header('x-api-key');
      if (!raw) {
        if (opts.required) throw new UnauthorizedError('API key required', 'api_key_required');
        return next();
      }
      const parsed = parseApiKey(raw);
      if (!parsed) throw new UnauthorizedError('API key invalid', 'api_key_invalid');
      const key = await verifier.verify(parsed.hash);
      if (!key || key.level !== parsed.level) throw new UnauthorizedError('API key invalid', 'api_key_invalid');
      const need = opts.required ?? opts.cap;
      if (need && !levelSatisfies(key.level, need)) {
        throw new ForbiddenError(`This endpoint needs an API key of level "${need}" or higher`, 'api_key_level_insufficient');
      }
      req.apiKey = { id: key.id, level: key.level, scopes: key.scopes };
      next();
    } catch (err) {
      next(err);
    }
  };
}
