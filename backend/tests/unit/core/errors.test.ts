import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AppError,
  ForbiddenError,
  NotFoundError,
  TooManyRequestsError,
  UnauthorizedError,
  isAppError,
  normalizeError,
  toProblem,
} from '../../../src/core/errors/index.js';

describe('AppError hierarchy', () => {
  it('carries status, code and immutable headers', () => {
    const e = new UnauthorizedError();
    expect(e).toBeInstanceOf(AppError);
    expect(e.status).toBe(401);
    expect(e.headers['WWW-Authenticate']).toBe('Bearer');
    expect(Object.isFrozen(e.headers)).toBe(true);
    expect(isAppError(e)).toBe(true);
    expect(new ForbiddenError().status).toBe(403);
    expect(new NotFoundError('User').detail).toBe('User was not found');
  });

  it('rate limit errors expose Retry-After', () => {
    const e = new TooManyRequestsError(2.2);
    expect(e.headers['Retry-After']).toBe('3');
    expect(toProblem(e).retryAfter).toBe(3);
  });
});

describe('normalizeError', () => {
  it('maps zod errors to 422 with field issues', () => {
    const r = z.object({ age: z.number() }).safeParse({ age: 'x' });
    const e = normalizeError(r.error);
    expect(e.status).toBe(422);
    expect(e.errors?.[0]?.path).toBe('age');
  });

  it('maps library errors precisely', () => {
    expect(normalizeError({ type: 'entity.too.large' }).status).toBe(413);
    expect(normalizeError({ type: 'entity.parse.failed' }).status).toBe(400);
    expect(normalizeError({ name: 'TokenExpiredError' }).code).toBe('token_expired');
    expect(normalizeError({ name: 'JsonWebTokenError' }).code).toBe('token_invalid');
    expect(normalizeError({ name: 'CastError', path: 'id' }).status).toBe(400);
    expect(normalizeError({ name: 'MulterError', code: 'LIMIT_FILE_SIZE' }).status).toBe(413);
    expect(normalizeError({ name: 'MulterError', code: 'X' }).status).toBe(400);
    const dup = normalizeError({ name: 'MongoServerError', code: 11000, keyPattern: { email: 1 } });
    expect(dup.status).toBe(409);
    expect(dup.extensions.fields).toEqual(['email']);
    const val = normalizeError({ name: 'ValidationError', errors: { a: { message: 'bad', path: 'a', kind: 'required' } } });
    expect(val.status).toBe(422);
    expect(normalizeError({ status: 404, message: 'nope' }).status).toBe(404);
  });

  it('turns unknown failures into opaque 500s', () => {
    const e = normalizeError(new Error('db password is hunter2'));
    expect(e.status).toBe(500);
    const p = toProblem(new Error('db password is hunter2'));
    expect(JSON.stringify(p)).not.toContain('hunter2');
    expect(p.code).toBe('internal_error');
  });
});

describe('toProblem', () => {
  it('follows RFC 9457 and includes request correlation', () => {
    const p = toProblem(new NotFoundError('Gift'), { requestId: 'r1', instance: '/api/v1/gifts/x' });
    expect(p).toMatchObject({
      type: 'https://docs.vibematch.app/problems/not_found',
      title: 'Not found',
      status: 404,
      code: 'not_found',
      instance: '/api/v1/gifts/x',
      requestId: 'r1',
    });
  });

  it('exposes internal messages only when explicitly allowed', () => {
    const err = new Error('boom');
    expect(toProblem(err).detail).toBeUndefined();
    expect(toProblem(err, { exposeInternals: true }).detail).toBe('boom');
  });
});
