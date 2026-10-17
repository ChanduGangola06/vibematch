import { client, unwrap } from '@/shared/api/client';
import type { SelfUser } from '@/shared/api/types';
import type { Tokens } from '@/features/session/SessionProvider';

export interface AuthSuccess {
  tokens: Tokens;
  user: SelfUser;
  isNewUser: boolean;
}

/** The server may demand a passkey instead of issuing tokens (admins with WebAuthn required). */
export class PasskeyRequiredError extends Error {
  constructor(readonly challengeToken: string) {
    super('This account requires a passkey. Sign in from the admin panel.');
    this.name = 'PasskeyRequiredError';
  }
}

type Authenticated = { status: 'authenticated'; user: SelfUser; tokens: { accessToken: string; expiresIn: number }; isNewUser: boolean };
const ok = (r: Authenticated): AuthSuccess => ({ tokens: { accessToken: r.tokens.accessToken, expiresIn: r.tokens.expiresIn }, user: r.user, isNewUser: r.isNewUser });

export async function login(identifier: string, password: string): Promise<AuthSuccess> {
  const r = await unwrap(client.POST('/auth/login', { body: { identifier, password } }));
  if (r.status === 'passkey_required') throw new PasskeyRequiredError(r.challengeToken);
  return ok(r as Authenticated);
}

export async function register(input: { username: string; email: string; password: string; name?: string; gender?: 'male' | 'female' | 'other' }): Promise<AuthSuccess> {
  return ok((await unwrap(client.POST('/auth/register', { body: input }))) as Authenticated);
}

export async function guest(): Promise<AuthSuccess> {
  return ok((await unwrap(client.POST('/auth/guest'))) as Authenticated);
}

export async function social(idToken: string, gender?: 'male' | 'female' | 'other'): Promise<AuthSuccess> {
  return ok((await unwrap(client.POST('/auth/social', { body: { idToken, ...(gender ? { gender } : {}) } }))) as Authenticated);
}

export async function checkUsername(username: string) {
  return unwrap(client.GET('/users/check-username', { params: { query: { username } } }));
}
