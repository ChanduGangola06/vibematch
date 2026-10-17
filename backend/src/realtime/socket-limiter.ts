export interface Budget {
  max: number;
  windowMs: number;
}

/** Per-socket, per-event sliding budget. Cheap, in-memory: a socket lives on exactly one instance. */
export class SocketLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly budgets: Record<string, Budget>,
    private readonly now: () => number = Date.now,
  ) {}

  /** @returns seconds to wait when over budget, or 0 when allowed. */
  check(event: string): number {
    const b = this.budgets[event];
    if (!b) return 0;
    const t = this.now();
    const recent = (this.hits.get(event) ?? []).filter((x) => t - x < b.windowMs);
    if (recent.length >= b.max) {
      this.hits.set(event, recent);
      return Math.ceil((b.windowMs - (t - recent[0]!)) / 1000);
    }
    recent.push(t);
    this.hits.set(event, recent);
    return 0;
  }
}

export const DEFAULT_SOCKET_BUDGETS: Record<string, Budget> = {
  join_queue: { max: 20, windowMs: 60_000 },
  leave_queue: { max: 60, windowMs: 60_000 },
  skip_match: { max: 60, windowMs: 60_000 },
  signal: { max: 300, windowMs: 10_000 }, // ICE candidates arrive in bursts
  send_message: { max: 40, windowMs: 60_000 },
  send_gift: { max: 20, windowMs: 60_000 },
};
