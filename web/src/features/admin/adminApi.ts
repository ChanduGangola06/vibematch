import { rawFetch, newIdempotencyKey } from '@/shared/api/client';
import { ApiError, networkError, type Problem } from '@/shared/api/errors';

/**
 * Admin endpoints do not declare response schemas in OpenAPI yet (task W2.5), so rows are typed here by hand
 * and every call goes through this single helper that parses the envelope and raises `ApiError`.
 */
export type Row = Record<string, unknown> & { id: string };
export interface OffsetPage { page: number; pageSize: number; total: number; totalPages: number }
export interface Listing<T> { items: T[]; page: OffsetPage }

type Query = Record<string, string | number | boolean | undefined | null>;
const qs = (q?: Query) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q ?? {})) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

async function send(method: string, path: string, opts: { query?: Query; body?: unknown; form?: FormData } = {}): Promise<{ data: unknown; page?: OffsetPage }> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.body); }
  if (method !== 'GET') headers['Idempotency-Key'] = newIdempotencyKey();
  let res: Response;
  try {
    res = await rawFetch(`${path}${qs(opts.query)}`, { method, headers, ...(body !== undefined ? { body } : {}) });
  } catch (e) {
    throw networkError(e);
  }
  if (res.status === 204) return { data: null };
  const json = (await res.json().catch(() => ({}))) as { data?: unknown; page?: OffsetPage } & Problem;
  if (!res.ok) throw new ApiError(res.status, json);
  return { data: json.data, ...(json.page ? { page: json.page } : {}) };
}

export const admin = {
  async get<T>(path: string, query?: Query): Promise<T> { return (await send('GET', path, { query })).data as T; },
  async list<T = Row>(path: string, query?: Query): Promise<Listing<T>> {
    const r = await send('GET', path, { query });
    const items = (r.data as T[]) ?? [];
    return { items, page: r.page ?? { page: 1, pageSize: items.length, total: items.length, totalPages: 1 } };
  },
  async post<T = Row>(path: string, body?: unknown): Promise<T> { return (await send('POST', path, { body: body ?? {} })).data as T; },
  async put<T = Row>(path: string, body?: unknown): Promise<T> { return (await send('PUT', path, { body: body ?? {} })).data as T; },
  async patch<T = Row>(path: string, body: unknown): Promise<T> { return (await send('PATCH', path, { body })).data as T; },
  async del(path: string): Promise<void> { await send('DELETE', path); },
  async upload<T = Row>(method: 'POST' | 'PATCH', path: string, form: FormData): Promise<T> { return (await send(method, path, { form })).data as T; },
};

export const fmtDate = (iso: unknown): string => (typeof iso === 'string' && iso ? new Date(iso).toLocaleString() : '—');
