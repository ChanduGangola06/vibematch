export interface FieldIssue {
  path: string;
  message: string;
  code?: string;
}

export interface AppErrorOptions {
  detail?: string;
  errors?: FieldIssue[];
  headers?: Record<string, string>;
  cause?: unknown;
  /** Extra machine readable members merged into the problem document. */
  extensions?: Record<string, unknown>;
}

/**
 * Base class of every error the API deliberately raises.
 * Immutable by construction; `code` is a stable, documented identifier clients can switch on.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail?: string;
  readonly errors?: FieldIssue[];
  readonly headers: Readonly<Record<string, string>>;
  readonly extensions: Readonly<Record<string, unknown>>;

  constructor(status: number, code: string, title: string, opts: AppErrorOptions = {}) {
    super(title, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    if (opts.detail !== undefined) this.detail = opts.detail;
    if (opts.errors !== undefined) this.errors = opts.errors;
    this.headers = Object.freeze({ ...opts.headers });
    this.extensions = Object.freeze({ ...opts.extensions });
  }

  get title(): string {
    return this.message;
  }
}

export class BadRequestError extends AppError {
  constructor(detail?: string, opts: AppErrorOptions = {}) {
    super(400, 'bad_request', 'Bad request', { ...opts, ...(detail ? { detail } : {}) });
  }
}

export class UnauthorizedError extends AppError {
  constructor(detail = 'Authentication is required', code = 'unauthorized', opts: AppErrorOptions = {}) {
    super(401, code, 'Unauthorized', {
      ...opts,
      detail,
      headers: { 'WWW-Authenticate': 'Bearer', ...opts.headers },
    });
  }
}

export class ForbiddenError extends AppError {
  constructor(detail = 'You do not have access to this resource', code = 'forbidden', opts: AppErrorOptions = {}) {
    super(403, code, 'Forbidden', { ...opts, detail });
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource', opts: AppErrorOptions = {}) {
    super(404, 'not_found', 'Not found', { ...opts, detail: `${resource} was not found` });
  }
}

export class NotAcceptableError extends AppError {
  constructor(detail: string, opts: AppErrorOptions = {}) {
    super(406, 'version_not_supported', 'Not acceptable', { ...opts, detail });
  }
}

export class ConflictError extends AppError {
  constructor(detail: string, code = 'conflict', opts: AppErrorOptions = {}) {
    super(409, code, 'Conflict', { ...opts, detail });
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(detail = 'Request payload is too large', opts: AppErrorOptions = {}) {
    super(413, 'payload_too_large', 'Payload too large', { ...opts, detail });
  }
}

export class UnprocessableError extends AppError {
  constructor(detail = 'Request validation failed', errors?: FieldIssue[], code = 'validation_failed') {
    super(422, code, 'Unprocessable entity', { detail, ...(errors ? { errors } : {}) });
  }
}

export class TooManyRequestsError extends AppError {
  constructor(retryAfterSeconds: number, detail = 'Too many requests, slow down') {
    super(429, 'rate_limited', 'Too many requests', {
      detail,
      headers: { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterSeconds))) },
      extensions: { retryAfter: Math.max(1, Math.ceil(retryAfterSeconds)) },
    });
  }
}

export class PaymentRequiredError extends AppError {
  constructor(detail = 'Not enough gems', code = 'insufficient_gems') {
    super(402, code, 'Payment required', { detail });
  }
}

export class BadGatewayError extends AppError {
  constructor(detail = 'Upstream service failed', cause?: unknown) {
    super(502, 'upstream_error', 'Bad gateway', { detail, cause });
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(detail = 'Service temporarily unavailable', retryAfterSeconds?: number) {
    super(503, 'service_unavailable', 'Service unavailable', {
      detail,
      ...(retryAfterSeconds ? { headers: { 'Retry-After': String(retryAfterSeconds) } } : {}),
    });
  }
}

export const isAppError = (e: unknown): e is AppError => e instanceof AppError;
