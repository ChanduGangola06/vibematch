export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** Controllable clock for tests. */
export class FakeClock implements Clock {
  constructor(private current = Date.now()) {}
  now(): number {
    return this.current;
  }
  advance(ms: number): void {
    this.current += ms;
  }
  set(ms: number): void {
    this.current = ms;
  }
}
