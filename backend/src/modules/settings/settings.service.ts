import type { Cache } from '../../core/cache/index.js';
import { NotFoundError } from '../../core/errors/index.js';
import type { AppEventBus } from '../../core/events/index.js';
import { SecretBox, isMasked, maskSecret } from '../../core/security/crypto.js';
import { SettingModel, SettingRevisionModel } from '../../infra/db/models/content.js';
import { GROUPS, GROUP_NAMES, type GroupData, type GroupName } from './settings.groups.js';

type Plain = Record<string, unknown>;

const isPlainObject = (v: unknown): v is Plain => typeof v === 'object' && v !== null && !Array.isArray(v);
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export interface UpdateResult {
  changed: string[];
  version: number;
}

/**
 * Typed, grouped, cached application settings.
 *  - writes go through the group's strict schema: unknown keys are rejected (no mass assignment)
 *  - secret fields are AES-256-GCM encrypted at rest and only ever returned masked (`••••1234`)
 *  - sending the masked value (or omitting the field) keeps the stored secret; `""` clears it
 *  - every change keeps a revision (secrets stay encrypted in it) and invalidates caches
 */
export class SettingsService {
  constructor(
    private readonly cache: Cache,
    private readonly box: SecretBox | undefined,
    private readonly events: AppEventBus,
  ) {}

  private tag(group: string) {
    return `settings:${group}`;
  }

  /** Raw stored document (secrets still encrypted). Cached; never exposes decrypted secrets to the cache. */
  private async stored(group: GroupName): Promise<{ data: Plain; version: number }> {
    const doc = await this.cache.wrap(
      `settings:${group}:doc`,
      async () => {
        const row = await SettingModel.findOne({ group }).lean();
        return { data: (row?.data ?? {}) as Plain, version: row?.version ?? 0 };
      },
      { ttl: 60, tags: [this.tag(group)] },
    );
    return doc;
  }

  private encrypt(v: string): string {
    return this.box && v ? this.box.encrypt(v) : v;
  }
  private decrypt(v: unknown): string {
    if (typeof v !== 'string' || v === '') return '';
    return SecretBox.isEncrypted(v) && this.box ? this.box.decrypt(v) : v; // legacy plaintext values still readable
  }

  /** Fully populated settings of a group, secrets decrypted — for server-side use only. */
  async get<G extends GroupName>(group: G): Promise<GroupData<G>> {
    const def = GROUPS[group];
    const { data } = await this.stored(group);
    const out: Plain = { ...def.defaults };
    for (const [k, v] of Object.entries(data)) {
      if (!(k in def.schema.shape)) continue; // fields removed from the schema are ignored
      out[k] = (def.secrets as readonly string[]).includes(k) ? this.decrypt(v) : isPlainObject(v) && isPlainObject(out[k]) ? { ...(out[k] as Plain), ...v } : v;
    }
    return out as GroupData<G>;
  }

  /** What an admin may see: secrets masked. */
  async getMasked(group: GroupName): Promise<Plain & { _version: number }> {
    const def = GROUPS[group];
    const full = (await this.get(group)) as Plain;
    const { version } = await this.stored(group);
    const out: Plain = { ...full };
    for (const s of def.secrets) out[s] = maskSecret(full[s] as string);
    return { ...out, _version: version };
  }

  /** The anonymous-safe subset used by the web bootstrap and the mobile `/init` call. */
  async publicBundle(): Promise<Record<string, Plain>> {
    const out: Record<string, Plain> = {};
    for (const name of GROUP_NAMES) {
      const def = GROUPS[name];
      if (def.publicFields.length === 0) continue;
      const data = (await this.get(name)) as Plain;
      out[name] = Object.fromEntries(def.publicFields.map((f) => [f, data[f]]));
    }
    return out;
  }

  async update(group: GroupName, input: unknown, by: string): Promise<UpdateResult> {
    const def = GROUPS[group];
    const patch = def.schema.partial().strict().parse(input) as Plain;
    const before = await this.get(group);
    const { data: stored } = await this.stored(group);

    const next: Plain = { ...stored };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if ((def.secrets as readonly string[]).includes(key)) {
        if (isMasked(value)) continue; // the form echoed the masked value back: keep the secret
        next[key] = this.encrypt(String(value));
      } else if (isPlainObject(value) && isPlainObject(next[key])) {
        next[key] = { ...(next[key] as Plain), ...value }; // nested groups (mobile.android …) merge
      } else {
        next[key] = value;
      }
    }

    const row = await SettingModel.findOneAndUpdate(
      { group },
      { $set: { data: next, updatedBy: by }, $inc: { version: 1 } },
      { upsert: true, returnDocument: 'after' },
    ).lean();
    await SettingRevisionModel.create({ group, data: next, version: row!.version, by });
    await this.cache.invalidateTag(this.tag(group));
    this.events.emit('settings.changed', { group });

    const after = (await this.get(group)) as Plain;
    const changed = Object.keys(patch).filter((k) => !sameJson((before as Plain)[k], after[k]));
    return { changed, version: row!.version };
  }

  async revisions(group: GroupName, limit = 20) {
    const rows = await SettingRevisionModel.find({ group }).sort({ createdAt: -1, version: -1 }).limit(Math.min(limit, 50)).lean();
    return rows.map((r) => ({ version: r.version, by: r.by ?? '', createdAt: (r.createdAt ?? new Date(0)).toISOString() }));
  }

  /** Restores an earlier revision as a *new* revision (history stays append-only). */
  async restore(group: GroupName, version: number, by: string): Promise<UpdateResult> {
    const rev = await SettingRevisionModel.findOne({ group, version }).lean();
    if (!rev) throw new NotFoundError('Settings revision');
    const row = await SettingModel.findOneAndUpdate(
      { group },
      { $set: { data: rev.data, updatedBy: by }, $inc: { version: 1 } },
      { upsert: true, returnDocument: 'after' },
    ).lean();
    await SettingRevisionModel.create({ group, data: rev.data, version: row!.version, by });
    await this.cache.invalidateTag(this.tag(group));
    this.events.emit('settings.changed', { group });
    return { changed: ['*'], version: row!.version };
  }
}
