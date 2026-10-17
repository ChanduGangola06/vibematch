import { createAdapter } from '@socket.io/redis-adapter';
import type { Redis } from 'ioredis';
import type http from 'node:http';
import { Server } from 'socket.io';
import { z, type ZodType } from 'zod';
import type { Env } from '../config/env.js';
import type { AppEventBus } from '../core/events/index.js';
import { ConflictError, normalizeError } from '../core/errors/index.js';
import type { Metrics } from '../core/http/index.js';
import type { Logger } from '../core/logger/index.js';
import type { TokenService } from '../core/security/tokens.js';
import { UserModel } from '../infra/db/models/user.js';
import type { SessionRevocationPort, UserStatusPort } from '../middleware/authenticate.js';
import type { ChatService } from '../modules/chat/chat.service.js';
import type { GiftService } from '../modules/gifts/gift.service.js';
import type { MatchingService, PeerNotifier } from '../modules/matching/matching.service.js';
import type { PresenceService } from '../modules/matching/presence.service.js';
import { DEFAULT_SOCKET_BUDGETS, SocketLimiter, type Budget } from './socket-limiter.js';

/** Notifier that can be created before the Socket.IO server exists (matching is built first). */
export class SwitchableNotifier implements PeerNotifier {
  private io: Server | undefined;
  bind(io: Server): void {
    this.io = io;
  }
  emit(socketId: string, event: string, payload: unknown): void {
    this.io?.to(socketId).emit(event, payload);
  }
}

export interface RealtimeDeps {
  env: Env;
  log: Logger;
  tokens: TokenService;
  userStatus: UserStatusPort;
  revocations: SessionRevocationPort;
  events: AppEventBus;
  metrics: Metrics;
  matching: MatchingService;
  chat: ChatService;
  gifts: GiftService;
  presence: PresenceService;
  notifier: SwitchableNotifier;
  redis?: Redis | undefined;
  budgets?: Record<string, Budget>;
}

export interface Realtime {
  io: Server;
  close(): Promise<void>;
}

interface SocketUser {
  userId: string;
  role: string;
  sid: string;
  username?: string | undefined;
}

// ---- payload schemas (every client message is validated; unknown keys are rejected) ---------------
const genderPref = z.enum(['male', 'female', 'both']);
const joinQueue = z.object({
  gender: genderPref.optional(),
  country: z.string().trim().max(60).optional(),
  superMatch: z.boolean().optional(),
}).strict();
const signal = z.object({
  signal: z.object({
    type: z.enum(['offer', 'answer', 'candidate']),
    sdp: z.unknown().optional(),
    candidate: z.unknown().optional(),
  }).strict(),
}).strict();
const sendMessage = z.object({ text: z.string().min(1).max(2000) }).strict();
const sendGift = z.object({ giftId: z.string().min(1).max(64) }).strict();
const noPayload = z.object({}).strict().optional();

type Ack = (res: unknown) => void;

/**
 * Attaches Socket.IO to the HTTP server.
 *  - authentication happens in the handshake (access token), identity then comes from `socket.data`
 *  - the server decides who a socket may talk to (its matched peer) — clients never address sockets
 *  - domain events (messages, likes, bans, revoked sessions) are pushed to rooms `user:<id>` / `sid:<id>`
 */
