import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { ModuleRegistrar } from '../../app.js';
import type { AuthService } from './auth.service.js';
import { authResultSchema } from './auth.schemas.js';
import { isWebClient, setRefreshCookie } from './cookies.js';
import type { WebAuthnService } from './webauthn.service.js';

/** The browser's JSON-serialised credential. The library validates the inner structure. */
const credentialJson = z.object({
  id: z.string().min(1).max(1024),
  rawId: z.string().min(1).max(1024),
  type: z.literal('public-key'),
  response: z.record(z.string(), z.unknown()),
  clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
  authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
});

export const webauthnRoutes = (webauthn: WebAuthnService, auth: AuthService): ModuleRegistrar => ({ v1, deps }) => {
  const ctx = (req: Request) => ({ ip: req.ip, userAgent: req.header('user-agent') });

  v1.add({
    method: 'post', path: '/auth/webauthn/register/options', summary: 'Start passkey registration (admin)', tags: ['auth', 'webauthn'],
    auth: 'admin', rateLimit: 'sensitive', body: 'none',
    handler: async ({ auth: who }) => ({ data: await webauthn.registrationOptions(who.userId) }),
  });

  v1.add({
    method: 'post', path: '/auth/webauthn/register/verify', summary: 'Finish passkey registration (admin)', tags: ['auth', 'webauthn'],
    auth: 'admin', rateLimit: 'sensitive',
    schema: { body: z.object({ credential: credentialJson, label: z.string().trim().min(1).max(60).optional() }) },
    handler: async ({ body, auth: who }) => ({
      status: 201,
      data: await webauthn.registrationVerify(who.userId, body.credential as unknown as RegistrationResponseJSON, body.label),
    }),
  });

  v1.add({
    method: 'post', path: '/auth/webauthn/login/options', summary: 'Start passkey sign-in (step-up token or username)', tags: ['auth', 'webauthn'],
    auth: 'public', rateLimit: 'auth',
    schema: { body: z.object({ challengeToken: z.string().min(16).max(128).optional(), username: z.string().min(1).max(64).optional() }) },
    handler: async ({ body }) => ({ data: await webauthn.loginOptions(body) }),
  });

  v1.add({
    method: 'post', path: '/auth/webauthn/login/verify', summary: 'Finish passkey sign-in', tags: ['auth', 'webauthn'],
    auth: 'public', rateLimit: 'auth',
    schema: { body: z.object({ challengeToken: z.string().min(16).max(128), credential: credentialJson }), response: authResultSchema },
    handler: async ({ body, req, res }: { body: { challengeToken: string; credential: unknown }; req: Request; res: Response }) => {
      const userId = await webauthn.loginVerify(body.challengeToken, body.credential as unknown as AuthenticationResponseJSON);
      const r = await auth.loginVerifiedUser(userId, ctx(req));
      if (isWebClient(req)) {
        setRefreshCookie(res, r.tokens.refreshToken, deps.env);
        const { refreshToken: _rt, ...rest } = r.tokens;
        return { data: { ...r, tokens: rest } };
      }
      return { data: r };
    },
  });

  v1.add({
    method: 'get', path: '/auth/webauthn/credentials', summary: 'List my passkeys (admin)', tags: ['auth', 'webauthn'],
    auth: 'admin',
    handler: async ({ auth: who }) => ({ data: await webauthn.list(who.userId) }),
  });

  v1.add({
    method: 'delete', path: '/auth/webauthn/credentials/:credentialId', summary: 'Remove a passkey (admin)', tags: ['auth', 'webauthn'],
    auth: 'admin', rateLimit: 'sensitive',
    schema: { params: z.object({ credentialId: z.string().min(1).max(1024) }) },
    handler: async ({ params, auth: who }) => {
      await webauthn.remove(who.userId, params.credentialId);
      return { status: 204 };
    },
  });

  v1.add({
    method: 'put', path: '/auth/webauthn/require', summary: 'Require a passkey for my sign-ins (admin)', tags: ['auth', 'webauthn'],
    auth: 'admin', rateLimit: 'sensitive',
    schema: { body: z.object({ required: z.boolean() }) },
    handler: async ({ body, auth: who }) => {
      await webauthn.setRequired(who.userId, body.required);
      return { data: { required: body.required } };
    },
  });
};
