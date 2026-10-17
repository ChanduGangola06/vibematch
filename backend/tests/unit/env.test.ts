import { describe, expect, it } from 'vitest';
import { EnvError, parseEnv } from '../../src/config/env.js';

const base = {
  MONGODB_URI: 'mongodb://127.0.0.1:27017/x',
  JWT_SECRET: 'k'.repeat(40),
};

describe('parseEnv', () => {
  it('applies defaults and derived flags', () => {
    const env = parseEnv({ ...base, NODE_ENV: 'test' });
    expect(env.PORT).toBe(3000);
    expect(env.isTest).toBe(true);
    expect(env.isProd).toBe(false);
    expect(env.MONGO_MAX_POOL_SIZE).toBe(20);
    expect(env.DEMO_MODE).toBe(false);
  });

  it('parses csv, booleans and numbers', () => {
    const env = parseEnv({
      ...base,
      CORS_ORIGINS: 'https://a.com, https://b.com',
      DEMO_MODE: 'true',
      PORT: '8080',
    });
    expect(env.corsOrigins).toEqual(['https://a.com', 'https://b.com']);
    expect(env.DEMO_MODE).toBe(true);
    expect(env.PORT).toBe(8080);
  });

  it('fails fast with readable messages', () => {
    expect(() => parseEnv({})).toThrow(EnvError);
    try {
      parseEnv({ MONGODB_URI: 'http://nope', JWT_SECRET: 'short' });
    } catch (e) {
      const msg = (e as EnvError).message;
      expect(msg).toContain('MONGODB_URI');
      expect(msg).toContain('JWT_SECRET');
    }
  });

  it('rejects wildcard CORS and inverted pool sizes', () => {
    expect(() => parseEnv({ ...base, CORS_ORIGINS: '*' })).toThrow(/must not contain/);
    expect(() => parseEnv({ ...base, MONGO_MIN_POOL_SIZE: '50', MONGO_MAX_POOL_SIZE: '5' })).toThrow(/MIN_POOL/);
  });

  it('enforces production guards', () => {
    const prod = {
      ...base,
      NODE_ENV: 'production',
      PUBLIC_URL: 'https://vibematch.example.com',
      CORS_ORIGINS: 'https://vibematch.example.com',
      SETTINGS_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
      WEBAUTHN_RP_ID: 'vibematch.example.com',
    };
    expect(parseEnv(prod).isProd).toBe(true);
    expect(() => parseEnv({ ...prod, PUBLIC_URL: 'http://vibematch.example.com' })).toThrow(/https/);
    expect(() => parseEnv({ ...prod, JWT_SECRET: 'change-me-change-me-change-me-change-me' })).toThrow(/placeholder/);
    expect(() => parseEnv({ ...prod, SETTINGS_ENCRYPTION_KEY: undefined })).toThrow(/SETTINGS_ENCRYPTION_KEY/);
    expect(() => parseEnv({ ...prod, CORS_ORIGINS: '' })).toThrow(/CORS_ORIGINS/);
  });

  it('validates the encryption key length', () => {
    expect(() => parseEnv({ ...base, SETTINGS_ENCRYPTION_KEY: 'AAAA' })).toThrow(/32 bytes/);
  });
});
