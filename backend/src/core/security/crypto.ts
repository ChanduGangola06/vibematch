import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const VERSION = 'v1';

/** AES-256-GCM. Format: `v1:<iv>:<tag>:<ciphertext>` (all base64url). */
export class SecretBox {
  private readonly key: Buffer;

  constructor(base64Key: string) {
    this.key = Buffer.from(base64Key, 'base64');
    if (this.key.length !== 32) throw new Error('SecretBox key must be 32 bytes (base64)');
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join(':');
  }

  decrypt(payload: string): string {
    const [v, iv, tag, ct] = payload.split(':');
    if (v !== VERSION || !iv || !tag || !ct) throw new Error('Unsupported ciphertext format');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
  }

  static isEncrypted(value: unknown): value is string {
    return typeof value === 'string' && /^v1:[\w-]+:[\w-]+:[\w-]+$/.test(value);
  }
}

/** Shows only the tail of a secret: `••••a1b2`. */
export function maskSecret(value: string | undefined | null): string {
  if (!value) return '';
  return `••••${value.slice(-4)}`;
}

export const isMasked = (value: unknown): boolean => typeof value === 'string' && value.startsWith('••••');

export const sha256Hex = (input: string): string => createHash('sha256').update(input).digest('hex');

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
