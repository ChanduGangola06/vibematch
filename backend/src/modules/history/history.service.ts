import { keysetPage, type CursorCodec, type Page } from '../../core/pagination/index.js';
import { MatchModel, type MatchDoc } from '../../infra/db/models/social.js';
import type { SocialRepository } from '../social/social.repository.js';
import type { UserRepository } from '../users/user.repository.js';

export interface HistoryEntryDto {
  id: string;
  type: 'video_chat' | 'view';
  durationSec: number;
  createdAt: string;
  partner: {
    id: string; name: string; username: string; avatar: string; country: string; age?: number;
    isFollowing: boolean; isMutualFollow: boolean; exists: boolean;
  };
}

export class HistoryService {
  constructor(
    private readonly users: UserRepository,
    private readonly socialRepo: SocialRepository,
    private readonly cursor: CursorCodec,
  ) {}

  /**
   * `video_chat`: people I talked to. `view`: people who looked at my profile.
   * Partners and relationships are fetched in batches (3 queries per page, not 2 per row as in v1).
   */
  async list(me: string, type: 'video_chat' | 'view', q: { limit: number; cursor?: string | undefined }): Promise<Page<HistoryEntryDto>> {
    const page = await keysetPage<MatchDoc>(MatchModel, this.cursor, { filter: { userId: me, type }, ...q });
    const ids = [...new Set(page.items.map((m) => m.partnerId))];
    const [partners, rel] = await Promise.all([this.users.findByIds(ids), this.socialRepo.relationships(me, ids)]);
    const byId = new Map(partners.map((p) => [p.id, p]));

    const items = page.items.map((m): HistoryEntryDto => {
      const live = byId.get(m.partnerId);
      const snap = m.partner;
      const r = rel.get(m.partnerId);
      const age = live?.age ?? snap?.age;
      return {
        id: m.id,
        type: m.type,
        durationSec: m.durationSec ?? 0,
        createdAt: (m.createdAt ?? new Date(0)).toISOString(),
        partner: {
          id: m.partnerId,
          name: live?.name || snap?.name || 'Deleted user',
          username: live?.username ?? snap?.username ?? '',
          avatar: live?.avatar || snap?.avatar || '',
          country: live?.country || snap?.country || '',
          ...(age != null ? { age } : {}),
          isFollowing: r?.isFollowing ?? false,
          isMutualFollow: Boolean(r?.isFollowing && r.followsMe),
          exists: Boolean(live),
        },
      };
    });
    return { items, page: page.page };
  }
}
