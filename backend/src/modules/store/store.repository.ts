import { PackModel, VipPlanModel } from '../../infra/db/models/commerce.js';

export interface PackRecord {
  id: string;
  name: string;
  description: string;
  price: number;
  gems: number;
  popular: boolean;
  googlePayId?: string;
  applePayId?: string;
}

export interface VipPlanRecord {
  id: string;
  name: string;
  description: string;
  priceGems: number;
  durationDays: number;
  popular: boolean;
}

const toPack = (p: Awaited<ReturnType<typeof PackModel.findOne>> & object): PackRecord => ({
  id: p.id, name: p.name, description: p.description ?? '', price: p.price, gems: p.gems, popular: Boolean(p.popular),
  ...(p.googlePayId ? { googlePayId: p.googlePayId } : {}),
  ...(p.applePayId ? { applePayId: p.applePayId } : {}),
});

export class PackRepository {
  async list(): Promise<PackRecord[]> {
    return (await PackModel.find().sort({ price: 1 }).lean()).map((p) => toPack(p as never));
  }
  async findById(id: string): Promise<PackRecord | null> {
    const p = await PackModel.findOne({ id }).lean();
    return p ? toPack(p as never) : null;
  }
  /** Store-product lookup: matches our id or the Google/Apple product id configured for the pack. */
  async findByAnyId(key: string): Promise<PackRecord | null> {
    const p = await PackModel.findOne({ $or: [{ id: key }, { googlePayId: key }, { applePayId: key }] }).lean();
    return p ? toPack(p as never) : null;
  }
}

export class VipPlanRepository {
  async list(): Promise<VipPlanRecord[]> {
    return (await VipPlanModel.find().sort({ priceGems: 1 }).lean()).map((p) => ({
      id: p.id, name: p.name, description: p.description ?? '', priceGems: p.priceGems, durationDays: p.durationDays, popular: Boolean(p.popular),
    }));
  }
  async findById(id: string): Promise<VipPlanRecord | null> {
    return (await this.list()).find((p) => p.id === id) ?? null;
  }
}
