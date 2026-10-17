import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import { UnauthorizedError } from '../errors/index.js';
import { sha256Hex } from './crypto.js';
import { uuidv7 } from '../utils/id.js';

export type Role = 'guest' | 'user' | 'admin';

export interface AccessClaims {
  sub: string;
  role: Role;
  /** Refresh-token family (session) id, lets us revoke a session's access tokens indirectly. */
  sid: string;
  username?: string;
  jti: string;
  iat: number;
  exp: number;
}

export interface TokenServiceConfig {
  secret: string;
  issuer: string;
  audience: string;
  accessTtlSeconds: number;
}

/** Issues and verifies short-lived access JWTs and generates opaque refresh tokens. */
export class TokenService {
  constructor(private readonly cfg: TokenServiceConfig) {}

  signAccess(input: { sub: string; role: Role; sid: string; username?: string }): { token: string; expiresIn: number } {
    const token = jwt.sign(
      { role: input.role, sid: input.sid, ...(input.username ? { username: input.username } : {}) },
      this.cfg.secret,
      {
        algorithm: 'HS256',
        subject: input.sub,
        issuer: this.cfg.issuer,
        audience: this.cfg.audience,
        expiresIn: this.cfg.accessTtlSeconds,
        jwtid: uuidv7(),
      },
    );
    return { token, expiresIn: this.cfg.accessTtlSeconds };
  }

  verifyAccess(token: string): AccessClaims {
    try {
      const payload = jwt.verify(token, this.cfg.secret, {
        algorithms: ['HS256'],
        issuer: this.cfg.issuer,
        audience: this.cfg.audience,
      }) as jwt.JwtPayload;
      if (!payload.sub || !payload.role || !payload.sid) throw new jwt.JsonWebTokenError('missing claims');
      return payload as unknown as AccessClaims;
    } catch (err) {
      if (err instanceof jwt.TokenExpiredError) throw new UnauthorizedError('Access token expired', 'token_expired');
      throw new UnauthorizedError('Access token invalid', 'token_invalid');
    }
  }
}

export interface RefreshTokenMaterial {
  token: string;
  hash: string;
}

/** 384 bits of entropy; only the SHA-256 is persisted. */
export function generateRefreshToken(): RefreshTokenMaterial {
  const token = randomBytes(48).toString('base64url');
  return { token, hash: sha256Hex(token) };
}

export const hashToken = sha256Hex;
export const newFamilyId = (): string => uuidv7();
