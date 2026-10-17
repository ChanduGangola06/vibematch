import { Types } from 'mongoose';
import { z } from 'zod';
import type { CursorCodec } from './cursor.js';

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/** Reusable query-string schema for cursor-paginated lists. */
export const cursorQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: z.string().min(1).max(512).optional(),
});
export type CursorQuery = z.infer<typeof cursorQuerySchema>;

export interface PageMeta {
  limit: number;
  hasMore: boolean;
  nextCursor: string | null;
}

export interface Page<T> {
  items: T[];
  page: PageMeta;
}

export interface KeysetOptions {
  filter?: Record<string, unknown>;
  limit?: number;
  cursor?: string | undefined;
  /** Field used for ordering; must be indexed together with `_id`. */
  sortField?: string;
  direction?: 1 | -1;
  projection?: Record<string, 0 | 1>;
}

/** Structural slice of a Mongoose model — keeps this helper decoupled from model generics. */
export interface KeysetQuery extends PromiseLike<unknown> {
  sort(spec: Record<string, 1 | -1>): KeysetQuery;
  limit(n: number): KeysetQuery;
  lean(): KeysetQuery;
}
export interface KeysetSource {
  find(filter: Record<string, unknown>, projection?: Record<string, 0 | 1>): KeysetQuery;
}

const isDateField = (v: unknown): v is Date => v instanceof Date;

/**
 * Keyset (seek) pagination — O(log n) per page regardless of depth, stable under inserts.
 * Fetches `limit + 1` rows to compute `hasMore` without a count query.
 */
export async function keysetPage<T extends { _id: Types.ObjectId }>(
  model: KeysetSource,
  codec: CursorCodec,
  opts: KeysetOptions = {},
): Promise<Page<T>> {
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const sortField = opts.sortField ?? 'createdAt';
  const dir = opts.direction ?? -1;
  const cmp = dir === -1 ? '$lt' : '$gt';

  const and: Record<string, unknown>[] = [];
  if (opts.filter && Object.keys(opts.filter).length) and.push(opts.filter);

  if (opts.cursor) {
    const c = codec.decode(opts.cursor);
    if (!Types.ObjectId.isValid(c.i)) {
      // codec already authenticates the cursor, this guards against future format drift
      throw new Error('cursor id is not an ObjectId');
    }
    const id = new Types.ObjectId(c.i);
    const value = typeof c.s === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(c.s) ? new Date(c.s) : c.s;
    and.push({
      $or: [{ [sortField]: { [cmp]: value } }, { [sortField]: value, _id: { [cmp]: id } }],
    });
  }

  const query = model
    .find(and.length ? { $and: and } : {}, opts.projection)
    .sort({ [sortField]: dir, _id: dir })
    .limit(limit + 1)
    .lean();
  const rows = (await query) as unknown as (T & Record<string, unknown>)[];

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  let nextCursor: string | null = null;
  if (hasMore && last) {
    const raw = last[sortField];
    const s = isDateField(raw) ? raw.toISOString() : (raw as string | number);
    nextCursor = codec.encode({ s, i: last._id.toHexString() });
  }
  return { items, page: { limit, hasMore, nextCursor } };
}
