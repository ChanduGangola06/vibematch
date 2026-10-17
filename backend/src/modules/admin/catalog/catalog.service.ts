import { randomBytes } from 'node:crypto';
import type { AppEventBus } from '../../../core/events/index.js';
import { BadRequestError, NotFoundError } from '../../../core/errors/index.js';
import { GiftModel, PackModel, VipPlanModel } from '../../../infra/db/models/commerce.js';
import { sniffImage, sniffSvg } from '../../../middleware/upload.js';
import type { StorageProvider } from '../../users/user.service.js';

export interface GiftAdminDto {
  id: string;
  name: string;
  price: number;
  image: string;
  createdAt: string;
}
const toGift = (g: { id: string; name: string; price: number; imagePath: string; createdAt?: Date | null }): GiftAdminDto => ({
  id: g.id, name: g.name, price: g.price, image: g.imagePath, createdAt: (g.createdAt ?? new Date(0)).toISOString(),
});

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'gift';
const LOCAL_GIFT = /^\/images\/(gift\/[\w.-]+)$/;

export class CatalogService {
  constructor(
    private readonly storage: StorageProvider,
    private readonly events: AppEventBus,
  ) {}

  // ---- gifts ----------------------------------------------------------------------------------
  async listGifts(): Promise<GiftAdminDto[]> {
    return (await GiftModel.find().sort({ createdAt: -1, _id: -1 }).lean()).map(toGift);
  }

  private async storeImage(name: string, file: Buffer | undefined): Promise<string> {
    if (!file) throw new BadRequestError('An image is required (field "giftImage": png, jpeg, webp, gif or a clean svg, max 512 KB)');
    const kind = sniffImage(file);
    const svg = !kind && sniffSvg(file);
    if (!kind && !svg) throw new BadRequestError('File content is not a supported image');
    const ext = kind ? kind.ext : 'svg';
    const mime = kind ? kind.mime : 'image/svg+xml';
    const key = `gift/${slug(name)}-${randomBytes(5).toString('hex')}.${ext}`;
    return (await (await this.storage.get()).put(key, file, mime)).url;
  }

  private async dropImage(path: string): Promise<void> {
    const m = LOCAL_GIFT.exec(path);
    if (!m) return; // CDN-hosted files are left in place
    try {
      await (await this.storage.get()).delete(m[1]!);
    } catch {
      /* orphaned file is harmless */
    }
  }

  async createGift(name: string, price: number, file: Buffer | undefined): Promise<GiftAdminDto> {
    const imagePath = await this.storeImage(name, file);
    const g = await GiftModel.create({ name, price, imagePath });
    this.events.emit('content.changed', { kind: 'gifts' });
    return toGift(g.toObject());
  }

  async updateGift(id: string, patch: { name?: string | undefined; price?: number | undefined }, file?: Buffer): Promise<GiftAdminDto> {
    const g = await GiftModel.findOne({ id });
    if (!g) throw new NotFoundError('Gift');
    if (patch.name !== undefined) g.name = patch.name;
    if (patch.price !== undefined) g.price = patch.price;
    if (file) {
      const old = g.imagePath;
      g.imagePath = await this.storeImage(g.name, file);
      await this.dropImage(old);
    }
    await g.save();
    this.events.emit('content.changed', { kind: 'gifts' });
    return toGift(g.toObject());
  }

  async deleteGift(id: string): Promise<void> {
    const g = await GiftModel.findOneAndDelete({ id }).lean();
    if (!g) throw new NotFoundError('Gift');
    await this.dropImage(g.imagePath);
    this.events.emit('content.changed', { kind: 'gifts' });
  }

  // ---- packs ----------------------------------------------------------------------------------
  async createPack(input: Record<string, unknown>) {
    const p = await PackModel.create(input);
    this.events.emit('content.changed', { kind: 'packs' });
    return p.toObject();
  }
  async updatePack(id: string, patch: Record<string, unknown>) {
    const p = await PackModel.findOneAndUpdate({ id }, { $set: patch }, { returnDocument: 'after', runValidators: true }).lean();
    if (!p) throw new NotFoundError('Pack');
    this.events.emit('content.changed', { kind: 'packs' });
    return p;
  }
  async deletePack(id: string) {
    if ((await PackModel.deleteOne({ id })).deletedCount === 0) throw new NotFoundError('Pack');
    this.events.emit('content.changed', { kind: 'packs' });
  }

  // ---- vip plans ------------------------------------------------------------------------------
  async createPlan(input: Record<string, unknown>) {
    const p = await VipPlanModel.create(input);
    this.events.emit('content.changed', { kind: 'vip' });
    return p.toObject();
  }
  async updatePlan(id: string, patch: Record<string, unknown>) {
    const p = await VipPlanModel.findOneAndUpdate({ id }, { $set: patch }, { returnDocument: 'after', runValidators: true }).lean();
    if (!p) throw new NotFoundError('VIP plan');
    this.events.emit('content.changed', { kind: 'vip' });
    return p;
  }
  async deletePlan(id: string) {
    if ((await VipPlanModel.deleteOne({ id })).deletedCount === 0) throw new NotFoundError('VIP plan');
    this.events.emit('content.changed', { kind: 'vip' });
  }
}
