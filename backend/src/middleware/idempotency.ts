import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { BadRequestError, ConflictError, UnprocessableError } from '../core/errors/index.js';

const KEY_RE = /^[\w:.-]{8,128}$/;
const TTL_MS = 24 * 3600 * 1000;

export interface StoredRecord {
  requestHash: string;
  status: 'in_progress' | 'completed';
  responseStatus?: number | undefined;
  responseBody?: unknown;
}

/** Storage port; Mongo implementation lives in infra (unique index on scope+key+route). */
export interface IdempotencyStore {
  /** Atomically claims the key. Returns the existing record when someone already did. */
  claim(rec: { scope: string; key: string; route: string; requestHash: string; expiresAt: Date }): Promise<StoredRecord | null>;
  complete(scope: string, key: string, route: string, responseStatus: number, responseBody: unknown): Promise<void>;
  release(scope: string, key: string, route: string): Promise<void>;
}

export type IdempotencyOutcome =
  | { kind: 'proceed'; complete(status: number, body: unknown): Promise<void>; release(): Promise<void> }
  | { kind: 'replay'; status: number; body: unknown };

export type IdempotencyMode = 'required' | 'optional';

export class IdempotencyService {
  constructor(private readonly store: IdempotencyStore) {}

  static fingerprint(req: Request): string {
    return createHash('sha256')
      .update(`${req.method}\n${req.baseUrl}${req.path}\n${JSON.stringify(req.body ?? null)}`)
      .digest('hex');
  }

  /**
   * Same key + same request → stored response is replayed.
   * Same key + different request → 422.   Same key while the first is still running → 409.
   * Only successful outcomes are stored; failures release the key so the client can retry.
   */
  async begin(req: Request, mode: IdempotencyMode, routeId: string): Promise<IdempotencyOutcome> {
    const key = req.header('idempotency-key');
    if (!key) {
      if (mode === 'required') throw new BadRequestError('Idempotency-Key header is required for this endpoint');
      return { kind: 'proceed', complete: async () => {}, release: async () => {} };
    }
    if (!KEY_RE.test(key)) throw new BadRequestError('Idempotency-Key must be 8-128 chars of [A-Za-z0-9_:.-]');

    const scope = req.auth?.userId ?? `ip:${req.ip}`;
    const requestHash = IdempotencyService.fingerprint(req);
    const existing = await this.store.claim({
      scope, key, route: routeId, requestHash, expiresAt: new Date(Date.now() + TTL_MS),
    });

    if (!existing) {
      return {
        kind: 'proceed',
        complete: (status, body) => this.store.complete(scope, key, routeId, status, body),
        release: () => this.store.release(scope, key, routeId),
      };
    }
    if (existing.requestHash !== requestHash) {
      throw new UnprocessableError('Idempotency-Key was already used with a different request', undefined, 'idempotency_key_reuse');
    }
    if (existing.status === 'in_progress') {
      throw new ConflictError('A request with this Idempotency-Key is still being processed', 'request_in_progress', {
        headers: { 'Retry-After': '1' },
      });
    }
    return { kind: 'replay', status: existing.responseStatus ?? 200, body: existing.responseBody };
  }
}
