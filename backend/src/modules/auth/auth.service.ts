import type { Env } from '../../config/env.js';
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  TooManyRequestsError,
  UnauthorizedError,
} from '../../core/errors/index.js';
import type { AppEventBus } from '../../core/events/index.js';
import { hashPassword, verifyPassword } from '../../core/security/index.js';
import { uuidv7 } from '../../core/utils/id.js';
import type { UserRecord, UserRepository } from '../users/user.repository.js';
import { toSelfUser } from '../users/user.mapper.js';
import type { AuthFlags, IdTokenVerifier, PasskeyGate } from './auth.ports.js';
import type { AuthResult, LoginInput, PasskeyRequired, RegisterInput, SocialInput } from './auth.schemas.js';
import type { ClientContext, SessionService } from './session.service.js';

export interface AuthDeps {
  env: Env;
  users: UserRepository;
  sessions: SessionService;
  events: AppEventBus;
  flags: AuthFlags;
  verifier: IdTokenVerifier;
  passkeys?: PasskeyGate | undefined;
}


const defaultAvatar = (gender: string | undefined): string => {
  const g = gender === 'male' || gender === 'female' ? gender : Math.random() < 0.5 ? 'male' : 'female';
  return `/images/avatars/${g}-${Math.floor(Math.random() * 10) + 1}.svg`;
};

const duplicateField = (err: unknown): 'username' | 'email' | null => {
  const e = err as { code?: number; keyPattern?: Record<string, unknown> };
  if (e?.code !== 11000) return null;
  return e.keyPattern && 'emailLower' in e.keyPattern ? 'email' : 'username';
};

/** Country name from an edge-provided ISO code (CDN header) — no outbound geo-IP lookups. */
export function countryFromCode(code: string | undefined): { country: string; countryCode: string } {
  if (!code || !/^[A-Za-z]{2}$/.test(code) || code.toUpperCase() === 'XX') return { country: '', countryCode: '' };
  const cc = code.toUpperCase();
  try {
    return { country: new Intl.DisplayNames(['en'], { type: 'region' }).of(cc) ?? '', countryCode: cc };
  } catch {
    return { country: '', countryCode: cc };
  }
}

export class AuthService {
  constructor(private readonly d: AuthDeps) {}

  private async success(user: UserRecord, ctx: ClientContext, isNewUser: boolean): Promise<AuthResult> {
    const tokens = await this.d.sessions.start({ id: user.id, role: user.role ?? 'user', username: user.username }, ctx);
    return { status: 'authenticated', user: toSelfUser(user), tokens, isNewUser };
  }

  async register(input: RegisterInput, ctx: ClientContext & { countryCode?: string | undefined }): Promise<AuthResult> {
    const hash = await hashPassword(input.password, this.d.env.BCRYPT_COST);
    const geo = countryFromCode(ctx.countryCode);
    let user: UserRecord;
    try {
      user = await this.d.users.create({
        username: input.username,
        name: input.name ?? input.username,
        email: input.email,
        passwordHash: hash,
        role: 'user',
        avatar: defaultAvatar(input.gender),
        gender: input.gender ?? '',
        age: input.age,
        gems: await this.d.flags.signupBonusGems(),
        ...geo,
      });
    } catch (err) {
      const dup = duplicateField(err);
      if (dup === 'email') throw new ConflictError('This e-mail address is already registered', 'email_taken');
      if (dup === 'username') throw new ConflictError('This username is already taken', 'username_taken');
      throw err;
    }
    this.d.events.emit('user.registered', { userId: user.id, email: user.email ?? undefined, name: user.name ?? user.username, isGuest: false });
    return this.success(user, ctx, true);
  }

  async login(input: LoginInput, ctx: ClientContext): Promise<AuthResult | PasskeyRequired> {
    const { env } = this.d;
    const user = await this.d.users.findForLogin(input.identifier);

    if (user?.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      throw new TooManyRequestsError((user.lockedUntil.getTime() - Date.now()) / 1000, 'Account temporarily locked after too many failed attempts');
    }

    const check = await verifyPassword(input.password, user?.passwordHash, env.BCRYPT_COST);
    if (!user || !check.valid) {
      if (user) await this.d.users.recordFailedLogin(user.id, env.LOGIN_MAX_ATTEMPTS, env.LOGIN_LOCK_MINUTES);
      // Same answer for unknown account and wrong password (no user enumeration).
      throw new UnauthorizedError('Invalid username or password', 'invalid_credentials');
    }
    if (user.isBanned) throw new ForbiddenError('This account has been suspended', 'account_banned');

    if (this.d.passkeys && (await this.d.passkeys.isRequired(user))) {
      return { status: 'passkey_required', challengeToken: await this.d.passkeys.createLoginChallengeToken(user.id) };
    }

    const rehash = check.needsRehash ? await hashPassword(input.password, env.BCRYPT_COST) : undefined;
    await this.d.users.recordSuccessfulLogin(user.id, rehash);
    return this.success(user, ctx, false);
  }

  /** Called by the WebAuthn service once the assertion has been verified. */
  async loginVerifiedUser(userId: string, ctx: ClientContext): Promise<AuthResult> {
    const user = await this.d.users.findById(userId);
    if (!user) throw new UnauthorizedError('Account no longer exists', 'account_not_found');
    if (user.isBanned) throw new ForbiddenError('This account has been suspended', 'account_banned');
    await this.d.users.recordSuccessfulLogin(user.id);
    return this.success(user, ctx, false);
  }

