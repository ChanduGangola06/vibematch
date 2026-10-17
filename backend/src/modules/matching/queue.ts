export type Gender = 'male' | 'female' | 'other' | '';
export type GenderPref = 'male' | 'female' | 'both';

/** One waiting user. `prefGender` / `prefCountry` are the *effective* preferences (already VIP-checked). */
export interface QueueEntry {
  socketId: string;
  userId: string;
  gender: Gender;
  country: string;
  countryCode: string;
  prefGender: GenderPref;
  /** '' = anywhere. Compared against the other side's country name or ISO code, case-insensitively. */
  prefCountry: string;
  superMatch: boolean;
  joinedAt: number;
}

/** A rule decides whether two waiting users may be paired. Rules are composed into a chain. */
export type MatchRule = (a: QueueEntry, b: QueueEntry) => boolean;

/**
 * Chain of Responsibility: every rule must accept the pair. Cheap rules go first.
 * Adding a rule (blocklists, age ranges…) means appending one function.
 */
export const allOf =
  (...rules: MatchRule[]): MatchRule =>
  (a, b) =>
    rules.every((r) => r(a, b));

export const differentUser: MatchRule = (a, b) => a.userId !== b.userId;

export const genderCompatible: MatchRule = (a, b) =>
  (a.prefGender === 'both' || a.prefGender === b.gender) && (b.prefGender === 'both' || b.prefGender === a.gender);

const matchesCountry = (e: QueueEntry, wanted: string): boolean => {
  if (!wanted) return true;
  const w = wanted.toLowerCase();
  return e.country.toLowerCase() === w || e.countryCode.toLowerCase() === w;
};
export const countryCompatible: MatchRule = (a, b) => matchesCountry(b, a.prefCountry) && matchesCountry(a, b.prefCountry);

export const defaultRules: MatchRule = allOf(differentUser, genderCompatible, countryCompatible);

/**
 * Waiting-room port. `matchOrEnqueue` is ATOMIC: either it claims a compatible waiting user (and the
 * newcomer is not queued) or it queues the newcomer — so two users arriving at the same moment can
 * never both end up waiting for each other.
 */
export interface MatchQueue {
  matchOrEnqueue(entry: QueueEntry, rule: MatchRule): Promise<QueueEntry | null>;
  /** True when the socket was still waiting (and is now removed). */
  remove(socketId: string): Promise<boolean>;
  size(): Promise<number>;
  /** Drops zombies (e.g. a crashed instance's entries). Returns how many were removed. */
  purge(maxAgeMs: number, now?: number): Promise<number>;
}

/** Single-process queue: FIFO, synchronous critical section (JS is single-threaded between awaits). */
export class MemoryMatchQueue implements MatchQueue {
  private readonly entries = new Map<string, QueueEntry>();

  async matchOrEnqueue(entry: QueueEntry, rule: MatchRule): Promise<QueueEntry | null> {
    this.entries.delete(entry.socketId); // re-joining replaces the old entry
    for (const candidate of this.entries.values()) {
      if (rule(entry, candidate)) {
        this.entries.delete(candidate.socketId);
        return candidate;
      }
    }
    this.entries.set(entry.socketId, entry);
    return null;
  }

  async remove(socketId: string): Promise<boolean> {
    return this.entries.delete(socketId);
  }

  async size(): Promise<number> {
    return this.entries.size;
  }

  async purge(maxAgeMs: number, now = Date.now()): Promise<number> {
    let n = 0;
    for (const [id, e] of this.entries) {
      if (now - e.joinedAt > maxAgeMs) {
        this.entries.delete(id);
        n++;
      }
    }
    return n;
  }
}

/** The ioredis calls the Redis queue needs (injectable so it can be unit-tested). */
export interface RedisQueueLike {
  set(key: string, value: string, ...args: (string | number)[]): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  hset(key: string, field: string, value: string): Promise<number>;
  hget(key: string, field: string): Promise<string | null>;
  hmget(key: string, ...fields: string[]): Promise<(string | null)[]>;
  hdel(key: string, ...fields: string[]): Promise<number>;
  zadd(key: string, score: number, member: string): Promise<number | string>;
  zrange(key: string, start: number, stop: number): Promise<string[]>;
  zrem(key: string, ...members: string[]): Promise<number>;
  zcard(key: string): Promise<number>;
  zremrangebyscore(key: string, min: number | string, max: number | string): Promise<number>;
}

const LOCK_KEY = 'vm:mq:lock';
const ORDER_KEY = 'vm:mq:order';
const DATA_KEY = 'vm:mq:data';
const SCAN_LIMIT = 300;

/**
 * Redis-backed queue for multi-instance deployments. A short distributed lock makes
 * `matchOrEnqueue` atomic across instances; the sorted set keeps FIFO order.
 */
export class RedisMatchQueue implements MatchQueue {
  constructor(
    private readonly redis: RedisQueueLike,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const token = `${process.pid}:${Math.random()}`;
    for (let i = 0; i < 400; i++) {
      if ((await this.redis.set(LOCK_KEY, token, 'PX', 1000, 'NX')) === 'OK') {
        try {
          return await fn();
        } finally {
          // best effort release; the 1 s TTL protects against a crash while holding the lock
          await this.redis.del(LOCK_KEY).catch(() => {});
        }
      }
      await this.sleep(5 + Math.floor(Math.random() * 10));
    }
    throw new Error('match queue lock timeout');
  }

  async matchOrEnqueue(entry: QueueEntry, rule: MatchRule): Promise<QueueEntry | null> {
    return this.withLock(async () => {
      await this.removeNow(entry.socketId);
      const ids = await this.redis.zrange(ORDER_KEY, 0, SCAN_LIMIT - 1);
      if (ids.length) {
        const rows = await this.redis.hmget(DATA_KEY, ...ids);
        for (let i = 0; i < ids.length; i++) {
          const raw = rows[i];
          if (!raw) {
            await this.redis.zrem(ORDER_KEY, ids[i]!); // dangling order entry
            continue;
          }
          const candidate = JSON.parse(raw) as QueueEntry;
          if (rule(entry, candidate)) {
            await this.removeNow(candidate.socketId);
            return candidate;
          }
        }
      }
      await this.redis.hset(DATA_KEY, entry.socketId, JSON.stringify(entry));
      await this.redis.zadd(ORDER_KEY, entry.joinedAt, entry.socketId);
      return null;
    });
  }

  private async removeNow(socketId: string): Promise<boolean> {
    const removed = await this.redis.zrem(ORDER_KEY, socketId);
    await this.redis.hdel(DATA_KEY, socketId);
    return removed > 0;
  }

  async remove(socketId: string): Promise<boolean> {
    return this.withLock(() => this.removeNow(socketId));
  }

  size(): Promise<number> {
    return this.redis.zcard(ORDER_KEY);
  }

  async purge(maxAgeMs: number, now = Date.now()): Promise<number> {
    return this.withLock(async () => {
      const stale = await this.redis.zrange(ORDER_KEY, 0, SCAN_LIMIT - 1);
      let n = 0;
      if (stale.length) {
        const rows = await this.redis.hmget(DATA_KEY, ...stale);
        for (let i = 0; i < stale.length; i++) {
          const e = rows[i] ? (JSON.parse(rows[i]!) as QueueEntry) : null;
          if (!e || now - e.joinedAt > maxAgeMs) {
            await this.removeNow(stale[i]!);
            n++;
          }
        }
      }
      return n;
    });
  }
}
