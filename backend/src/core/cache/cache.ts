/** Port implemented by every cache backend. Values must be JSON-serialisable. */
export interface Cache {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, opts?: SetOptions): Promise<void>;
  del(...keys: string[]): Promise<void>;
  /** Removes every key registered with `tag`. */
  invalidateTag(tag: string): Promise<void>;
  clear(): Promise<void>;
  /**
   * Cache-aside with single-flight: concurrent misses for the same key share one loader call,
   * which prevents a stampede on the database when a hot key expires.
   */
  wrap<T>(key: string, loader: () => Promise<T>, opts?: SetOptions): Promise<T>;
}

export interface SetOptions {
  /** Time to live in seconds. */
  ttl?: number;
  tags?: string[];
}

/** Shared implementation of `wrap` so backends only implement storage primitives. */
export abstract class BaseCache implements Cache {
  private readonly inflight = new Map<string, Promise<unknown>>();

  abstract get<T>(key: string): Promise<T | undefined>;
  abstract set<T>(key: string, value: T, opts?: SetOptions): Promise<void>;
  abstract del(...keys: string[]): Promise<void>;
  abstract invalidateTag(tag: string): Promise<void>;
  abstract clear(): Promise<void>;

  async wrap<T>(key: string, loader: () => Promise<T>, opts?: SetOptions): Promise<T> {
    const hit = await this.get<T>(key);
    if (hit !== undefined) return hit;
    const pending = this.inflight.get(key) as Promise<T> | undefined;
    if (pending) return pending;

    const p = (async () => {
      try {
        const value = await loader();
        // `undefined` is not cacheable (it is the miss sentinel); null is.
        if (value !== undefined) await this.set(key, value, opts);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }
}
