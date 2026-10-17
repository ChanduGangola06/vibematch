import type { RequestHandler } from 'express';
import { uuidv7 } from '../core/utils/id.js';

const SAFE_ID = /^[\w.-]{8,64}$/;

/** Correlation id: accepts a sane inbound `X-Request-Id` (from the gateway) or mints one. */
export function requestId(): RequestHandler {
  return (req, res, next) => {
    const inbound = req.header('x-request-id');
    req.id = inbound && SAFE_ID.test(inbound) ? inbound : uuidv7();
    req.startedAt = performance.now();
    res.setHeader('X-Request-Id', req.id);
    next();
  };
}
