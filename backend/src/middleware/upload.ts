import multer from 'multer';
import type { RequestHandler } from 'express';

export interface SniffedImage {
  mime: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  ext: 'png' | 'jpg' | 'webp' | 'gif';
}

/**
 * Identify an image by its magic bytes. The client-supplied MIME type and filename are never
 * trusted: a `.png` that is really HTML/SVG/script is rejected (stored-XSS / polyglot defence).
 * SVG is deliberately NOT accepted for user uploads.
 */
export function sniffImage(buf: Buffer): SniffedImage | null {
  if (buf.length < 12) return null;
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  const head = buf.subarray(0, 6).toString('ascii');
  if (head === 'GIF87a' || head === 'GIF89a') return { mime: 'image/gif', ext: 'gif' };
  return null;
}

const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/**
 * SVG is active content, so it is only accepted on admin-only upload routes and only when it carries
 * no scripts, event handlers, external references or entity tricks.
 */
export function sniffSvg(buf: Buffer): boolean {
  if (buf.length > 200_000) return false;
  const text = buf.toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (!(text.startsWith('<svg') || (text.startsWith('<?xml') && text.includes('<svg')))) return false;
  return !/<script|<foreignObject|<iframe|<!ENTITY|<!DOCTYPE|javascript:|\son[a-z]+\s*=|xlink:href\s*=\s*["']\s*(?!#)/i.test(text);
}

/** In-memory single-file upload (small images only), limited by size and declared type. */
export function imageUpload(field: string, maxBytes: number, extraMime: string[] = []): RequestHandler {
  const allowed = new Set([...ALLOWED_MIME, ...extraMime]);
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 1, fields: 10, fieldSize: 10_000, parts: 12 },
    fileFilter: (_req, file, cb) => cb(null, allowed.has(file.mimetype)),
  }).single(field);
}
