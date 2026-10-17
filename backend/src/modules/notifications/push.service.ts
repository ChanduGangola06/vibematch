import type { Logger } from '../../core/logger/index.js';
import { UserModel } from '../../infra/db/models/user.js';
import { NullPushAdapter, type PushMessage, type PushPort } from '../../infra/push/index.js';

/** Resolves the push adapter lazily — credentials come from admin settings, which can change at runtime. */
export interface PushProvider {
  get(): Promise<PushPort>;
}

export const nullPushProvider: PushProvider = { get: async () => new NullPushAdapter() };

const MAX_TOKENS_PER_USER = 10;

export class PushService {
  constructor(
    private readonly provider: PushProvider,
    private readonly log: Logger,
  ) {}

  async registerToken(userId: string, token: string): Promise<void> {
    // Move the token to this user (a device that changes account must not keep receiving the old user's pushes).
    await UserModel.updateMany({ id: { $ne: userId }, fcmTokens: token }, { $pull: { fcmTokens: token } });
    await UserModel.updateOne({ id: userId }, { $addToSet: { fcmTokens: token } });
    const u = await UserModel.findOne({ id: userId }, { fcmTokens: 1 }).lean();
    if (u && u.fcmTokens.length > MAX_TOKENS_PER_USER) {
      await UserModel.updateOne({ id: userId }, { $set: { fcmTokens: u.fcmTokens.slice(-MAX_TOKENS_PER_USER) } });
    }
  }

  async removeToken(userId: string, token: string): Promise<void> {
    await UserModel.updateOne({ id: userId }, { $pull: { fcmTokens: token } });
  }

  /** Best effort: push failures never affect the caller. Invalid tokens are pruned. */
  async sendToUser(userId: string, msg: PushMessage): Promise<void> {
    try {
      const user = await UserModel.findOne({ id: userId }, { fcmTokens: 1 }).lean();
      if (!user?.fcmTokens?.length) return;
      const push = await this.provider.get();
      const res = await push.send(user.fcmTokens, msg);
      if (res.invalidTokens.length) {
        await UserModel.updateOne({ id: userId }, { $pull: { fcmTokens: { $in: res.invalidTokens } } });
      }
    } catch (err) {
      this.log.warn({ err, userId }, 'push failed');
    }
  }
}
