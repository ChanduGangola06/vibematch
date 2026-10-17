import { randomBytes } from 'node:crypto';
import { sha256Hex } from './crypto.js';

/** Ordered from least to most privileged. */
export const API_KEY_LEVELS = ['public', 'mobile', 'partner', 'admin'] as const;
export type ApiKeyLevel = (typeof API_KEY_LEVELS)[number];

export const levelRank = (l: ApiKeyLevel): number => API_KEY_LEVELS.indexOf(l);
export const levelSatisfies = (have: ApiKeyLevel, need: ApiKeyLevel): boolean => levelRank(have) >= levelRank(need);

export interface GeneratedApiKey {
  /** Shown to the operator exactly once. */
  plain: string;
  /** Stored, non-secret lookup hint. */
  prefix: string;
  /** SHA-256 of `plain` — what we persist and compare. */
  hash: string;
}

/** Format: `vm_<level>_<8-char prefix>_<43-char secret>` */
export function generateApiKey(level: ApiKeyLevel): GeneratedApiKey {
  const prefix = randomBytes(6).toString('base64url').slice(0, 8);
  const secret = randomBytes(32).toString('base64url');
  const plain = `vm_${level}_${prefix}_${secret}`;
  return { plain, prefix, hash: sha256Hex(plain) };
}

const KEY_RE = /^vm_(public|mobile|partner|admin)_([\w-]{8})_([\w-]{43})$/;

/** Cheap structural check before touching the database. */
export function parseApiKey(raw: string): { level: ApiKeyLevel; prefix: string; hash: string } | null {
  const m = KEY_RE.exec(raw);
  if (!m) return null;
  return { level: m[1] as ApiKeyLevel, prefix: m[2]!, hash: sha256Hex(raw) };
}
