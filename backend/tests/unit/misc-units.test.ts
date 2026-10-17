import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { versionNegotiation } from '../../src/core/http/versioning.js';
import { createAsyncLogger } from '../../src/core/logger/index.js';
import { errorHandler } from '../../src/middleware/error-handler.js';
import { AuditService } from '../../src/modules/admin/audit.service.js';
import { identityFromDecoded } from '../../src/modules/auth/firebase-verifier.js';
import { testEnv } from '../helpers/app.js';

describe('versionNegotiation', () => {
  const app = (policy: Parameters<typeof versionNegotiation>[0], urlVersion: string) => {
    const a = express();
    a.use(versionNegotiation(policy, urlVersion));
    a.get('/x', (_req, res) => res.json({ ok: true }));
    a.use(errorHandler(testEnv()));
    return a;
  };

  it('advertises deprecation, sunset date and a successor link for deprecated versions', async () => {
    const res = await request(app({ supported: ['1', '2'], current: '2', deprecated: { 1: { sunset: new Date('2027-01-01T00:00:00Z'), link: 'https://docs.example/migrate' } } }, '1')).get('/x');
    expect(res.headers.deprecation).toBe('true');
    expect(res.headers.sunset).toBe('Fri, 01 Jan 2027 00:00:00 GMT');
    expect(res.headers.link).toBe('<https://docs.example/migrate>; rel="deprecation"');
    expect(res.headers['api-version']).toBe('1');
  });

  it('distinguishes "unknown version" from "version served elsewhere"', async () => {
    const a = app({ supported: ['1', '2'], current: '2' }, '1');
    const unknown = await request(a).get('/x').set('Accept-Version', '9');
    expect(unknown.status).toBe(406);
    expect(unknown.body.supported).toEqual(['1', '2']);
    const elsewhere = await request(a).get('/x').set('Accept-Version', '2');
    expect(elsewhere.status).toBe(406);
    expect(elsewhere.body.detail).toMatch(/serves version 1/);
    expect((await request(a).get('/x').set('Accept-Version', '1')).headers.deprecation).toBeUndefined();
  });
});

describe('AuditService', () => {
  it('never throws: a failing audit sink is logged, the admin action still succeeds', async () => {
    const error = vi.fn();
    const { AuditLogModel } = await import('../../src/infra/db/models/content.js');
    const spy = vi.spyOn(AuditLogModel, 'create').mockRejectedValueOnce(new Error('disk full') as never);
    await expect(new AuditService({ error } as never).record({ ip: '1.1.1.1' }, { action: 'x' })).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ action: 'x' }), 'audit write failed');
    spy.mockRestore();
  });
});

describe('Firebase identity mapping', () => {
  it('maps providers, refuses anonymous/custom sign-ins', () => {
    expect(identityFromDecoded({ uid: '1', firebase: { sign_in_provider: 'google.com' }, email: 'a@b.c', email_verified: true })).toMatchObject({ provider: 'google', uid: '1', emailVerified: true });
    expect(identityFromDecoded({ uid: '2', firebase: { sign_in_provider: 'phone' }, phone_number: '+1555' })).toMatchObject({ provider: 'phone', phone: '+1555' });
    for (const p of ['anonymous', 'custom', undefined]) {
      expect(() => identityFromDecoded({ uid: '3', firebase: { sign_in_provider: p } })).toThrow(expect.objectContaining({ code: 'provider_unsupported', status: 401 }));
    }
  });
});

describe('async logger lifecycle', () => {
  it('flushSync on close drains buffered lines', () => {
    const lines: string[] = [];
    const sink = { write: (s: string) => void lines.push(s) };
    const { logger, close } = createAsyncLogger({ level: 'info', flushMs: 10_000, destination: sink as never });
    logger.info('bye');
    close();
    expect(lines.join('')).toContain('bye');
  });
});
