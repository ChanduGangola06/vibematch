import { describe, expect, it, vi } from 'vitest';
import { MemoryLruCache } from '../../src/core/cache/index.js';
import { createAsyncLogger } from '../../src/core/logger/index.js';
import { PresenceService } from '../../src/modules/matching/presence.service.js';
import { IceService, STUN_FALLBACK, type IceConfig } from '../../src/modules/webrtc/ice.service.js';
import { SocketLimiter } from '../../src/realtime/socket-limiter.js';

const log = createAsyncLogger({ level: 'silent', flushMs: 1000 }).logger;
const res = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('IceService (strategy per vendor, cached, degrades to STUN)', () => {
  const make = (cfg: IceConfig, fetchImpl: typeof fetch) => new IceService({ get: async () => cfg }, new MemoryLruCache(), log, fetchImpl);

  it('default → public STUN', async () => {
    expect(await make({ provider: 'default' }, fetch).servers()).toEqual(STUN_FALLBACK);
  });

  it('twilio: basic auth, maps ice_servers', async () => {
    const f = vi.fn().mockResolvedValue(res({ ice_servers: [{ url: 'stun:s', urls: 'stun:s' }, { urls: 'turn:t', username: 'u', credential: 'c' }] }));
    const servers = await make({ provider: 'twilio', accountSid: 'AC1', authToken: 'tok' }, f as never).servers();
    expect(servers).toEqual([{ urls: 'stun:s' }, { urls: 'turn:t', username: 'u', credential: 'c' }]);
    expect(String(f.mock.calls[0]![0])).toContain('/Accounts/AC1/Tokens.json');
    expect((f.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ Authorization: `Basic ${Buffer.from('AC1:tok').toString('base64')}` });
  });

  it('metered: key goes in the query string, host from appName', async () => {
    const f = vi.fn().mockResolvedValue(res([{ urls: 'turn:m', username: 'a', credential: 'b' }]));
    const servers = await make({ provider: 'metered', apiKey: 'K', appName: 'myapp' }, f as never).servers();
    expect(servers).toHaveLength(1);
    expect(String(f.mock.calls[0]![0])).toBe('https://myapp.metered.live/api/v1/turn/credentials?apiKey=K');
  });

  it('xirsys: PUT with basic auth, wraps the single iceServers object', async () => {
    const f = vi.fn().mockResolvedValue(res({ v: { iceServers: { urls: ['turn:x'], username: 'u', credential: 'c' } } }));
    const servers = await make({ provider: 'xirsys', domain: 'd', secret: 's', channel: 'Chan' }, f as never).servers();
    expect(servers).toEqual([{ urls: ['turn:x'], username: 'u', credential: 'c' }]);
    expect(String(f.mock.calls[0]![0])).toBe('https://global.xirsys.net/_turn/Chan');
    expect((f.mock.calls[0]![1] as RequestInit).method).toBe('PUT');
  });

  it('caches vendor responses and falls back to STUN when the vendor fails or returns nothing', async () => {
    const f = vi.fn().mockResolvedValue(res([{ urls: 'turn:m' }]));
    const svc = make({ provider: 'metered', apiKey: 'K' }, f as never);
    await svc.servers();
    await svc.servers();
    expect(f).toHaveBeenCalledTimes(1);

    const down = vi.fn().mockRejectedValue(new Error('network'));
    expect(await make({ provider: 'twilio', accountSid: 'a', authToken: 'b' }, down as never).servers()).toEqual(STUN_FALLBACK);
    const bad = vi.fn().mockResolvedValue(res({}, 500));
    expect(await make({ provider: 'xirsys', domain: 'd', secret: 's' }, bad as never).servers()).toEqual(STUN_FALLBACK);
    const empty = vi.fn().mockResolvedValue(res([]));
    expect(await make({ provider: 'metered', apiKey: 'K' }, empty as never).servers()).toEqual(STUN_FALLBACK);
  });
});

describe('PresenceService', () => {
  it('single instance: local count + admin fake extra; hidden when disabled', async () => {
    let n = 7;
    const p = new PresenceService(() => n, { show: async () => true, fakeExtra: async () => 100 });
    expect(await p.visibleCount()).toBe(107);
    n = 8;
    p.setLocalCounter(() => 3);
    expect(await p.realCount()).toBe(3);
    expect(await new PresenceService(() => 5, { show: async () => false, fakeExtra: async () => 0 }).visibleCount()).toBeNull();
    expect(await new PresenceService(() => 5, { show: async () => true, fakeExtra: async () => -50 }).visibleCount()).toBe(5);
  });

  it('cluster: sums the per-instance counts shared through Redis', async () => {
    const store = new Map<string, string>();
    const redis = {
      set: async (k: string, v: string) => void store.set(k, v),
      scan: async () => ['0', [...store.keys()]] as [string, string[]],
      mget: async (...ks: string[]) => ks.map((k) => store.get(k) ?? null),
    };
    const a = new PresenceService(() => 10, undefined, redis, 'a');
    const b = new PresenceService(() => 5, undefined, redis, 'b');
    await b.realCount();
    expect(await a.realCount()).toBe(15);
  });

  it('start() ticks with the visible count and stop() halts it', async () => {
    const p = new PresenceService(() => 2);
    const ticks: number[] = [];
    p.start((n) => ticks.push(n), 10);
    await new Promise((r) => setTimeout(r, 55));
    p.stop();
    const seen = ticks.length;
    expect(seen).toBeGreaterThanOrEqual(2);
    expect(ticks.every((t) => t === 2)).toBe(true);
    await new Promise((r) => setTimeout(r, 40));
    expect(ticks.length).toBe(seen);
  });
});

describe('SocketLimiter', () => {
  it('allows the budget, then reports the wait, then recovers', () => {
    let now = 0;
    const l = new SocketLimiter({ e: { max: 2, windowMs: 1000 } }, () => now);
    expect(l.check('e')).toBe(0);
    now = 100;
    expect(l.check('e')).toBe(0);
    now = 200;
    expect(l.check('e')).toBe(1);
    now = 1001;
    expect(l.check('e')).toBe(0);
    expect(l.check('unlimited-event')).toBe(0);
  });
});
