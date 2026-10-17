import { BadGatewayError } from '../../../core/errors/index.js';

export type FetchLike = typeof fetch;

/**
 * JSON call to a third party with a hard timeout. HTTP errors are returned to the caller (it knows
 * what a 4xx means for that gateway); network failures become a 502.
 */
export async function callJson<T = unknown>(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  what: string,
): Promise<{ status: number; ok: boolean; body: T }> {
  try {
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    let body: unknown = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text.slice(0, 200) };
    }
    return { status: res.status, ok: res.ok, body: body as T };
  } catch (err) {
    throw new BadGatewayError(`${what} is unreachable`, err);
  }
}
