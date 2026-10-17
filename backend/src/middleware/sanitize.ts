import type { RequestHandler } from 'express';
import { BadRequestError } from '../core/errors/index.js';

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_DEPTH = 12;

/**
 * Rejects (does not silently strip) payloads that smuggle Mongo operators (`{"$ne": null}`) or try
 * prototype pollution. Returns the offending path, or null when clean.
 */
export function findDangerousKey(value: unknown, path = '', depth = 0): string | null {
  if (depth > MAX_DEPTH) return `${path} (too deeply nested)`;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findDangerousKey(value[i], `${path}[${i}]`, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      if (key.startsWith('$') || FORBIDDEN.has(key)) return path ? `${path}.${key}` : key;
      const hit = findDangerousKey((value as Record<string, unknown>)[key], path ? `${path}.${key}` : key, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/** Apply after body parsing. Query strings use the "simple" parser (flat), so only the body can nest. */
export const sanitizeBody: RequestHandler = (req, _res, next) => {
  const hit = findDangerousKey(req.body);
  if (hit) return next(new BadRequestError(`Forbidden key in request body: ${hit}`));
  next();
};
