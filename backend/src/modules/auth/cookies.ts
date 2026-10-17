import type { Request, Response } from 'express';
import type { Env } from '../../config/env.js';

export const REFRESH_COOKIE = 'vm_rt';
const COOKIE_PATH = '/api/v1/auth';

/** Tiny cookie reader — we only ever read our own refresh cookie. */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.header('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0 && part.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * Browsers get the refresh token as an httpOnly, SameSite=Strict cookie scoped to the auth routes,
 * so page JavaScript (and therefore XSS) can never read it. Mobile clients use the JSON body instead.
 */
export function setRefreshCookie(res: Response, token: string, env: Env): void {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: env.isProd,
    sameSite: 'strict',
    path: COOKIE_PATH,
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86_400_000,
  });
}

export function clearRefreshCookie(res: Response, env: Env): void {
  res.clearCookie(REFRESH_COOKIE, { httpOnly: true, secure: env.isProd, sameSite: 'strict', path: COOKIE_PATH });
}

export const isWebClient = (req: Request): boolean => req.header('x-client-type')?.toLowerCase() === 'web';
