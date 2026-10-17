import { z } from 'zod';
import type { TokenPair } from './session.service.js';
import { selfUserSchema, emailSchema, genderSchema, passwordSchema, usernameSchema } from '../users/user.schemas.js';

export const SOCIAL_PROVIDERS = ['google', 'facebook', 'apple', 'twitter', 'phone'] as const;
export type SocialProvider = (typeof SOCIAL_PROVIDERS)[number];

export const registerBody = z.object({
  username: usernameSchema,
  email: emailSchema,
  password: passwordSchema,
  name: z.string().trim().min(1).max(60).optional(),
  gender: genderSchema.optional(),
  age: z.number().int().min(13).max(120).optional(),
});
export type RegisterInput = z.infer<typeof registerBody>;

export const loginBody = z.object({
  /** Username or e-mail address. */
  identifier: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(200),
});
export type LoginInput = z.infer<typeof loginBody>;

export const socialBody = z.object({
  /** Firebase ID token obtained by the client SDK after the provider sign-in. */
  idToken: z.string().min(20).max(4096),
  gender: genderSchema.optional(),
});
export type SocialInput = z.infer<typeof socialBody>;

export const refreshBody = z.object({ refreshToken: z.string().min(20).max(200).optional() });
export const logoutBody = z.object({ refreshToken: z.string().min(20).max(200).optional() });

export const changePasswordBody = z.object({
  oldPassword: z.string().min(1).max(200),
  newPassword: passwordSchema,
});

/** RFC 6749 §4.3 / §6 token request (accepts JSON or application/x-www-form-urlencoded). */
export const tokenRequestBody = z.discriminatedUnion('grant_type', [
  z.object({ grant_type: z.literal('password'), username: z.string().min(1).max(254), password: z.string().min(1).max(200), scope: z.string().optional() }),
  z.object({ grant_type: z.literal('refresh_token'), refresh_token: z.string().min(20).max(200), scope: z.string().optional() }),
]);
export type TokenRequest = z.infer<typeof tokenRequestBody>;

/** RFC 7009 token revocation. */
export const revokeBody = z.object({ token: z.string().min(20).max(200), token_type_hint: z.enum(['refresh_token']).optional() });

export const tokenPairSchema = z.object({
  accessToken: z.string(),
  tokenType: z.literal('Bearer'),
  expiresIn: z.number(),
  /** Omitted for web clients: the refresh token travels in an httpOnly cookie. */
  refreshToken: z.string().optional(),
});

export const authResultSchema = z.object({
  status: z.literal('authenticated'),
  user: selfUserSchema,
  tokens: tokenPairSchema,
  isNewUser: z.boolean(),
});

export const passkeyRequiredSchema = z.object({
  status: z.literal('passkey_required'),
  /** Short-lived handle to continue with POST /auth/webauthn/login/options. */
  challengeToken: z.string(),
});

export const loginResultSchema = z.union([authResultSchema, passkeyRequiredSchema]);

/** What the service returns (always has the refresh token) vs. what is sent over the wire (web: cookie only). */
export type AuthResponse = z.infer<typeof authResultSchema>;
export type AuthResult = Omit<AuthResponse, 'tokens'> & { tokens: TokenPair };
export type PasskeyRequired = z.infer<typeof passkeyRequiredSchema>;
