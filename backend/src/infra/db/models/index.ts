export * from './user.js';
export * from './auth.js';
export * from './social.js';
export * from './commerce.js';
export * from './content.js';

import { ApiKeyModel, AuthChallengeModel, AuthCredentialModel, IdempotencyModel, RefreshTokenModel } from './auth.js';
import { GemLedgerModel, GiftModel, PackModel, PurchaseModel, VipPlanModel } from './commerce.js';
import { AuditLogModel, LanguageModel, PageModel, SettingModel, SettingRevisionModel } from './content.js';
import { ContactMessageModel, ConversationModel, FollowModel, LikeModel, MatchModel, MessageModel, NotificationModel, ReportModel } from './social.js';
import { UserModel } from './user.js';

export const allModels = [
  UserModel, RefreshTokenModel, AuthCredentialModel, AuthChallengeModel, ApiKeyModel, IdempotencyModel,
  FollowModel, LikeModel, MatchModel, NotificationModel, MessageModel, ConversationModel, ReportModel, ContactMessageModel,
  GiftModel, PackModel, VipPlanModel, PurchaseModel, GemLedgerModel,
  PageModel, LanguageModel, SettingModel, SettingRevisionModel, AuditLogModel,
] as const;

/** Creates every declared index (run on deploy when MONGO_AUTO_INDEX=false). */
export async function syncIndexes(): Promise<void> {
  for (const m of allModels) await m.syncIndexes();
}
