import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Redis } from 'ioredis';
import { io as ioClient, type Socket } from 'socket.io-client';
import type { Overrides } from '../../src/compose.js';
import { attachRealtime, type Realtime } from '../../src/realtime/realtime.js';
import { buildFullApp, type FullApp } from './full-app.js';

export interface SocketApp extends FullApp {
  server: http.Server;
  realtime: Realtime;
  url: string;
  clients: Socket[];
  /** Connect a client with an access token; resolves once connected. */
  connect(token: string | undefined): Promise<Socket>;
  /** Connect and expect the handshake to be refused; resolves with the server's error. */
  connectFails(token: string | undefined): Promise<Error & { data?: { code?: string } }>;
  stop(): Promise<void>;
}

export async function startSocketApp(
  env: Record<string, string | undefined> = {},
  overrides: Overrides = {},
  infra: { redis?: Redis; prefix?: string } = {},
): Promise<SocketApp> {
  const base = buildFullApp(env, overrides, infra);
  // Reuse the composition built for REST so domain-event listeners are registered exactly once.
  const server = http.createServer(base.app);
  const realtime = attachRealtime(server, base.realtimeDeps);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const clients: Socket[] = [];

  const open = (token: string | undefined) =>
    ioClient(url, { auth: token ? { token } : {}, transports: ['websocket'], reconnection: false, forceNew: true });

  return {
    ...base,
    server,
    realtime,
    url,
    clients,
    http: () => base.http(),
    connect: (token) =>
      new Promise((resolve, reject) => {
        const s = open(token);
        clients.push(s);
        s.once('connect', () => resolve(s));
        s.once('connect_error', reject);
      }),
    connectFails: (token) =>
      new Promise((resolve, reject) => {
        const s = open(token);
        clients.push(s);
        s.once('connect', () => reject(new Error('connected unexpectedly')));
        s.once('connect_error', (e) => resolve(e as never));
      }),
    async stop() {
      for (const c of clients) c.disconnect();
      await realtime.close();
      server.closeAllConnections();
    },
  };
}

/** Waits for one event on a socket. */
export const nextEvent = <T = any>(s: Socket, event: string, timeoutMs = 3000): Promise<T> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for "${event}"`)), timeoutMs);
    s.once(event, (p: T) => {
      clearTimeout(t);
      resolve(p);
    });
  });

/** Emits with an ack and resolves with the ack payload. */
export const call = <T = any>(s: Socket, event: string, payload?: unknown): Promise<T> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no ack for "${event}"`)), 3000);
    s.emit(event, payload, (res: T) => {
      clearTimeout(t);
      resolve(res);
    });
  });

/** Resolves true if the event does NOT arrive within `ms`. */
export const stays = (s: Socket, event: string, ms = 150): Promise<boolean> =>
  new Promise((resolve) => {
    const h = () => resolve(false);
    s.once(event, h);
    setTimeout(() => {
      s.off(event, h);
      resolve(true);
    }, ms);
  });
