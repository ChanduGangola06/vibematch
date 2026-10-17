export interface PresenceConfig {
  show(): Promise<boolean>;
  /** Admin-configured number added to the real count ("fake online users"). */
  fakeExtra(): Promise<number>;
}
export const defaultPresenceConfig: PresenceConfig = { show: async () => true, fakeExtra: async () => 0 };

/** The ioredis calls used to share per-instance counts. */
export interface RedisPresenceLike {
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  scan(cursor: string, ...args: (string | number)[]): Promise<[string, string[]]>;
  mget(...keys: string[]): Promise<(string | null)[]>;
}

const PREFIX = 'vm:presence:';

/**
 * Online-user counter. Each instance reports how many sockets it holds; the cluster total is the sum
 * of the (TTL-guarded) per-instance numbers, so a crashed instance disappears from the total by itself.
 * One computation per tick is broadcast to everybody — nothing is computed per request or per client.
 */
export class PresenceService {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private localCount: () => number,
    private readonly config: PresenceConfig = defaultPresenceConfig,
    private readonly redis?: RedisPresenceLike,
    private readonly instanceId = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
  ) {}

  /** The socket server provides the local figure once it exists. */
  setLocalCounter(fn: () => number): void {
    this.localCount = fn;
  }

  /** Real connections across the whole cluster. */
  async realCount(): Promise<number> {
    const local = this.localCount();
    if (!this.redis) return local;
    await this.redis.set(PREFIX + this.instanceId, String(local), 'EX', 15);
    let cursor = '0';
    const keys: string[] = [];
    do {
      const [next, batch] = await this.redis.scan(cursor, 'MATCH', `${PREFIX}*`, 'COUNT', 100);
      keys.push(...batch);
      cursor = next;
    } while (cursor !== '0');
    if (keys.length === 0) return local;
    const values = await this.redis.mget(...keys);
    return values.reduce((sum, v) => sum + (Number(v) || 0), 0);
  }

  /** The figure shown to users, or null when the admin hides it. */
  async visibleCount(): Promise<number | null> {
    if (!(await this.config.show())) return null;
    return (await this.realCount()) + Math.max(0, await this.config.fakeExtra());
  }

  start(onTick: (count: number) => void, everyMs = 5000): void {
    this.stop();
    this.timer = setInterval(() => {
      void this.visibleCount().then((n) => n !== null && onTick(n)).catch(() => {});
    }, everyMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
