import type { UserStatus, UserStatusPort } from '../../middleware/authenticate.js';
import { UserModel } from './models/user.js';

export class MongoUserStatus implements UserStatusPort {
  async get(userId: string): Promise<UserStatus | null> {
    const u = await UserModel.findOne({ id: userId }, { role: 1, isBanned: 1, username: 1 }).lean();
    return u ? { role: u.role ?? 'user', isBanned: Boolean(u.isBanned), username: u.username } : null;
  }
}
