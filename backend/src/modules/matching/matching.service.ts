import type { AppEventBus } from '../../core/events/index.js';
import { ForbiddenError, NotFoundError } from '../../core/errors/index.js';
import type { Logger } from '../../core/logger/index.js';
import { MatchModel } from '../../infra/db/models/social.js';
import { UserModel } from '../../infra/db/models/user.js';
import { isVipNow } from '../users/user.mapper.js';
import type { UserRecord, UserRepository } from '../users/user.repository.js';
import { defaultRules, type GenderPref, type MatchQueue, type MatchRule, type QueueEntry } from './queue.js';
import type { MatchSession, MatchSessionStore } from './session-store.js';

/** How the matching engine talks to connected sockets (implemented over Socket.IO, faked in tests). */
export interface PeerNotifier {
  emit(socketId: string, event: string, payload: unknown): void;
}

export interface JoinRequest {
  socketId: string;
  userId: string;
  gender?: GenderPref | undefined;
  country?: string | undefined;
  superMatch?: boolean | undefined;
}

export interface AppliedFilters {
  gender: GenderPref;
  country: string;
  superMatch: boolean;
  /** False when the caller asked for filters but is not VIP: they are ignored, not an error. */
  filtersIgnored: boolean;
}

export interface JoinResult {
  status: 'matched' | 'waiting';
  applied: AppliedFilters;
}

export interface MatchingConfig {
  /** Delay before a demo persona is offered when nobody real is waiting. */
  demoDelayMs: number;
  /** Queue entries older than this are considered zombies and dropped by `purge`. */
  staleAfterMs: number;
}

export const defaultMatchingConfig: MatchingConfig = { demoDelayMs: 1200, staleAfterMs: 15 * 60_000 };

export interface PeerView {
  id: string;
  name: string;
  username: string;
  avatar: string;
  gender: string;
  country: string;
  countryCode: string;
  age?: number;
  likesCount: number;
  isVip: boolean;
}

const toPeer = (u: UserRecord): PeerView => ({
  id: u.id, name: u.name ?? '', username: u.username, avatar: u.avatar ?? '', gender: u.gender ?? '',
  country: u.country ?? '', countryCode: u.countryCode ?? '', ...(u.age != null ? { age: u.age } : {}),
  likesCount: u.likesCount ?? 0, isVip: isVipNow(u),
});

const snapshot = (u: UserRecord) => ({
  name: u.name ?? '', username: u.username, avatar: u.avatar ?? '', country: u.country ?? '', ...(u.age != null ? { age: u.age } : {}),
});

const ALL_COUNTRIES = new Set(['', 'all', 'all countries']);

/**
 * Mediator for random video chat: the only component that knows queue, sessions, users,
 * history and the notifier. Handlers (sockets) and tests talk to it, never to the pieces.
 */
