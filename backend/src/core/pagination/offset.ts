import { z } from 'zod';

export const MAX_ADMIN_PAGE_SIZE = 100;

/** Offset pagination is reserved for admin tables, where jumping to page N is a feature. */
export const offsetQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_ADMIN_PAGE_SIZE).default(25),
});
export type OffsetQuery = z.infer<typeof offsetQuerySchema>;

export interface OffsetMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export const toSkipLimit = (q: OffsetQuery): { skip: number; limit: number } => ({
  skip: (q.page - 1) * q.pageSize,
  limit: q.pageSize,
});

export const offsetMeta = (q: OffsetQuery, total: number): OffsetMeta => ({
  page: q.page,
  pageSize: q.pageSize,
  total,
  totalPages: Math.max(1, Math.ceil(total / q.pageSize)),
});
