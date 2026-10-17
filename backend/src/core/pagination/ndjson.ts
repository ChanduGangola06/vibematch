import type { Response } from 'express';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * Streams an async iterable (e.g. a Mongo cursor) as newline-delimited JSON with back-pressure.
 * Memory use stays flat no matter how many rows are exported.
 */
export async function streamNdjson<T>(
  res: Response,
  source: AsyncIterable<T> | Iterable<T>,
  map: (row: T) => unknown = (r) => r,
  filename?: string,
): Promise<void> {
  res.status(200);
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (filename) res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/[^\w.-]/g, '_')}"`);

  const toLine = new Transform({
    writableObjectMode: true,
    transform(row: T, _enc, cb) {
      try {
        cb(null, `${JSON.stringify(map(row))}\n`);
      } catch (e) {
        cb(e as Error);
      }
    },
  });

  try {
    await pipeline(Readable.from(source as AsyncIterable<T>), toLine, res);
  } catch (e) {
    // Client went away mid-stream: nothing to report. Anything else is a real error.
    if ((e as NodeJS.ErrnoException).code !== 'ERR_STREAM_PREMATURE_CLOSE') throw e;
  }
}
