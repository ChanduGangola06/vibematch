import type { Response } from 'express';
import type { OffsetMeta, PageMeta } from '../pagination/index.js';

export interface Envelope<T> {
  data: T;
  page?: PageMeta | OffsetMeta;
  meta: { requestId: string };
}

/**
 * Builder for the success envelope: `{ data, page?, meta: { requestId } }`.
 * Keeping it in one place means every endpoint has the exact same shape.
 */
export class ResponseBuilder<T> {
  private statusCode = 200;
  private pageMeta: PageMeta | OffsetMeta | undefined;
  private readonly extraHeaders: Record<string, string> = {};

  constructor(private readonly payload: T) {}

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  page(meta: PageMeta | OffsetMeta): this {
    this.pageMeta = meta;
    return this;
  }

  header(name: string, value: string): this {
    this.extraHeaders[name] = value;
    return this;
  }

  build(requestId: string): { status: number; body: Envelope<T>; headers: Record<string, string> } {
    const body: Envelope<T> = {
      data: this.payload,
      ...(this.pageMeta ? { page: this.pageMeta } : {}),
      meta: { requestId },
    };
    return { status: this.statusCode, body, headers: this.extraHeaders };
  }

  send(res: Response, requestId: string): void {
    const { status, body, headers } = this.build(requestId);
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    res.status(status).json(body);
  }
}

export const respond = <T>(data: T): ResponseBuilder<T> => new ResponseBuilder(data);
