import compression from 'compression';
import cors from 'cors';
import type { RequestHandler } from 'express';
import helmet from 'helmet';
import type { Env } from '../config/env.js';
import { AppError } from '../core/errors/index.js';

/** `TRUST_PROXY` env → Express setting. Never accepts `true` (it would trust any X-Forwarded-For). */
export function parseTrustProxy(value: string): boolean | number | string | string[] {
  const v = value.trim();
  if (v === 'false' || v === '') return false;
  if (v === 'true') throw new Error('TRUST_PROXY=true would trust spoofable X-Forwarded-For; use a hop count or CIDR list');
  if (/^\d+$/.test(v)) return Number(v);
  return v.includes(',') ? v.split(',').map((s) => s.trim()) : v;
}

/**
 * HTTPS enforcement. TLS is terminated at the edge (nginx / LB); with `trust proxy` configured,
 * `req.secure` reflects X-Forwarded-Proto. Plain-HTTP GET/HEAD are redirected, other methods are
 * refused so credentials in a body never travel in the clear.
 */
export function enforceHttps(env: Env): RequestHandler {
  return (req, res, next) => {
    if (!env.isProd || req.secure || req.path === '/health/live') return next();
    if (req.method === 'GET' || req.method === 'HEAD') {
      const host = new URL(env.PUBLIC_URL).host;
      return res.redirect(308, `https://${host}${req.originalUrl}`);
    }
    return next(new AppError(400, 'https_required', 'HTTPS required', { detail: 'Use https:// for all API calls' }));
  };
}

export function securityHeaders(env: Env): RequestHandler {
  return helmet({
    // The API serves JSON (and static media), never HTML: lock everything down.
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'cross-origin' }, // avatars/gifts are embedded by the web app
    hsts: env.isProd ? { maxAge: 31_536_000, includeSubDomains: true, preload: true } : false,
    referrerPolicy: { policy: 'no-referrer' },
    xPoweredBy: false,
  } as Parameters<typeof helmet>[0]);
}

export function corsAllowList(env: Env): RequestHandler {
  const allowed = new Set([...env.corsOrigins, ...(env.isProd ? [] : [env.PUBLIC_URL])]);
  return cors({
    origin(origin, cb) {
      // No Origin header = native app / curl / server-to-server: CORS does not apply.
      if (!origin) return cb(null, false);
      cb(null, allowed.has(origin));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-API-Key', 'Idempotency-Key', 'Accept-Version', 'X-Request-Id'],
    exposedHeaders: [
      'X-Request-Id', 'API-Version', 'Idempotent-Replayed', 'Retry-After',
      'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'Deprecation', 'Sunset',
    ],
    maxAge: 600,
    optionsSuccessStatus: 204,
  });
}

/** gzip/deflate responses ≥ 1 KB; clients opt out with `x-no-compression`. */
export function compress(): RequestHandler {
  return compression({
    threshold: 1024,
    filter: (req, res) => (req.headers['x-no-compression'] ? false : compression.filter(req, res)),
  });
}

/** Never let intermediaries cache API responses unless a route explicitly says otherwise. */
export const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
};