  async guest(ctx: ClientContext & { countryCode?: string | undefined }): Promise<AuthResult> {
    if (!(await this.d.flags.guestLoginEnabled())) {
      throw new ForbiddenError('Guest login is disabled', 'guest_login_disabled');
    }
    const geo = countryFromCode(ctx.countryCode);
    for (let attempt = 0; attempt < 5; attempt++) {
      const suffix = uuidv7().replace(/-/g, '').slice(-7);
      try {
        const user = await this.d.users.create({
          username: `guest_${suffix}`,
          name: `Guest ${suffix.slice(0, 5)}`,
          role: 'guest',
          avatar: defaultAvatar(undefined),
          gender: 'other',
          gems: 0,
          ...geo,
        });
        this.d.events.emit('user.registered', { userId: user.id, name: user.name ?? '', isGuest: true });
        return this.success(user, ctx, true);
      } catch (err) {
        if (!duplicateField(err)) throw err;
      }
    }
    throw new AppError(503, 'guest_unavailable', 'Service unavailable', { detail: 'Could not allocate a guest account' });
  }

  /** Exchanges a provider ID token (verified server-side) for our own session. */
  async social(input: SocialInput, ctx: ClientContext & { countryCode?: string | undefined }): Promise<AuthResult> {
    const identity = await this.d.verifier.verify(input.idToken);
    if (!(await this.d.flags.providerEnabled(identity.provider))) {
      throw new ForbiddenError(`Sign-in with ${identity.provider} is disabled`, 'provider_disabled');
    }

    let user = await this.d.users.findByProvider(identity.provider, identity.uid);
    let isNew = false;

    if (!user && identity.email && identity.emailVerified) {
      // Link to an existing account only when the provider vouches for the e-mail address.
      user = await this.d.users.findByEmail(identity.email);
      if (user) await this.d.users.addProvider(user.id, identity.provider, identity.uid);
    }

    if (!user) {
      isNew = true;
      const geo = countryFromCode(ctx.countryCode);
      const base = (identity.name ?? identity.email?.split('@')[0] ?? 'user').toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 12) || 'user';
      for (let attempt = 0; attempt < 5 && !user; attempt++) {
        const username = `${base}_${uuidv7().replace(/-/g, '').slice(-6)}`;
        try {
          user = await this.d.users.create({
            username,
            name: identity.name ?? username,
            email: identity.emailVerified ? identity.email : undefined,
            role: 'user',
            avatar: identity.picture?.startsWith('https://') ? identity.picture : defaultAvatar(input.gender),
            gender: input.gender ?? '',
            gems: await this.d.flags.signupBonusGems(),
            authProviders: [{ provider: identity.provider, providerUid: identity.uid }],
            ...geo,
          });
        } catch (err) {
          const dup = duplicateField(err);
          if (dup === 'email') {
            // Race: someone registered this e-mail meanwhile → link instead of failing.
            user = await this.d.users.findByEmail(identity.email!);
            isNew = false;
            if (user) await this.d.users.addProvider(user.id, identity.provider, identity.uid);
            break;
          }
          if (!dup) throw err;
        }
      }
      if (!user) throw new AppError(503, 'signup_unavailable', 'Service unavailable', { detail: 'Could not create the account' });
      if (isNew) this.d.events.emit('user.registered', { userId: user.id, email: user.email ?? undefined, name: user.name ?? '', isGuest: false });
    }

    if (user.isBanned) throw new ForbiddenError('This account has been suspended', 'account_banned');
    await this.d.users.recordSuccessfulLogin(user.id);
    return this.success(user, ctx, isNew);
  }

  async refresh(refreshToken: string, ctx: ClientContext) {
    const { tokens, userId } = await this.d.sessions.rotate(refreshToken, ctx);
    const user = await this.d.users.findById(userId);
    if (!user) throw new UnauthorizedError('Account no longer exists', 'account_not_found');
    return { tokens, user: toSelfUser(user) };
  }

  async logout(opts: { sid?: string | undefined; refreshToken?: string | undefined }): Promise<void> {
    if (opts.sid) await this.d.sessions.revokeFamily(opts.sid);
    if (opts.refreshToken) await this.d.sessions.revokeByRefreshToken(opts.refreshToken);
  }

  async me(userId: string) {
    const user = await this.d.users.findById(userId);
    if (!user) throw new NotFoundError('Account');
    return toSelfUser(user);
  }

  async changePassword(userId: string, currentSid: string, oldPassword: string, newPassword: string): Promise<void> {
    const user = await this.d.users.findWithHashById(userId);
    if (!user) throw new NotFoundError('Account');
    const check = await verifyPassword(oldPassword, user.passwordHash, this.d.env.BCRYPT_COST);
    if (!check.valid) throw new UnauthorizedError('Current password is incorrect', 'invalid_credentials');
    await this.d.users.setPasswordHash(userId, await hashPassword(newPassword, this.d.env.BCRYPT_COST));
    await this.d.sessions.revokeAllForUser(userId, currentSid);
  }
}

