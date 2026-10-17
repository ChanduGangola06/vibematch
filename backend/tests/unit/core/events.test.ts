import { describe, expect, it, vi } from 'vitest';
import { createEventBus } from '../../../src/core/events/index.js';

describe('EventBus', () => {
  it('delivers to all subscribers and supports unsubscribe', async () => {
    const bus = createEventBus();
    const a = vi.fn();
    const b = vi.fn();
    const offA = bus.on('settings.changed', a);
    bus.on('settings.changed', b);
    await bus.emitAndWait('settings.changed', { group: 'mail' });
    offA();
    await bus.emitAndWait('settings.changed', { group: 'seo' });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
    expect(bus.listenerCount('settings.changed')).toBe(1);
  });

  it('isolates failing handlers and reports them', async () => {
    const error = vi.fn();
    const bus = createEventBus({ error });
    const good = vi.fn();
    bus.on('user.deleted', async () => { throw new Error('boom'); });
    bus.on('user.deleted', good);
    await bus.emitAndWait('user.deleted', { userId: 'u1' });
    expect(good).toHaveBeenCalledWith({ userId: 'u1' });
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('once() fires a single time; emit() is fire-and-forget', async () => {
    const bus = createEventBus();
    const h = vi.fn();
    bus.once('user.banned', h);
    bus.emit('user.banned', { userId: 'u', banned: true });
    bus.emit('user.banned', { userId: 'u', banned: false });
    await new Promise((r) => setTimeout(r, 5));
    expect(h).toHaveBeenCalledTimes(1);
    bus.clear();
    expect(bus.listenerCount('user.banned')).toBe(0);
    await bus.emitAndWait('user.banned', { userId: 'x', banned: true }); // no listeners: no-op
  });
});
