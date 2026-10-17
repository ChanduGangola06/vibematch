import pino, { type DestinationStream, type Logger as PinoLogger } from 'pino';

export type Logger = PinoLogger;

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.newPassword',
  '*.oldPassword',
  '*.passwordHash',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.idToken',
  '*.receipt',
  '*.secret',
  '*.apiKey',
  '*Secret*',
  '*.smtpPass',
];

export interface AsyncLoggerOptions {
  level: string;
  flushMs: number;
  /** Override for tests. Any pino-compatible destination. */
  destination?: DestinationStream;
  name?: string;
}

export interface AsyncLogger {
  logger: Logger;
  /** Flushes buffered lines to the sink (async). */
  flush(): Promise<void>;
  /** Stops the flush timer and writes everything synchronously. Call on shutdown. */
  close(): void;
}

interface Flushable extends DestinationStream {
  flush?(cb?: (err?: Error) => void): void;
  flushSync?(): void;
  end?(): void;
}

/**
 * Asynchronous logging: lines go to an in-memory buffer (SonicBoom, `sync:false`) and are
 * written to the descriptor in batches — on a timer or once `minLength` bytes accumulate —
 * so request handlers never wait on disk/stdout I/O.
 */
export function createAsyncLogger(opts: AsyncLoggerOptions): AsyncLogger {
  const dest: Flushable =
    (opts.destination as Flushable | undefined) ?? pino.destination({ dest: 1, sync: false, minLength: 4096 });

  const logger = pino(
    {
      level: opts.level,
      name: opts.name ?? 'vibematch',
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
      timestamp: pino.stdTimeFunctions.isoTime,
      base: { pid: process.pid },
    },
    dest,
  );

  const flush = (): Promise<void> =>
    new Promise((resolve) => {
      if (!dest.flush) return resolve();
      try {
        dest.flush(() => resolve());
      } catch {
        resolve();
      }
    });

  const timer = setInterval(() => void flush(), opts.flushMs);
  timer.unref();

  return {
    logger,
    flush,
    close() {
      clearInterval(timer);
      try {
        dest.flushSync?.();
      } catch {
        /* destination not ready / already closed */
      }
    },
  };
}
