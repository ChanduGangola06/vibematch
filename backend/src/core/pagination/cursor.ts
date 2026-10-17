import { createHmac, timingSafeEqual } from 'node:crypto';
import { BadRequestError } from '../errors/index.js';

export interface CursorPayload {
  /** Sort-key value (ISO date string, number or string). */
  s: string | number;
  /** Tie-break id (document `_id` hex). */
  i: string;
}

/**
 * Opaque, tamper-evident cursors: base64url(JSON) + "." + HMAC. Clients cannot forge the
 * keyset values that end up in the Mongo filter.
 */
export class CursorCodec {
  private readonly key: Buffer;

  constructor(secret: string) {
    this.key = Buffer.from(createHmac('sha256', 'vibematch-cursor').update(secret).digest());
  }

  encode(payload: CursorPayload): string {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${this.sign(body)}`;
  }

  decode(cursor: string): CursorPayload {
    const [body, sig, extra] = cursor.split('.');
    if (!body || !sig || extra !== undefined) throw new BadRequestError('Invalid cursor');
    const expected = Buffer.from(this.sign(body));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      throw new BadRequestError('Invalid cursor');
    }
    try {
      const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<CursorPayload>;
      if ((typeof parsed.s !== 'string' && typeof parsed.s !== 'number') || typeof parsed.i !== 'string') {
        throw new Error('shape');
      }
      return { s: parsed.s, i: parsed.i };
    } catch {
      throw new BadRequestError('Invalid cursor');
    }
  }

  private sign(body: string): string {
    return createHmac('sha256', this.key).update(body).digest('base64url').slice(0, 32);
  }
}
