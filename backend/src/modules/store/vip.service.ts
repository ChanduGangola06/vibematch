import type { AppEventBus } from '../../core/events/index.js';
import { NotFoundError } from '../../core/errors/index.js';
import { newId } from '../../core/utils/id.js';
import { UserModel } from '../../infra/db/models/user.js';
import type { GemService } from '../ledger/gem.service.js';
import type { VipPlanRepository } from './store.repository.js';

export class VipService {
  constructor(
    private readonly plans: Pick<VipPlanRepository, 'findById'>,
    private readonly gems: GemService,
    private readonly events: AppEventBus,
  ) {}

  /**
   * Charge + extend in ONE transaction. Extension starts from the later of "now" and the current
   * expiry, so renewing early never loses remaining days. Done with a single pipeline update, so two
   * simultaneous subscriptions both extend (no lost update).
   */
  async subscribe(userId: string, planId: string): Promise<{ balance: number; vipExpiry: string }> {
    const plan = await this.plans.findById(planId);
    if (!plan) throw new NotFoundError('VIP plan');
    const subscriptionId = newId('sub');
    const ms = plan.durationDays * 86_400_000;

    const result = await this.gems.withTx(async (session) => {
      const debit = await this.gems.debit(userId, plan.priceGems, 'vip_subscribe', { type: 'vip', id: subscriptionId }, session);
      const updated = await UserModel.findOneAndUpdate(
        { id: userId },
        [{ $set: { vipExpiry: { $add: [{ $max: [{ $ifNull: ['$vipExpiry', '$$NOW'] }, '$$NOW'] }, ms] } } }],
        { returnDocument: 'after', updatePipeline: true, projection: { vipExpiry: 1 }, ...(session ? { session } : {}) },
      ).lean();
      return { balance: debit.balance, vipExpiry: updated!.vipExpiry!.toISOString() };
    });
    this.events.emit('vip.activated', { userId, planId, expiresAt: result.vipExpiry });
    return result;
  }
}
