import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { Env } from '../config/env.js';
import { NotFoundError, PROBLEM_CONTENT_TYPE, normalizeError, toProblem } from '../core/errors/index.js';

export const notFound: RequestHandler = (req, _res, next) => {
  next(new NotFoundError(`Route ${req.method} ${req.path}`));
};

/** Single exit point for failures: RFC 9457 problem+json, no stack traces, correlation id included. */
export function errorHandler(env: Env): ErrorRequestHandler {
  return (err, req, res, _next) => {
    const app = normalizeError(err);
    const log = req.log;
    if (app.status >= 500) log?.error({ err: app.cause ?? app }, 'unhandled error');

    if (res.headersSent) {
      // Streaming already started: we can only abort the connection.
      res.destroy();
      return;
    }
    for (const [k, v] of Object.entries(app.headers)) res.setHeader(k, v);
    res.setHeader('Cache-Control', 'no-store');
    const problem = toProblem(app, {
      requestId: req.id,
      instance: req.originalUrl.split('?')[0],
      exposeInternals: !env.isProd && !env.isTest,
    });
    res.status(app.status).type(PROBLEM_CONTENT_TYPE).send(JSON.stringify(problem));
  };
}
