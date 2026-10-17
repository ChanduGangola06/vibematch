import bcrypt from 'bcryptjs';
import { describe, expect, it } from 'vitest';
import { UnauthorizedError } from '../../../src/core/errors/index.js';
import {
  SecretBox,
  TokenService,
  generateApiKey,
  generateRefreshToken,
  hashPassword,
  hashToken,
  isMasked,
  levelSatisfies,
  maskSecret,
  parseApiKey,
  safeEqual,
  verifyPassword,
} from '../../../src/core/security/index.js';

describe('passwords', () => {
  it('hashes and verifies', async () => {
    const h = await hashPassword('Correct-Horse-9', 4);
    expect(await verifyPassword('Correct-Horse-9', h, 4)).toEqual({ valid: true, needsRehash: false });
    expect((await verifyPassword('wrong', h, 4)).valid).toBe(false);
  });

  it('flags low-cost legacy hashes for re-hash', async () => {
    const legacy = bcrypt.hashSync('pw', 4);
    expect(await verifyPassword('pw', legacy, 6)).toEqual({ valid: true, needsRehash: true });
  });

  it('never validates unknown accounts or malformed hashes', async () => {
    expect((await verifyPassword('x', undefined, 4)).valid).toBe(false);
    expect((await verifyPassword('x', 'plain-text', 4)).valid).toBe(false);
    expect((await verifyPassword('x', null, 4)).needsRehash).toBe(false);
  });
});

describe('SecretBox (AES-256-GCM)', () => {
  const key = Buffer.alloc(32, 9).toString('base64');
  it('round-trips and uses a fresh IV each time', () => {
    const box = new SecretBox(key);
    const a = box.encrypt('sk_live_abc');
    const b = box.encrypt('sk_live_abc');
    expect(a).not.toBe(b);
    expect(SecretBox.isEncrypted(a)).toBe(true);
    expect(box.decrypt(a)).toBe('sk_live_abc');
  });

  it('detects tampering and wrong keys', () => {
    const box = new SecretBox(key);
    const enc = box.encrypt('secret');
    const parts = enc.split(':');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => box.decrypt(parts.join(':'))).toThrow();
    expect(() => new SecretBox(Buffer.alloc(32, 1).toString('base64')).decrypt(enc)).toThrow();
    expect(() => box.decrypt('garbage')).toThrow(/format/);
    expect(() => new SecretBox('AAAA')).toThrow(/32 bytes/);
  });

  it('masks secrets', () => {
    expect(maskSecret('abcdefgh1234')).toBe('••••1234');
    expect(maskSecret(undefined)).toBe('');
    expect(isMasked('••••1234')).toBe(true);
    expect(isMasked('abc')).toBe(false);
    expect(safeEqual('a', 'a')).toBe(true);
    expect(safeEqual('a', 'ab')).toBe(false);
  });
});

describe('TokenService', () => {
  const svc = new TokenService({ secret: 's'.repeat(40), issuer: 'iss', audience: 'aud', accessTtlSeconds: 60 });

  it('signs and verifies access tokens', () => {
    const { token, expiresIn } = svc.signAccess({ sub: 'u1', role: 'user', sid: 'fam1', username: 'bob' });
    expect(expiresIn).toBe(60);
    const claims = svc.verifyAccess(token);
    expect(claims).toMatchObject({ sub: 'u1', role: 'user', sid: 'fam1', username: 'bob' });
    expect(claims.jti).toBeTruthy();
  });

  it('rejects tampered, foreign-secret, wrong-audience and expired tokens', () => {
    const { token } = svc.signAccess({ sub: 'u1', role: 'user', sid: 's' });
    expect(() => svc.verifyAccess(token + 'x')).toThrow(UnauthorizedError);
    const other = new TokenService({ secret: 'z'.repeat(40), issuer: 'iss', audience: 'aud', accessTtlSeconds: 60 });
    expect(() => other.verifyAccess(token)).toThrow(UnauthorizedError);
    const wrongAud = new TokenService({ secret: 's'.repeat(40), issuer: 'iss', audience: 'other', accessTtlSeconds: 60 });
    expect(() => wrongAud.verifyAccess(token)).toThrow(UnauthorizedError);
    const expired = new TokenService({ secret: 's'.repeat(40), issuer: 'iss', audience: 'aud', accessTtlSeconds: -10 });
    try {
      svc.verifyAccess(expired.signAccess({ sub: 'u', role: 'user', sid: 's' }).token);
      expect.unreachable();
    } catch (e) {
      expect((e as UnauthorizedError).code).toBe('token_expired');
    }
  });

  it('rejects alg=none forgeries', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(
      JSON.stringify({ sub: 'admin', role: 'admin', sid: 's', iss: 'iss', aud: 'aud', exp: 9_999_999_999 }),
    ).toString('base64url');
    expect(() => svc.verifyAccess(`${header}.${body}.`)).toThrow(UnauthorizedError);
  });

  it('generates high-entropy refresh tokens stored only as hashes', () => {
    const a = generateRefreshToken();
    const b = generateRefreshToken();
    expect(a.token).not.toBe(b.token);
    expect(a.token.length).toBeGreaterThanOrEqual(64);
    expect(hashToken(a.token)).toBe(a.hash);
    expect(a.hash).not.toContain(a.token);
  });
});

describe('API keys', () => {
  it('generates parseable leveled keys and hashes them', () => {
    const k = generateApiKey('mobile');
    const parsed = parseApiKey(k.plain);
    expect(parsed).toEqual({ level: 'mobile', prefix: k.prefix, hash: k.hash });
    expect(k.plain.startsWith('vm_mobile_')).toBe(true);
  });

  it('rejects malformed keys and orders levels', () => {
    expect(parseApiKey('nope')).toBeNull();
    expect(parseApiKey('vm_root_abcdefgh_' + 'a'.repeat(43))).toBeNull();
    expect(levelSatisfies('admin', 'mobile')).toBe(true);
    expect(levelSatisfies('public', 'mobile')).toBe(false);
    expect(levelSatisfies('mobile', 'mobile')).toBe(true);
  });
});
