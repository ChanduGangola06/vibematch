import type { Cache } from '../../core/cache/index.js';
import type { AppEventBus } from '../../core/events/index.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../core/errors/index.js';
import { LanguageModel } from '../../infra/db/models/content.js';

export interface LanguageSummary {
  code: string;
  name: string;
  flag: string;
  rtl: boolean;
}

/** MongoDB field names cannot safely contain "." — keep readable keys by swapping it for a full-width dot at rest. */
const DOT = '．';
const enc = (o: unknown): unknown => (o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k.replaceAll('.', DOT), enc(v)])) : o);
const dec = (o: unknown): unknown => (o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k.replaceAll(DOT, '.'), dec(v)])) : o);

export type Translations = Record<string, string>;
export const DEFAULT_LANGUAGE = 'en';

export class LanguageService {
  constructor(
    private readonly cache: Cache,
    private readonly events: AppEventBus,
  ) {}

  list(): Promise<LanguageSummary[]> {
    return this.cache.wrap(
      'languages:list',
      async () => (await LanguageModel.find({}, { translations: 0 }).sort({ code: 1 }).lean()).map((l) => ({ code: l.code, name: l.name, flag: l.flag ?? '', rtl: Boolean(l.rtl) })),
      { ttl: 300, tags: ['languages'] },
    );
  }

  get(code: string): Promise<LanguageSummary & { translations: Translations }> {
    return this.cache.wrap(
      `languages:${code}`,
      async () => {
        const l = await LanguageModel.findOne({ code }).lean();
        if (!l) return null as never;
        return { code: l.code, name: l.name, flag: l.flag ?? '', rtl: Boolean(l.rtl), translations: dec(l.translations ?? {}) as Translations };
      },
      { ttl: 300, tags: ['languages'] },
    ).then((v) => {
      if (!v) throw new NotFoundError('Language');
      return v;
    });
  }

  async create(input: LanguageSummary): Promise<LanguageSummary> {
    try {
      await LanguageModel.create({ ...input, translations: {} });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw new ConflictError('This language already exists', 'language_exists');
      throw err;
    }
    this.changed();
    return input;
  }

  async update(code: string, patch: Partial<Omit<LanguageSummary, 'code'>> & { translations?: Translations | undefined }): Promise<void> {
    const { translations, ...rest } = patch;
    const $set: Record<string, unknown> = { ...rest };
    if (translations) $set.translations = enc(translations);
    const res = await LanguageModel.updateOne({ code }, { $set });
    if (res.matchedCount === 0) throw new NotFoundError('Language');
    this.changed();
  }

  async remove(code: string): Promise<void> {
    if (code === DEFAULT_LANGUAGE) throw new BadRequestError('The default language cannot be deleted');
    if ((await LanguageModel.deleteOne({ code })).deletedCount === 0) throw new NotFoundError('Language');
    this.changed();
  }

  private changed() {
    this.events.emit('content.changed', { kind: 'languages' });
  }
}
