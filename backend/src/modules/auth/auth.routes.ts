import type { Request, Response } from 'express';
import { z } from 'zod';
import type { ModuleRegistrar } from '../../app.js';
import type { Env } from '../../config/env.js';
import { BadRequestError } from '../../core/errors/index.js';
import { selfUserSchema } from '../users/user.schemas.js';
import {
  authResultSchema, changePasswordBody, loginBody, loginResultSchema, logoutBody, refreshBody,
  registerBody, revokeBody, socialBody, tokenPairSchema, tokenRequestBody, type AuthResponse, type AuthResult,
} from './auth.schemas.js';
import type { AuthService } from './auth.service.js';
import { clearRefreshCookie, isWebClient, readCookie, REFRESH_COOKIE, setRefreshCookie } from './cookies.js';
import type { ClientContext, TokenPair } from './session.service.js';

const clientCtx = (req: Request): ClientContext & { countryCode?: string | undefined } => ({
  ip: req.ip,
  userAgent: req.header('user-agent'),
  countryCode: req.header('cf-ipcountry') ?? req.header('x-country-code') ?? undefined,
});

/** Web: refresh token goes to an httpOnly cookie and is stripped from the body. Mobile: body. */
function shapeTokens(req: Request, res: Response, tokens: TokenPair, env: Env): Omit<TokenPair, 'refreshToken'> & { refreshToken?: string } {
  if (isWebClient(req)) {
    setRefreshCookie(res, tokens.refreshToken, env);
    const { refreshToken: _rt, ...rest } = tokens;
    return rest;
  }
  return tokens;
}

export const authRoutes = (auth: AuthService): ModuleRegistrar => ({ v1, deps }) => {
  const env = deps.env;
  const shape = (req: Request, res: Response, r: AuthResult): AuthResponse => ({ ...r, tokens: shapeTokens(req, res, r.tokens, env) });

  v1.add({
    method: 'post', path: '/auth/register', summary: 'Create an account', tags: ['auth'],
    auth: 'public', rateLimit: 'auth',
    schema: { body: registerBody, response: authResultSchema },
    handler: async ({ body, req, res }) => ({ status: 201, data: shape(req, res, await auth.register(body, clientCtx(req))) }),
  });

  v1.add({
    method: 'post', path: '/auth/login', summary: 'Sign in with username/e-mail and password', tags: ['auth'],
    auth: 'public', rateLimit: 'auth',
    schema: { body: loginBody, response: loginResultSchema },
    handler: async ({ body, req, res }) => {
      const r = await auth.login(body, clientCtx(req));
      return { data: r.status === 'authenticated' ? shape(req, res, r) : r };
    },
  });

  v1.add({
    method: 'post', path: '/auth/guest', summary: 'Start a guest session', tags: ['auth'],
    auth: 'public', rateLimit: 'auth', body: 'none',
    schema: { response: authResultSchema },
    handler: async ({ req, res }) => ({ status: 201, data: shape(req, res, await auth.guest(clientCtx(req))) }),
  });

  v1.add({
    method: 'post', path: '/auth/social', summary: 'Sign in with a Firebase ID token (Google, Facebook, Apple, Twitter, phone)', tags: ['auth'],
    auth: 'public', rateLimit: 'auth',
    schema: { body: socialBody, response: authResultSchema },
    handler: async ({ body, req, res }) => {
      const r = await auth.social(body, clientCtx(req));
      return { status: r.isNewUser ? 201 : 200, data: shape(req, res, r) };
    },
  });

  v1.add({
    method: 'post', path: '/auth/refresh', summary: 'Rotate the refresh token and get a new access token', tags: ['auth'],
    auth: 'public', rateLimit: 'auth',
    schema: { body: refreshBody, response: z.object({ tokens: tokenPairSchema, user: selfUserSchema }) },
    handler: async ({ body, req, res }) => {
      const presented = body.refreshToken ?? readCookie(req, REFRESH_COOKIE);
      if (!presented) throw new BadRequestError('refreshToken is required');
      const r = await auth.refresh(presented, clientCtx(req));
      return { data: { user: r.user, tokens: shapeTokens(req, res, r.tokens, env) } };
    },
  });

  // --- RFC 6749 token endpoint (password + refresh_token grants) and RFC 7009 revocation -------------
  v1.add({
    method: 'post', path: '/auth/token', summary: 'OAuth 2.0 token endpoint (password, refresh_token grants)', tags: ['auth', 'oauth2'],
    auth: 'public', rateLimit: 'auth', body: 'form',
    schema: { body: tokenRequestBody },
    handler: async ({ body, req, res }) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Pragma', 'no-cache');
      let tokens: TokenPair;
      if (body.grant_type === 'password') {
        const r = await auth.login({ identifier: body.username, password: body.password }, clientCtx(req));
        if (r.status !== 'authenticated') throw new BadRequestError('This account requires a passkey; use /auth/webauthn/login/*');
        tokens = r.tokens;
      } else {
        tokens = (await auth.refresh(body.refresh_token, clientCtx(req))).tokens;
      }
      return {
        data: {
          access_token: tokens.accessToken,
          token_type: 'Bearer',
          expires_in: tokens.expiresIn,
          refresh_token: tokens.refreshToken,
        },
      };
    },
  });

  v1.add({
    method: 'post', path: '/auth/revoke', summary: 'OAuth 2.0 token revocation (RFC 7009)', tags: ['auth', 'oauth2'],
    auth: 'public', rateLimit: 'auth', body: 'form',
    schema: { body: revokeBody },
    // RFC 7009: always 200, even for unknown tokens.
    handler: async ({ body }) => {
      await auth.logout({ refreshToken: body.token });
      return { status: 200, data: {} };
    },
  });

  v1.add({
    method: 'post', path: '/auth/logout', summary: 'End the current session', tags: ['auth'],
    auth: 'optional', rateLimit: 'auth',
    schema: { body: logoutBody },
    handler: async ({ body, auth: who, req, res }) => {
      await auth.logout({ sid: who?.sid, refreshToken: body.refreshToken ?? readCookie(req, REFRESH_COOKIE) });
      clearRefreshCookie(res, env);
      return { status: 204 };
    },
  });

  v1.add({
    method: 'get', path: '/auth/me', summary: 'Current account', tags: ['auth'],
    auth: 'user', roles: ['guest', 'user', 'admin'],
    schema: { response: selfUserSchema },
    handler: async ({ auth: who }) => ({ data: await auth.me(who.userId) }),
  });

  v1.add({
    method: 'put', path: '/auth/password', summary: 'Change password (signs out other sessions)', tags: ['auth'],
    auth: 'user', rateLimit: 'sensitive',
    schema: { body: changePasswordBody },
    handler: async ({ body, auth: who }) => {
      await auth.changePassword(who.userId, who.sid, body.oldPassword, body.newPassword);
      return { status: 204 };
    },
  });
};
