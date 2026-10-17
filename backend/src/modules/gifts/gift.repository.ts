import { GiftModel } from '../../infra/db/models/commerce.js';

export interface GiftRecord {
  id: string;
  name: string;
  price: number;
  imagePath: string;
}

const pick = (g: GiftRecord): GiftRecord => ({ id: g.id, name: g.name, price: g.price, imagePath: g.imagePath });

export class GiftRepository {
  async list(): Promise<GiftRecord[]> {
    return (await GiftModel.find().sort({ price: 1, createdAt: -1 }).lean()).map(pick);
  }
  async findById(id: string): Promise<GiftRecord | null> {
    const g = await GiftModel.findOne({ id }).lean();
    return g ? pick(g) : null;
  }
}
