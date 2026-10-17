import express from 'express';
import mongoose, { Schema } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CursorCodec,
  cursorQuerySchema,
  keysetPage,
  offsetMeta,
  offsetQuerySchema,
  streamNdjson,
  toSkipLimit,
} from '../../../src/core/pagination/index.js';
import { BadRequestError } from '../../../src/core/errors/index.js';
import { startTestDb, stopTestDb } from '../../helpers/mongo.js';

const codec = new CursorCodec('x'.repeat(40));

describe('CursorCodec', () => {
  it('round-trips', () => {
    const c = codec.encode({ s: '2026-01-01T00:00:00.000Z', i: 'a'.repeat(24) });
    expect(codec.decode(c)).toEqual({ s: '2026-01-01T00:00:00.000Z', i: 'a'.repeat(24) });
  });

  it('rejects tampered, foreign, malformed cursors', () => {
    const c = codec.encode({ s: 1, i: 'a'.repeat(24) });
    const [body, sig] = c.split('.');
    const forged = `${Buffer.from(JSON.stringify({ s: 0, i: 'b'.repeat(24) })).toString('base64url')}.${sig}`;
    expect(() => codec.decode(forged)).toThrow(BadRequestError);
    expect(() => codec.decode(`${body}.AAAA`)).toThrow(BadRequestError);
    expect(() => codec.decode('garbage')).toThrow(BadRequestError);
    expect(() => codec.decode('a.b.c')).toThrow(BadRequestError);
    expect(() => new CursorCodec('y'.repeat(40)).decode(c)).toThrow(BadRequestError);
    // validly signed but wrong shape
    const shape = Buffer.from(JSON.stringify({ s: {}, i: 1 })).toString('base64url');
    const sig2 = codec.encode({ s: 1, i: 'x' }).split('.')[1];
    expect(() => codec.decode(`${shape}.${sig2}`)).toThrow(BadRequestError);
  });
});

describe('query schemas', () => {
  it('applies defaults and caps', () => {
    expect(cursorQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(cursorQuerySchema.parse({ limit: '50' }).limit).toBe(50);
    expect(() => cursorQuerySchema.parse({ limit: '1000' })).toThrow();
    expect(() => cursorQuerySchema.parse({ limit: '0' })).toThrow();
    const q = offsetQuerySchema.parse({ page: '3', pageSize: '10' });
    expect(toSkipLimit(q)).toEqual({ skip: 20, limit: 10 });
    expect(offsetMeta(q, 95)).toEqual({ page: 3, pageSize: 10, total: 95, totalPages: 10 });
    expect(offsetMeta(offsetQuerySchema.parse({}), 0).totalPages).toBe(1);
    expect(() => offsetQuerySchema.parse({ pageSize: '101' })).toThrow();
  });
});

describe('keysetPage (mongo)', () => {
  const Item = mongoose.model(
    'PagItem',
    new Schema({ n: Number, tag: String, createdAt: Date }, { versionKey: false }),
  );

  beforeAll(async () => {
    await startTestDb();
    const base = Date.UTC(2026, 0, 1);
    // 25 docs; every 5 share the same createdAt to exercise the _id tie-break.
    await Item.insertMany(
      Array.from({ length: 25 }, (_, n) => ({ n, tag: n % 2 ? 'odd' : 'even', createdAt: new Date(base + Math.floor(n / 5) * 1000) })),
    );
  });
  afterAll(stopTestDb);

  it('walks every document exactly once, newest first, with ties', async () => {
    const seen: number[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await keysetPage<{ _id: mongoose.Types.ObjectId; n: number }>(Item, codec, { limit: 7, cursor });
      seen.push(...page.items.map((i) => i.n));
      cursor = page.page.nextCursor ?? undefined;
      pages++;
      expect(page.page.limit).toBe(7);
    } while (cursor);
    expect(pages).toBe(4);
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
  });

  it('supports ascending order, filters and projections', async () => {
    const first = await keysetPage<{ _id: mongoose.Types.ObjectId; n: number }>(Item, codec, {
      limit: 5, direction: 1, filter: { tag: 'even' }, projection: { n: 1, createdAt: 1 },
    });
    expect(first.items.every((i) => i.n % 2 === 0)).toBe(true);
    expect(first.page.hasMore).toBe(true);
    const second = await keysetPage<{ _id: mongoose.Types.ObjectId; n: number }>(Item, codec, {
      limit: 100, direction: 1, filter: { tag: 'even' }, cursor: first.page.nextCursor!,
    });
    expect(second.page.hasMore).toBe(false);
    expect(second.page.nextCursor).toBeNull();
    expect(first.items.length + second.items.length).toBe(13);
  });

  it('clamps limit and returns an empty page', async () => {
    const huge = await keysetPage(Item, codec, { limit: 10_000 });
    expect(huge.page.limit).toBe(100);
    const none = await keysetPage(Item, codec, { filter: { tag: 'nope' } });
    expect(none).toEqual({ items: [], page: { limit: 20, hasMore: false, nextCursor: null } });
  });
});

describe('streamNdjson', () => {
  it('streams rows as NDJSON without buffering the whole set', async () => {
    const app = express();
    async function* rows() {
      for (let i = 0; i < 1000; i++) yield { i };
    }
    app.get('/x', (_req, res, next) => {
      streamNdjson(res, rows(), (r) => ({ n: r.i }), 'export file.ndjson').catch(next);
    });
    const res = await request(app).get('/x').buffer(true).parse((r, cb) => {
      let data = '';
      r.on('data', (c) => (data += c));
      r.on('end', () => cb(null, data));
    });
    expect(res.headers['content-type']).toContain('application/x-ndjson');
    expect(res.headers['content-disposition']).toContain('export_file.ndjson');
    const lines = (res.body as string).trim().split('\n');
    expect(lines).toHaveLength(1000);
    expect(JSON.parse(lines[999]!)).toEqual({ n: 999 });
  });
});
