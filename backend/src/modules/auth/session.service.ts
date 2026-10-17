import type { Env } from '../../config/env.js';
import type { Cache } from '../../core/cache/index.js';
import type { AppEventBus } from '../../core/events/index.js';
import { UnauthorizedError } from '../../core/errors/index.js';
import { generateRefreshToken, hashToken, newFamilyId, type Role, type TokenService } from '../../core/security/index.js';
import { RefreshTokenModel } from '../../infra/db/models/auth.js';
import type { SessionRevocationPort } from '../../middleware/authenticate.js';
import type { UserRepository } from '../users/user.repository.js';

export interface ClientContext {
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export interface TokenPair {
  accessToken: string;
  tokenType: 'Bearer';
  /** Access-token lifetime in seconds. */
  expiresIn: number;
  refreshToken: string;
}

interface SessionUser {
  id: string;
  role: Role;
  username: string;
}

/**
 * OAuth 2.0 refresh-token handling (RFC 6749 §6 + RFC 9700 best practice):
 *  - refresh tokens are opaque, 384-bit, stored only as SHA-256
 *  - single use: every refresh rotates the token inside the same *family* (= session)
 *  - presenting an already-used token means theft or a bug → the whole family is revoked
 */
export class SessionService implements SessionRevocationPort {
  constructor(
    private readonly env: Env,
    private readonly tokens: TokenService,
    private readonly users: UserRepository,
    private readonly cache: Cache,
    private readonly events?: AppEventBus,
  ) {}

  /** New login → new family. */
  async start(user: SessionUser, ctx: ClientContext = {}): Promise<TokenPair> {
    return this.issue(user, newFamilyId(), ctx);
  }

  private async issue(user: SessionUser, familyId: string, ctx: ClientContext): Promise<TokenPair> {
    const refresh = generateRefreshToken();
    await RefreshTokenModel.create({
      familyId,
      tokenHash: refresh.hash,
      userId: user.id,
      expiresAt: new Date(Date.now() + this.env.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
      ...(ctx.ip ? { ip: ctx.ip } : {}),
      ...(ctx.userAgent ? { userAgent: ctx.userAgent.slice(0, 300) } : {}),
    });
    const access = this.tokens.signAccess({ sub: user.id, role: user.role, sid: familyId, username: user.username });
    return { accessToken: access.token, tokenType: 'Bearer', expiresIn: access.expiresIn, refreshToken: refresh.token };
  }

  async rotate(presented: string, ctx: ClientContext = {}): Promise<{ tokens: TokenPair; userId: string }> {
    const hash = hashToken(presented);
    const record = await RefreshTokenModel.findOne({ tokenHash: hash }).lean();
    if (!record) throw new UnauthorizedError('Refresh token invalid', 'invalid_refresh_token');

    if (record.revokedAt || record.usedAt) {
      await this.revokeFamily(record.familyId);
      throw new UnauthorizedError('Refresh token was already used; the session has been closed', 'refresh_token_reuse');
    }
    if (record.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedError('Refresh token expired', 'refresh_token_expired');
    }

    // Claim the token atomically; if a concurrent request won the race this one is a replay.
    const claimed = await RefreshTokenModel.findOneAndUpdate(
      { _id: record._id, usedAt: { $exists: false }, revokedAt: { $exists: false } },
      { $set: { usedAt: new Date() } },
    ).lean();
    if (!claimed) {
      await this.revokeFamily(record.familyId);
      throw new UnauthorizedError('Refresh token was already used; the session has been closed', 'refresh_token_reuse');
    }

    const user = await this.users.findById(record.userId);
    if (!user) {
      await this.revokeFamily(record.familyId);
      throw new UnauthorizedError('Account no longer exists', 'account_not_found');
    }
    if (user.isBanned) {
      await this.revokeFamily(record.familyId);
      throw new UnauthorizedError('This account has been suspended', 'account_banned');
    }
    const tokens = await this.issue({ id: user.id, role: user.role ?? 'user', username: user.username }, record.familyId, ctx);
    await RefreshTokenModel.updateOne({ _id: record._id }, { $set: { replacedBy: hashToken(tokens.refreshToken) } });
    return { tokens, userId: user.id };
  }

  async revokeFamily(familyId: string): Promise<void> {
    await RefreshTokenModel.updateMany({ familyId, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date() } });
    // Access tokens of this session die immediately instead of lingering until `exp`.
    await this.cache.set(`revoked_sid:${familyId}`, 1, { ttl: this.env.ACCESS_TOKEN_TTL_SECONDS + 5 });
    this.events?.emit('session.revoked', { sessionId: familyId });
  }

  /** Logout when only the refresh token is at hand (e.g. access token already expired). */
  async revokeByRefreshToken(presented: string): Promise<void> {
    const rec = await RefreshTokenModel.findOne({ tokenHash: hashToken(presented) }, { familyId: 1 }).lean();
    if (rec) await this.revokeFamily(rec.familyId);
  }

  /** Password change / account deletion / ban → sign the user out everywhere (optionally keeping one session). */
  async revokeAllForUser(userId: string, exceptFamilyId?: string): Promise<void> {
    const families = await RefreshTokenModel.distinct('familyId', {
      userId,
      revokedAt: { $exists: false },
      ...(exceptFamilyId ? { familyId: { $ne: exceptFamilyId } } : {}),
    });
    for (const f of families) await this.revokeFamily(f);
  }

  async isRevoked(sessionId: string): Promise<boolean> {
    return (await this.cache.get(`revoked_sid:${sessionId}`)) !== undefined;
  }

  async activeSessions(userId: string): Promise<number> {
    return (await RefreshTokenModel.distinct('familyId', { userId, revokedAt: { $exists: false }, expiresAt: { $gt: new Date() } })).length;
  }
}