export function attachRealtime(server: http.Server, d: RealtimeDeps): Realtime {
  const allowed = new Set([...d.env.corsOrigins, ...(d.env.isProd ? [] : [d.env.PUBLIC_URL])]);
  const io = new Server(server, {
    serveClient: false,
    maxHttpBufferSize: 100_000,
    pingInterval: 25_000,
    pingTimeout: 20_000,
    connectTimeout: 10_000,
    cors: {
      origin: (origin, cb) => cb(null, !origin || allowed.has(origin)),
      credentials: true,
    },
  });
  d.notifier.bind(io);

  let subClient: Redis | undefined;
  if (d.redis) {
    subClient = d.redis.duplicate();
    io.adapter(createAdapter(d.redis, subClient));
  }

  // ---- authentication ---------------------------------------------------------------------------
  io.use(async (socket, next) => {
    try {
      const raw = (socket.handshake.auth as { token?: unknown } | undefined)?.token
        ?? /^Bearer (.+)$/i.exec(socket.handshake.headers.authorization ?? '')?.[1];
      if (typeof raw !== 'string' || !raw) throw Object.assign(new Error('unauthorized'), { data: { code: 'unauthorized' } });
      let claims;
      try {
        claims = d.tokens.verifyAccess(raw);
      } catch (e) {
        throw Object.assign(new Error('unauthorized'), { data: { code: (e as { code?: string }).code ?? 'token_invalid' } });
      }
      if (await d.revocations.isRevoked(claims.sid)) throw Object.assign(new Error('unauthorized'), { data: { code: 'session_revoked' } });
      const status = await d.userStatus.get(claims.sub);
      if (!status) throw Object.assign(new Error('unauthorized'), { data: { code: 'account_not_found' } });
      if (status.isBanned) throw Object.assign(new Error('forbidden'), { data: { code: 'account_banned' } });
      socket.data.user = { userId: claims.sub, role: status.role, sid: claims.sid, username: status.username } satisfies SocketUser;
      next();
    } catch (err) {
      next(err as Error);
    }
  });

  // ---- connection -------------------------------------------------------------------------------
  io.on('connection', (socket) => {
    const me = socket.data.user as SocketUser;
    const limiter = new SocketLimiter(d.budgets ?? DEFAULT_SOCKET_BUDGETS);
    void socket.join([`user:${me.userId}`, `sid:${me.sid}`]);
    d.metrics.socketConnections.inc();
    void UserModel.updateOne({ id: me.userId }, { $set: { isOnline: true } }).catch(() => {});

    /** Common wrapper: rate limit → validate → run → ack. Errors never crash the socket. */
    const on = <T>(event: string, schema: ZodType<T>, run: (payload: T) => Promise<Record<string, unknown> | void>) => {
      socket.on(event, async (raw: unknown, ack?: Ack) => {
        const reply = typeof ack === 'function' ? ack : () => {};
        try {
          const wait = limiter.check(event);
          if (wait > 0) return reply({ ok: false, error: { code: 'rate_limited', message: 'Too many requests', retryAfter: wait } });
          const payload = schema.parse(raw ?? {});
          reply({ ok: true, ...((await run(payload)) ?? {}) });
        } catch (err) {
          const app = normalizeError(err);
          if (app.status >= 500) d.log.error({ err: app.cause ?? app, event }, 'socket handler failed');
          const error = { code: app.code, message: app.status >= 500 ? 'Internal error' : (app.detail ?? app.title) };
          reply({ ok: false, error });
          if (event === 'join_queue') socket.emit('match_error', error); // legacy listeners
        }
      });
    };

    on('join_queue', joinQueue, async (p) => {
      const r = await d.matching.join({ socketId: socket.id, userId: me.userId, gender: p.gender, country: p.country, superMatch: p.superMatch });
      return { status: r.status, applied: r.applied };
    });
    on('leave_queue', noPayload, async () => d.matching.leave(socket.id));
    on('skip_match', noPayload, async () => d.matching.end(socket.id, 'skipped'));

    on('signal', signal, async (p) => {
      const s = await d.matching.session(socket.id);
      // Only a socket that is currently matched can signal, and only to its own peer.
      if (!s || s.isDemo) return { delivered: false };
      d.notifier.emit(s.partnerSocketId, 'signal', { from: socket.id, signal: p.signal });
      return { delivered: true };
    });

    on('send_message', sendMessage, async (p) => {
      const s = await d.matching.session(socket.id);
      if (!s) throw new ConflictError('You are not in a call', 'not_in_call');
      const message = await d.chat.send(me.userId, s.partnerUserId, p.text, { skipPermission: true });
      return { message };
    });

    on('send_gift', sendGift, async (p) => {
      const s = await d.matching.session(socket.id);
      if (!s) throw new ConflictError('You are not in a call', 'not_in_call');
      const r = await d.gifts.send(me.userId, s.partnerUserId, p.giftId, { skipPermission: true });
      return { message: r.message, balance: r.balance, gift: r.gift };
    });

    socket.on('disconnect', async () => {
      d.metrics.socketConnections.dec();
      try {
        await d.matching.disconnect(socket.id);
        const remaining = await io.in(`user:${me.userId}`).fetchSockets();
        if (remaining.length === 0) await UserModel.updateOne({ id: me.userId }, { $set: { isOnline: false } });
      } catch (err) {
        d.log.warn({ err }, 'socket cleanup failed');
      }
    });
  });

  // ---- domain events → sockets (Observer) -------------------------------------------------------
  const offs = [
    d.events.on('message.sent', ({ messageId, senderId, receiverId, text, isGift, createdAt, gift }) => {
      const dto = { id: messageId, senderId, receiverId, text, isRead: false, createdAt, ...(isGift && gift ? { gift } : {}) };
      // `receive_message` feeds an open call UI; `new_message_notification` feeds the inbox. Clients filter by sender.
      io.to(`user:${receiverId}`).emit('receive_message', { from: senderId, ...dto });
      io.to(`user:${receiverId}`).emit('new_message_notification', dto);
    }),
    d.events.on('user.liked', ({ targetId, likesCount }) => void io.to(`user:${targetId}`).emit('partner_liked', { newLikesCount: likesCount })),
    d.events.on('user.banned', ({ userId, banned }) => {
      if (banned) io.in(`user:${userId}`).disconnectSockets(true);
    }),
    d.events.on('user.deleted', ({ userId }) => void io.in(`user:${userId}`).disconnectSockets(true)),
    d.events.on('session.revoked', ({ sessionId }) => void io.in(`sid:${sessionId}`).disconnectSockets(true)),
  ];

  d.presence.setLocalCounter(() => io.engine.clientsCount);
  d.presence.start((n) => void io.local.emit('online_users_count', n));
  const purge = setInterval(() => {
    void d.matching.purgeStale().catch(() => {});
    void d.matching.queueSize().then((n) => d.metrics.matchQueueSize.set(n)).catch(() => {});
  }, 60_000);
  purge.unref();

  return {
    io,
    async close() {
      clearInterval(purge);
      d.presence.stop();
      for (const off of offs) off();
      await io.close();
      subClient?.disconnect();
    },
  };
}
