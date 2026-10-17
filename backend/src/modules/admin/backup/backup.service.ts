import type { Model } from 'mongoose';
import { BadRequestError } from '../../../core/errors/index.js';
import { GemLedgerModel, GiftModel, PackModel, PurchaseModel, VipPlanModel } from '../../../infra/db/models/commerce.js';
import { LanguageModel, PageModel, SettingModel } from '../../../infra/db/models/content.js';
import {
  ContactMessageModel, ConversationModel, FollowModel, LikeModel, MatchModel, MessageModel, NotificationModel, ReportModel,
} from '../../../infra/db/models/social.js';
import { UserModel } from '../../../infra/db/models/user.js';
import { GROUPS, isGroupName } from '../../settings/settings.groups.js';

/** Collections included in a backup. Tokens, API keys, passkeys, idempotency rows and the audit log are deliberately NOT. */
const COLLECTIONS = {
  users: UserModel, follows: FollowModel, likes: LikeModel, matches: MatchModel, messages: MessageModel, conversations: ConversationModel,
  notifications: NotificationModel, reports: ReportModel, contactMessages: ContactMessageModel, gifts: GiftModel, packs: PackModel,
  vipPlans: VipPlanModel, pages: PageModel, languages: LanguageModel, settings: SettingModel, purchases: PurchaseModel, gemLedger: GemLedgerModel,
} as const satisfies Record<string, Model<any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
export type BackupCollection = keyof typeof COLLECTIONS;
// The collections are heterogeneous; the backup code only needs the generic Model surface.
const model = (name: BackupCollection) => COLLECTIONS[name] as unknown as Model<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export const BACKUP_COLLECTIONS = Object.keys(COLLECTIONS) as BackupCollection[];

const FORMAT_VERSION = 2;
const USER_PRIVATE = ['fcmTokens', 'failedLogins', 'lockedUntil'] as const;

export interface BackupHeader {
  _meta: { format: 'vibematch-backup'; version: number; createdAt: string; includeSecrets: boolean };
}

export interface RestoreReport {
  mode: 'dry-run' | 'merge' | 'replace';
  applied: boolean;
  collections: Record<string, { lines: number; valid: number; invalid: number; written: number }>;
  errors: { line: number; collection?: string | undefined; message: string }[];
}

type Plain = Record<string, unknown>;

export class BackupService {
  /** Async generator of NDJSON-ready objects: header first, then one `{c, d}` line per document. */
  async *export(includeSecrets: boolean): AsyncGenerator<Plain> {
    yield { _meta: { format: 'vibematch-backup', version: FORMAT_VERSION, createdAt: new Date().toISOString(), includeSecrets } } satisfies BackupHeader;
    for (const name of BACKUP_COLLECTIONS) {
      let q = model(name).find({});
      if (name === 'users' && includeSecrets) q = q.select('+passwordHash');
      for await (const doc of q.lean().cursor() as AsyncIterable<Plain>) {
        yield { c: name, d: this.scrub(name, doc, includeSecrets) };
      }
    }
  }

  private scrub(name: BackupCollection, doc: Plain, includeSecrets: boolean): Plain {
    if (name === 'users') {
      const out = { ...doc };
      for (const k of USER_PRIVATE) delete out[k];
      if (!includeSecrets) delete out.passwordHash;
      return out;
    }
    if (name === 'settings' && !includeSecrets && typeof doc.group === 'string' && isGroupName(doc.group)) {
      const data = { ...((doc.data as Plain | undefined) ?? {}) };
      for (const s of GROUPS[doc.group].secrets) delete data[s];
      return { ...doc, data };
    }
    return doc;
  }

  /**
   * Validates every line against the Mongoose schemas (unknown fields are dropped, types are cast, required
   * fields are enforced) and — only when `apply` — writes in batches. Dry-run is the default at the route.
   */
  async restore(file: Buffer, opts: { mode: 'dry-run' | 'merge' | 'replace' }): Promise<RestoreReport> {
    const apply = opts.mode !== 'dry-run';
    const report: RestoreReport = { mode: opts.mode, applied: false, collections: {}, errors: [] };
    const err = (line: number, message: string, collection?: string) => {
      if (report.errors.length < 50) report.errors.push({ line, collection, message });
    };

    const docsByCollection = new Map<BackupCollection, Plain[]>();
    const lines = file.toString('utf8').split('\n');
    let sawHeader = false;

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i]!.trim();
      if (!raw) continue;
      let row: { c?: string; d?: unknown; _meta?: BackupHeader['_meta'] };
      try {
        row = JSON.parse(raw);
      } catch {
        err(i + 1, 'Not valid JSON');
        continue;
      }
      if (row._meta) {
        if (row._meta.format !== 'vibematch-backup' || row._meta.version > FORMAT_VERSION) throw new BadRequestError('Unsupported backup format or version');
        sawHeader = true;
        continue;
      }
      if (!row.c || !(row.c in COLLECTIONS)) {
        err(i + 1, `Unknown collection "${String(row.c)}"`, row.c);
        continue;
      }
      const name = row.c as BackupCollection;
      const stat = (report.collections[name] ??= { lines: 0, valid: 0, invalid: 0, written: 0 });
      stat.lines++;
      try {
        if (typeof row.d !== 'object' || row.d === null || Array.isArray(row.d)) throw new Error('Document must be an object');
        const doc = new (model(name))(row.d);
        await doc.validate();
        const cast = doc.toObject({ depopulate: true, virtuals: false, versionKey: false }) as Plain;
        if (name === 'users' && typeof (row.d as Plain).passwordHash === 'string') cast.passwordHash = (row.d as Plain).passwordHash;
        stat.valid++;
        if (apply) (docsByCollection.get(name) ?? docsByCollection.set(name, []).get(name)!).push(cast);
      } catch (e) {
        stat.invalid++;
        err(i + 1, (e as Error).message.slice(0, 200), name);
      }
    }
    if (!sawHeader) throw new BadRequestError('This is not a VibeMatch backup file (missing header)');
    if (!apply) return report;

    const invalid = Object.values(report.collections).reduce((n, c) => n + c.invalid, 0);
    if (invalid > 0) throw new BadRequestError(`${invalid} invalid line(s) — nothing was restored. Run a dry-run to see them.`, { extensions: { report } });

    if (opts.mode === 'replace' && docsByCollection.has('users') && !docsByCollection.get('users')!.some((u) => u.role === 'admin')) {
      throw new BadRequestError('Refusing to replace users with a backup that has no administrator: you would be locked out');
    }

    for (const [name, docs] of docsByCollection) {
      const m = model(name);
      if (opts.mode === 'replace') await m.collection.deleteMany({});
      for (let i = 0; i < docs.length; i += 500) {
        const chunk = docs.slice(i, i + 500);
        await m.collection.bulkWrite(
          chunk.map((d) => ({ replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true } })) as never,
          { ordered: false },
        );
        report.collections[name]!.written += chunk.length;
      }
    }
    report.applied = true;
    return report;
  }
}
