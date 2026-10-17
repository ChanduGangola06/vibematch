import type { RequestHandler } from 'express';
import type { Logger } from '../core/logger/index.js';
import type { Metrics } from '../core/http/metrics.js';

/**
 * One structured line per request, emitted when the response finishes. The write goes to the
 * async logger buffer, so it never blocks the event loop on I/O.
 */
export function accessLog(log: Logger, metrics?: Metrics): RequestHandler {
  return (req, res, next) => {
    req.log = log.child({ requestId: req.id });
    res.on('finish', () => {
      const ms = Math.round((performance.now() - req.startedAt) * 10) / 10;
      const status = res.statusCode;
      const route = req.routePattern ?? 'unmatched';
      metrics?.observe(req.method, route, status, ms / 1000);
      const line = {
        method: req.method,
        path: req.originalUrl.split('?')[0],
        route,
        status,
        ms,
        bytes: Number(res.getHeader('content-length') ?? 0),
        ip: req.ip,
        ua: req.header('user-agent')?.slice(0, 120),
        userId: req.auth?.userId,
      };
      if (status >= 500) req.log.error(line, 'request');
      else if (status >= 400) req.log.warn(line, 'request');
      else req.log.info(line, 'request');
    });
    next();
  };
}
