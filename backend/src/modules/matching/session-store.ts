/** An active pairing, stored once per participant (so either side can find its peer). */
export interface MatchSession {
  socketId: string;
  userId: string;
  partnerSocketId: string;
  partnerUserId: string;
  /** Demo partners are server-side personas: no WebRTC peer exists. */
  isDemo: boolean;
  startedAt: number;
  /** Snapshot of the partner, kept for the history entry written when the call ends. */
  partner?: { name: string; username: string; avatar: string; country: string; age?: number };
}

export interface MatchSessionStore {
  get(socketId: string): Promise<MatchSession | undefined>;
  set(session: MatchSession): Promise<void>;
  delete(socketId: string): Promise<MatchSession | undefined>;
}

export class MemorySessionStore implements MatchSessionStore {
  private readonly sessions = new Map<string, MatchSession>();
  async get(socketId: string) {
    return this.sessions.get(socketId);
  }
  async set(s: MatchSession) {
    this.sessions.set(s.socketId, s);
  }
  async delete(socketId: string) {
    const s = this.sessions.get(socketId);
    this.sessions.delete(socketId);
    return s;
  }
  get size() {
    return this.sessions.size;
  }
}

export interface RedisSessionLike {
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  getdel?(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
}

const MAX_CALL_SECONDS = 4 * 3600;

/** Shared across instances: the two peers of a call may be connected to different servers. */
export class RedisSessionStore implements MatchSessionStore {
  constructor(private readonly redis: RedisSessionLike, private readonly prefix = 'vm:sess:') {}

  async get(socketId: string) {
    const raw = await this.redis.get(this.prefix + socketId);
    return raw ? (JSON.parse(raw) as MatchSession) : undefined;
  }
  async set(s: MatchSession) {
    await this.redis.set(this.prefix + s.socketId, JSON.stringify(s), 'EX', MAX_CALL_SECONDS);
  }
  async delete(socketId: string) {
    const s = await this.get(socketId);
    await this.redis.del(this.prefix + socketId);
    return s;
  }
}
