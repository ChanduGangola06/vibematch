import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createAsyncLogger } from '../../../src/core/logger/index.js';
import { FakeClock, UUID_RE, newId, systemClock, uuidv7 } from '../../../src/core/utils/index.js';

describe('async logger', () => {
  it('redacts secrets and writes JSON lines', async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _e, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const { logger, flush, close } = createAsyncLogger({ level: 'info', flushMs: 50, destination: sink as never });
    logger.info({ user: { password: 'p', token: 't', name: 'ok' }, req: { headers: { authorization: 'Bearer x' } } }, 'hello');
    await flush();
    close();
    const out = JSON.parse(lines.join('').trim().split('\n')[0]!);
    expect(out.msg).toBe('hello');
    expect(out.user.password).toBe('[redacted]');
    expect(out.user.token).toBe('[redacted]');
    expect(out.user.name).toBe('ok');
    expect(out.req.headers.authorization).toBe('[redacted]');
  });

  it('respects the level', async () => {
    const lines: string[] = [];
    const sink = new Writable({ write(c, _e, cb) { lines.push(c.toString()); cb(); } });
    const { logger, close } = createAsyncLogger({ level: 'warn', flushMs: 50, destination: sink as never });
    logger.info('no');
    logger.warn('yes');
    close();
    expect(lines.join('')).toContain('yes');
    expect(lines.join('')).not.toContain('"no"');
  });
});

describe('ids and clock', () => {
  it('generates valid, time-sortable UUIDv7', () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a).toMatch(UUID_RE);
    expect(a[14]).toBe('7');
    expect(a < b).toBe(true);
    expect(newId('msg')).toMatch(/^msg_[0-9a-f-]{36}$/);
    expect(new Set(Array.from({ length: 500 }, () => uuidv7())).size).toBe(500);
  });

  it('fake clock is controllable', () => {
    const c = new FakeClock(1000);
    c.advance(500);
    expect(c.now()).toBe(1500);
    c.set(5);
    expect(c.now()).toBe(5);
    expect(Math.abs(systemClock.now() - Date.now())).toBeLessThan(50);
  });
});
