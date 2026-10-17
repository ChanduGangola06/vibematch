import type { Socket } from 'socket.io-client';
import { vi } from 'vitest';

type Handler = (...args: any[]) => void;

/** Minimal in-memory stand-in for a socket.io client socket. */
export class FakeSocket {
  connected = false;
  readonly emitted: { event: string; payload: any }[] = [];
  /** event → function producing the ack payload (omit to never ack) */
  responders: Record<string, (payload: any) => any> = {};
  private handlers = new Map<string, Set<Handler>>();

  connect() { this.connected = true; queueMicrotask(() => this.fire('connect')); return this; }
  disconnect() { this.connected = false; this.fire('disconnect'); return this; }
  on(e: string, h: Handler) { (this.handlers.get(e) ?? this.handlers.set(e, new Set()).get(e)!).add(h); return this; }
  off(e: string, h?: Handler) { if (h) this.handlers.get(e)?.delete(h); else this.handlers.delete(e); return this; }
  emit(event: string, payload?: any, ack?: Handler) {
    this.emitted.push({ event, payload });
    const respond = this.responders[event];
    if (ack && respond) queueMicrotask(() => ack(respond(payload)));
    return this;
  }
  /** Simulates a server → client event. */
  fire(event: string, ...args: any[]) { this.handlers.get(event)?.forEach((h) => h(...args)); }
  count(event: string) { return this.emitted.filter((e) => e.event === event).length; }
  last(event: string) { return [...this.emitted].reverse().find((e) => e.event === event)?.payload; }
  asSocket() { return this as unknown as Socket; }
}

export function fakeMediaStream() {
  const track = (kind: string) => ({ kind, enabled: true, stop: vi.fn() });
  const tracks = [track('audio'), track('video')];
  return {
    tracks,
    stream: { getTracks: () => tracks, getAudioTracks: () => [tracks[0]], getVideoTracks: () => [tracks[1]] } as unknown as MediaStream,
  };
}

export const okAck = (extra: Record<string, unknown> = {}) => ({ ok: true, ...extra });
export const failAck = (code: string, message = code) => ({ ok: false, error: { code, message } });
