import type { Cache } from '../../core/cache/index.js';
import { UserModel } from '../../infra/db/models/user.js';
import type { PublicUser } from '../users/user.schemas.js';
import { toPublicUser } from '../users/user.mapper.js';

export type DiscoverMode = 'demo_only' | 'real_only' | 'real_no_guest' | 'all';

/** Admin setting "who appears in the discover grid" — supplied by the settings module. */
export interface DiscoverConfig {
  mode(): Promise<DiscoverMode>;
}
export const defaultDiscoverConfig: DiscoverConfig = { mode: async () => 'demo_only' };

export type DiscoverUser = PublicUser & { videoUrl?: string };

const POOL_SIZE = 100;
const GRID_SIZE = 24;

const filterFor = (mode: DiscoverMode): Record<string, unknown> => {
  const base = { isBanned: { $ne: true }, role: { $ne: 'admin' } };
  switch (mode) {
    case 'demo_only': return { ...base, isDemo: true };
    case 'real_only': return { ...base, isDemo: { $ne: true } };
    case 'real_no_guest': return { ...base, isDemo: { $ne: true }, role: 'user' };
    case 'all': return base;
  }
};

/**
 * Discover grid. A candidate pool is cached briefly and each request samples from it in memory,
 * so a busy home page costs one query per TTL window instead of one per visitor.
 */
export class DiscoverService {
  constructor(
    private readonly config: DiscoverConfig,
    private readonly cache: Cache,
  ) {}

  async grid(excludeUserId?: string): Promise<DiscoverUser[]> {
    const mode = await this.config.mode();
    const pool = await this.cache.wrap<DiscoverUser[]>(
      `discover:pool:${mode}`,
      async () => {
        const docs = await UserModel.aggregate<Parameters<typeof toPublicUser>[0]>([
          { $match: filterFor(mode) },
          { $sample: { size: POOL_SIZE } },
        ]);
        return docs.map((u) => ({ ...toPublicUser(u), ...(u.isDemo && u.videoUrl ? { videoUrl: u.videoUrl } : {}) }));
      },
      { ttl: 30, tags: ['discover'] },
    );
    const candidates = pool.filter((u) => u.id !== excludeUserId);
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j]!, candidates[i]!];
    }
    return candidates.slice(0, GRID_SIZE);
  }
}
