/** Minimal logger surface so core has no hard dependency on pino. */
interface ErrorLogger {
  error(obj: unknown, msg?: string): void;
}

export type Handler<P> = (payload: P) => void | Promise<void>;

/**
 * Typed in-process Observer. Handlers are isolated: one failing subscriber never breaks the
 * publisher or the other subscribers. Swap for a broker-backed implementation without touching callers.
 */
export class EventBus<M extends { [K in keyof M]: unknown }> {
  private readonly handlers = new Map<keyof M, Set<Handler<never>>>();

  constructor(private readonly log?: ErrorLogger) {}

  on<K extends keyof M>(event: K, handler: Handler<M[K]>): () => void {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(handler as Handler<never>);
    return () => set.delete(handler as Handler<never>);
  }

  once<K extends keyof M>(event: K, handler: Handler<M[K]>): () => void {
    const off = this.on(event, async (p) => {
      off();
      await handler(p);
    });
    return off;
  }

  /** Fire-and-forget: returns immediately, handlers run on the microtask queue. */
  emit<K extends keyof M>(event: K, payload: M[K]): void {
    void this.emitAndWait(event, payload);
  }

  /** Resolves when every handler finished (errors are logged, never thrown). */
  async emitAndWait<K extends keyof M>(event: K, payload: M[K]): Promise<void> {
    const set = this.handlers.get(event);
    if (!set || set.size === 0) return;
    await Promise.all(
      [...set].map(async (h) => {
        try {
          await (h as Handler<M[K]>)(payload);
        } catch (err) {
          this.log?.error({ err, event: String(event) }, 'event handler failed');
        }
      }),
    );
  }

  listenerCount(event: keyof M): number {
    return this.handlers.get(event)?.size ?? 0;
  }

  clear(): void {
    this.handlers.clear();
  }
}
