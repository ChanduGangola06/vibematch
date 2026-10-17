import { uuidv7 } from '../../../core/utils/id.js';

/** `as const` keeps the literal types so `InferSchemaType` still sees the full schema. */
export const baseOptions = { timestamps: true, versionKey: false } as const;

/** Public string id (UUIDv7) kept alongside Mongo's `_id` for client/legacy compatibility. */
export const idField = (prefix?: string) => ({
  type: String,
  required: true,
  unique: true,
  default: () => (prefix ? `${prefix}_${uuidv7()}` : uuidv7()),
});

export const secondsInDay = 86_400;

/**
 * TTL index lifetimes are read from the environment at import time. Models must stay importable by
 * tooling (OpenAPI generation, index sync) without a full environment, so this reads `process.env`
 * directly; the same variables are validated by `config/env.ts` when the server boots.
 */
export const ttlDays = (name: 'HISTORY_TTL_DAYS' | 'AUDIT_TTL_DAYS', fallback: number): number => {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n >= 1 ? n : fallback;
};