export class MatchingService {
  private readonly demoTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly queue: MatchQueue,
    private readonly sessions: MatchSessionStore,
    private readonly users: UserRepository,
    private readonly notifier: PeerNotifier,
    private readonly events: AppEventBus,
    private readonly log: Logger,
    private readonly config: MatchingConfig = defaultMatchingConfig,
    private readonly rules: MatchRule = defaultRules,
    private readonly now: () => number = Date.now,
  ) {}

  async join(req: JoinRequest): Promise<JoinResult> {
    await this.leave(req.socketId);
    await this.end(req.socketId, 'rejoined');

    const user = await this.users.findById(req.userId);
    if (!user) throw new NotFoundError('Account');
    if (user.isBanned) throw new ForbiddenError('This account has been suspended', 'account_banned');

    // VIP gate is enforced HERE (v1 only hid the buttons in the UI).
    const vip = isVipNow(user);
    const wantsFilters = (req.gender && req.gender !== 'both') || !ALL_COUNTRIES.has((req.country ?? '').trim().toLowerCase()) || Boolean(req.superMatch);
    const applied: AppliedFilters = vip
      ? {
          gender: req.gender ?? 'both',
          country: ALL_COUNTRIES.has((req.country ?? '').trim().toLowerCase()) ? '' : (req.country ?? '').trim(),
          superMatch: Boolean(req.superMatch),
          filtersIgnored: false,
        }
      : { gender: 'both', country: '', superMatch: false, filtersIgnored: Boolean(wantsFilters) };

    const entry: QueueEntry = {
      socketId: req.socketId, userId: user.id, gender: (user.gender ?? '') as QueueEntry['gender'],
      country: user.country ?? '', countryCode: user.countryCode ?? '',
      prefGender: applied.gender, prefCountry: applied.country, superMatch: applied.superMatch, joinedAt: this.now(),
    };

    const partnerEntry = await this.queue.matchOrEnqueue(entry, this.rules);
    if (partnerEntry) {
      const partner = await this.users.findById(partnerEntry.userId);
      if (partner && !partner.isBanned) {
        await this.startRealSession(user, entry, partner, partnerEntry);
        return { status: 'matched', applied };
      }
      // the waiting user vanished (deleted / banned meanwhile): wait for someone else
      await this.queue.matchOrEnqueue(entry, this.rules);
    }

    if (!applied.superMatch) this.scheduleDemo(entry);
    return { status: 'waiting', applied };
  }

  async leave(socketId: string): Promise<void> {
    this.clearTimer(socketId);
    await this.queue.remove(socketId);
  }

  /** User pressed "next"/"stop" or the socket dropped. Safe to call repeatedly. */
  async end(socketId: string, reason: 'skipped' | 'disconnected' | 'rejoined' | 'ended' = 'skipped'): Promise<void> {
    this.clearTimer(socketId);
    const mine = await this.sessions.delete(socketId);
    if (!mine) return;

    const durationSec = Math.max(0, Math.round((this.now() - mine.startedAt) / 1000));
    let theirs: MatchSession | undefined;
    if (!mine.isDemo) {
      theirs = await this.sessions.delete(mine.partnerSocketId);
      this.notifier.emit(mine.partnerSocketId, 'partner_skipped', { reason });
    }
    // both participants get a history entry (a demo partner has no history of its own)
    await this.recordHistory(mine, durationSec);
    if (theirs) await this.recordHistory(theirs, durationSec);
    this.events.emit('match.ended', { userIds: [mine.userId, mine.partnerUserId], durationSec });
  }

  async disconnect(socketId: string): Promise<void> {
    await this.leave(socketId);
    await this.end(socketId, 'disconnected');
  }

  /** Who is this socket talking to right now? (signalling, in-call chat and gifts are restricted to this peer) */
  session(socketId: string): Promise<MatchSession | undefined> {
    return this.sessions.get(socketId);
  }

  queueSize(): Promise<number> {
    return this.queue.size();
  }

  purgeStale(): Promise<number> {
    return this.queue.purge(this.config.staleAfterMs, this.now());
  }

  // ---------------------------------------------------------------------------------------------
  private async startRealSession(me: UserRecord, mine: QueueEntry, partner: UserRecord, theirs: QueueEntry): Promise<void> {
    this.clearTimer(theirs.socketId);
    const startedAt = this.now();
    const a: MatchSession = { socketId: mine.socketId, userId: me.id, partnerSocketId: theirs.socketId, partnerUserId: partner.id, isDemo: false, startedAt, partner: snapshot(partner) };
    const b: MatchSession = { socketId: theirs.socketId, userId: partner.id, partnerSocketId: mine.socketId, partnerUserId: me.id, isDemo: false, startedAt, partner: snapshot(me) };
    await Promise.all([this.sessions.set(a), this.sessions.set(b)]);
    // The newcomer creates the WebRTC offer (initiator); the waiting user answers.
    this.notifier.emit(mine.socketId, 'match_found', { partner: toPeer(partner), peerId: theirs.socketId, initiator: true });
    this.notifier.emit(theirs.socketId, 'match_found', { partner: toPeer(me), peerId: mine.socketId, initiator: false });
  }

  private scheduleDemo(entry: QueueEntry): void {
    this.clearTimer(entry.socketId);
    const timer = setTimeout(() => {
      this.demoTimers.delete(entry.socketId);
      void this.offerDemo(entry).catch((err) => this.log.warn({ err }, 'demo match failed'));
    }, this.config.demoDelayMs);
    timer.unref();
    this.demoTimers.set(entry.socketId, timer);
  }

  private async offerDemo(entry: QueueEntry): Promise<void> {
    // Still waiting? (If someone real matched meanwhile, remove() is false and we do nothing.)
    if (!(await this.queue.remove(entry.socketId))) return;
    const demo = await this.pickDemo(entry);
    if (!demo) {
      await this.queue.matchOrEnqueue(entry, this.rules); // nobody to offer: keep waiting
      return;
    }
    const startedAt = this.now();
    await this.sessions.set({
      socketId: entry.socketId, userId: entry.userId, partnerSocketId: `demo_${demo.id}`, partnerUserId: demo.id,
      isDemo: true, startedAt, partner: snapshot(demo),
    });
    const defaultVideo = demo.gender === 'male' ? '/videos/demo-male.mp4' : '/videos/demo-female.mp4';
    this.notifier.emit(entry.socketId, 'match_found', {
      partner: toPeer(demo), peerId: `demo_${demo.id}`, initiator: true, isDemo: true, videoUrl: demo.videoUrl || defaultVideo,
    });
  }

  /** Same relaxation ladder as v1: strict → gender only → any online demo → any demo. */
  private async pickDemo(entry: QueueEntry): Promise<UserRecord | null> {
    const base = { isDemo: true, isBanned: { $ne: true } };
    const byGender = entry.prefGender !== 'both' ? { gender: entry.prefGender } : {};
    const byCountry = entry.prefCountry ? { $or: [{ country: entry.prefCountry }, { countryCode: entry.prefCountry.toUpperCase() }] } : {};
    const tiers: Record<string, unknown>[] = [
      { ...base, isOnline: true, ...byGender, ...byCountry },
      { ...base, isOnline: true, ...byGender },
      { ...base, isOnline: true },
      base,
    ];
    for (const match of tiers) {
      const [doc] = await UserModel.aggregate<UserRecord>([{ $match: match }, { $sample: { size: 1 } }]);
      if (doc) return doc;
    }
    return null;
  }

  private async recordHistory(s: MatchSession, durationSec: number): Promise<void> {
    if (durationSec < 1) return;
    try {
      await MatchModel.create({ userId: s.userId, partnerId: s.partnerUserId, type: 'video_chat', durationSec, partner: s.partner ?? {} });
    } catch (err) {
      this.log.warn({ err }, 'could not record match history');
    }
  }

  private clearTimer(socketId: string): void {
    const t = this.demoTimers.get(socketId);
    if (t) clearTimeout(t);
    this.demoTimers.delete(socketId);
  }
}
