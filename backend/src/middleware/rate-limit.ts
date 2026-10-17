import type { Request, RequestHandler } from 'express';
import type { Env } from '../config/env.js';
import { TooManyRequestsError } from '../core/errors/index.js';

export interface HitResult {
  count: number;
  /** Milliseconds until the current window ends. */
  resetMs: number;
}

/** Storage port — memory for one instance, Redis when scaled out. */
export interface RateLimitStore {
  hit(key: string, windowMs: number): Promise<HitResult>;
}

export class MemoryRateStore implements RateLimitStore {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly now: () => number = Date.now) {
    this.timer = setInterval(() => this.sweep(), 30_000);
    this.timer.unref();
  }

  async hit(key: string, windowMs: number): Promise<HitResult> {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b || b.resetAt <= t) {
      b = { count: 0, resetAt: t + windowMs };
      this.buckets.set(key, b);
    }
    b.count++;
    return { count: b.count, resetMs: Math.max(0, b.resetAt - t) };
  }

  private sweep() {
    const t = this.now();
    for (const [k, b] of this.buckets) if (b.resetAt <= t) this.buckets.delete(k);
  }

  close() {
    clearInterval(this.timer);
  }
}

/** Minimal ioredis surface (atomic via a Lua script so INCR + PEXPIRE can never diverge). */
export interface RedisEvalLike {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

const LUA = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
return {c, ttl}
`;

export class RedisRateStore implements RateLimitStore {
  constructor(
    private readonly redis: RedisEvalLike,
    private readonly prefix = 'vm:rl:',
  ) {}

  async hit(key: string, windowMs: number): Promise<HitResult> {
    const res = (await this.redis.eval(LUA, 1, `${this.prefix}${key}`, windowMs)) as [number, number];
    return { count: Number(res[0]), resetMs: Math.max(0, Number(res[1])) };
  }
}

export interface LimiterOptions {
  name: string;
  max: number;
  windowMs: number;
  /** What the budget is shared by. */
  by: 'ip' | 'user' | 'user-or-ip';
  store: RateLimitStore;
  /** Extra discriminator, e.g. the username on login so one account can't be brute-forced from many IPs. */
  extraKey?: (req: Request) => string | undefined;
  message?: string;
}

function keyFor(req: Request, o: LimiterOptions): string {
  const who = o.by === 'ip' ? req.ip : o.by === 'user' ? req.auth?.userId : (req.auth?.userId ?? req.ip);
  const extra = o.extraKey?.(req);
  return `${o.name}:${who ?? 'anon'}${extra ? `:${extra}` : ''}`;
}

export function createRateLimiter(o: LimiterOptions): RequestHandler {
  return async (req, res, next) => {
    try {
      const { count, resetMs } = await o.store.hit(keyFor(req, o), o.windowMs);
      const resetSec = Math.ceil(resetMs / 1000);
      const remaining = Math.max(0, o.max - count);
      // Several limiters can stack (global + route); advertise the tightest one.
      const prev = res.getHeader('RateLimit-Remaining');
      if (prev === undefined || remaining < Number(prev)) {
        res.setHeader('RateLimit-Limit', String(o.max));
        res.setHeader('RateLimit-Remaining', String(remaining));
        res.setHeader('RateLimit-Reset', String(resetSec));
        res.setHeader('RateLimit-Policy', `${o.max};w=${Math.ceil(o.windowMs / 1000)}`);
      }
      if (count > o.max) return next(new TooManyRequestsError(resetSec, o.message));
      next();
    } catch (err) {
      // Fail open: a limiter outage must not take the API down. The failure is still logged.
      req.log?.error({ err }, 'rate limiter unavailable');
      next();
    }
  };
}

export type PolicyName = 'global' | 'user' | 'auth' | 'sensitive' | 'upload' | 'admin';

/** Named policies referenced by routes (`rateLimit: 'auth'`). */
export function createPolicies(env: Env, store: RateLimitStore): Record<PolicyName, RequestHandler> {
  const w = env.RATE_LIMIT_WINDOW_MS;
  return {
    global: createRateLimiter({ name: 'global', max: env.RATE_LIMIT_GLOBAL, windowMs: w, by: 'ip', store }),
    user: createRateLimiter({ name: 'user', max: env.RATE_LIMIT_USER, windowMs: w, by: 'user-or-ip', store }),
    auth: createRateLimiter({
      name: 'auth',
      max: env.RATE_LIMIT_AUTH,
      windowMs: w,
      by: 'ip',
      store,
      message: 'Too many authentication attempts, try again later',
      extraKey: (req) => {
        const body = req.body as { identifier?: unknown; username?: unknown; email?: unknown } | undefined;
        const id = body?.identifier ?? body?.username ?? body?.email;
        return typeof id === 'string' ? id.toLowerCase().slice(0, 64) : undefined;
      },
    }),
    sensitive: createRateLimiter({ name: 'sensitive', max: env.RATE_LIMIT_SENSITIVE, windowMs: w, by: 'user-or-ip', store }),
    upload: createRateLimiter({ name: 'upload', max: Math.max(5, Math.floor(env.RATE_LIMIT_SENSITIVE / 2)), windowMs: w, by: 'user-or-ip', store }),
    admin: createRateLimiter({ name: 'admin', max: env.RATE_LIMIT_USER * 2, windowMs: w, by: 'user-or-ip', store }),
  };
}
