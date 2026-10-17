import { ZodError } from 'zod';
import {
  AppError,
  BadRequestError,
  ConflictError,
  PayloadTooLargeError,
  UnauthorizedError,
  UnprocessableError,
  type FieldIssue,
} from './app-error.js';

/** RFC 9457 problem details document (`application/problem+json`). */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  instance?: string;
  requestId?: string;
  errors?: FieldIssue[];
  [extension: string]: unknown;
}

export const PROBLEM_CONTENT_TYPE = 'application/problem+json; charset=utf-8';
const TYPE_BASE = 'https://docs.vibematch.app/problems/';

interface ErrorLike {
  name?: string;
  code?: unknown;
  status?: unknown;
  statusCode?: unknown;
  type?: unknown;
  message?: string;
  keyPattern?: Record<string, unknown>;
  errors?: Record<string, { message?: string; path?: string; kind?: string }>;
  path?: string;
}

const zodIssues = (err: ZodError): FieldIssue[] =>
  err.issues.map((i) => ({ path: i.path.join('.'), message: i.message, code: i.code }));

/**
 * Normalises anything thrown into an AppError. Known library errors get precise statuses;
 * everything else becomes an opaque 500 so internals never leak.
 */
export function normalizeError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof ZodError) return new UnprocessableError('Request validation failed', zodIssues(err));

  const e = (err ?? {}) as ErrorLike;
  const name = e.name ?? '';

  // body-parser / http-errors
  if (e.type === 'entity.too.large') return new PayloadTooLargeError();
  if (e.type === 'entity.parse.failed' || (err instanceof SyntaxError && 'body' in (err as object))) {
    return new BadRequestError('Malformed JSON body');
  }
  if (e.type === 'encoding.unsupported' || e.type === 'charset.unsupported') {
    return new BadRequestError('Unsupported content encoding');
  }

  // multer
  if (name === 'MulterError') {
    if (e.code === 'LIMIT_FILE_SIZE') return new PayloadTooLargeError('Uploaded file is too large');
    return new BadRequestError(e.message ?? 'Invalid upload');
  }

  // jsonwebtoken
  if (name === 'TokenExpiredError') return new UnauthorizedError('Token expired', 'token_expired');
  if (name === 'JsonWebTokenError' || name === 'NotBeforeError') {
    return new UnauthorizedError('Token invalid', 'token_invalid');
  }

  // mongoose / mongodb
  if (name === 'MongoServerError' && e.code === 11000) {
    const fields = Object.keys(e.keyPattern ?? {});
    return new ConflictError(
      fields.length ? `Duplicate value for: ${fields.join(', ')}` : 'Duplicate value',
      'duplicate',
      fields.length ? { extensions: { fields } } : {},
    );
  }
  if (name === 'ValidationError' && e.errors) {
    return new UnprocessableError(
      'Request validation failed',
      Object.values(e.errors).map((v) => ({ path: v.path ?? '', message: v.message ?? 'invalid', code: v.kind ?? 'invalid' })),
    );
  }
  if (name === 'CastError') return new BadRequestError(`Invalid value for ${e.path ?? 'parameter'}`);

  // Express / http-errors carrying an explicit 4xx status
  const status = typeof e.status === 'number' ? e.status : typeof e.statusCode === 'number' ? e.statusCode : 0;
  if (status >= 400 && status < 500) {
    return new AppError(status, 'http_error', e.message || 'Request error', { detail: e.message ?? '' });
  }

  return new AppError(500, 'internal_error', 'Internal server error', { cause: err });
}

export interface ProblemContext {
  requestId?: string | undefined;
  instance?: string | undefined;
  /** Include the original message of unexpected errors (never in production). */
  exposeInternals?: boolean;
}

export function toProblem(err: unknown, ctx: ProblemContext = {}): ProblemDetails {
  const app = normalizeError(err);
  const isServerError = app.status >= 500;
  const problem: ProblemDetails = {
    type: `${TYPE_BASE}${app.code}`,
    title: app.title,
    status: app.status,
    code: app.code,
  };
  if (app.detail && (!isServerError || app.code !== 'internal_error')) problem.detail = app.detail;
  if (isServerError && app.code === 'internal_error' && ctx.exposeInternals) {
    problem.detail = (app.cause as Error | undefined)?.message ?? app.detail ?? app.title;
  }
  if (ctx.instance) problem.instance = ctx.instance;
  if (ctx.requestId) problem.requestId = ctx.requestId;
  if (app.errors?.length) problem.errors = app.errors;
  for (const [k, v] of Object.entries(app.extensions)) problem[k] = v;
  return problem;
}
