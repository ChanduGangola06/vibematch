import type { Cache } from '../../core/cache/index.js';
import type { AppEventBus } from '../../core/events/index.js';
import { ConflictError, NotFoundError } from '../../core/errors/index.js';
import { offsetMeta, toSkipLimit, type OffsetQuery } from '../../core/pagination/index.js';
import { PageModel, type PageDoc } from '../../infra/db/models/content.js';
import { sanitizePageHtml } from './html.js';

export interface PageDto {
  id: string;
  title: string;
  slug: string;
  content: string;
  showInFooter: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

const toDto = (p: PageDoc): PageDto => ({
  id: p.id, title: p.title, slug: p.slug, content: p.content ?? '', showInFooter: Boolean(p.showInFooter), isActive: Boolean(p.isActive),
  createdAt: (p.createdAt ?? new Date(0)).toISOString(), updatedAt: (p.updatedAt ?? new Date(0)).toISOString(),
});

export interface PageInput {
  title: string;
  slug: string;
  content?: string | undefined;
  showInFooter?: boolean | undefined;
  isActive?: boolean | undefined;
}

export class PageService {
  constructor(
    private readonly cache: Cache,
    private readonly events: AppEventBus,
  ) {}

  /** Footer links for the public site. */
  listPublic(): Promise<{ title: string; slug: string }[]> {
    return this.cache.wrap(
      'pages:footer',
      async () => (await PageModel.find({ isActive: true, showInFooter: true }, { title: 1, slug: 1 }).sort({ createdAt: 1 }).lean()).map((p) => ({ title: p.title, slug: p.slug })),
      { ttl: 120, tags: ['pages'] },
    );
  }

  async getPublic(slug: string): Promise<Pick<PageDto, 'title' | 'slug' | 'content' | 'updatedAt'>> {
    const page = await this.cache.wrap(
      `pages:slug:${slug}`,
      async () => {
        const p = await PageModel.findOne({ slug, isActive: true }).lean();
        return p ? { title: p.title, slug: p.slug, content: p.content ?? '', updatedAt: (p.updatedAt ?? new Date(0)).toISOString() } : null;
      },
      { ttl: 120, tags: ['pages'] },
    );
    if (!page) throw new NotFoundError('Page');
    return page;
  }

  async list(q: OffsetQuery & { search?: string | undefined }) {
    const filter = q.search ? { $or: [{ title: { $regex: escapeRegex(q.search), $options: 'i' } }, { slug: { $regex: escapeRegex(q.search), $options: 'i' } }] } : {};
    const { skip, limit } = toSkipLimit(q);
    const [rows, total] = await Promise.all([PageModel.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(), PageModel.countDocuments(filter)]);
    return { items: rows.map(toDto), page: offsetMeta(q, total) };
  }

  async create(input: PageInput): Promise<PageDto> {
    try {
      const p = await PageModel.create({ ...input, content: sanitizePageHtml(input.content ?? '') });
      this.events.emit('content.changed', { kind: 'pages' });
      return toDto(p.toObject());
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw new ConflictError('A page with this slug already exists', 'slug_taken');
      throw err;
    }
  }

  async update(id: string, patch: Partial<PageInput>): Promise<PageDto> {
    const $set = { ...patch, ...(patch.content !== undefined ? { content: sanitizePageHtml(patch.content) } : {}) };
    try {
      const p = await PageModel.findOneAndUpdate({ id }, { $set }, { returnDocument: 'after', runValidators: true }).lean();
      if (!p) throw new NotFoundError('Page');
      this.events.emit('content.changed', { kind: 'pages' });
      return toDto(p);
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw new ConflictError('A page with this slug already exists', 'slug_taken');
      throw err;
    }
  }

  async remove(id: string): Promise<void> {
    if ((await PageModel.deleteOne({ id })).deletedCount === 0) throw new NotFoundError('Page');
    this.events.emit('content.changed', { kind: 'pages' });
  }
}

export const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
