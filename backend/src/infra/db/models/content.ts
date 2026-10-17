import { model, Schema, type InferSchemaType, type Types } from 'mongoose';
import { baseOptions, idField, secondsInDay, ttlDays } from './common.js';

const pageSchema = new Schema(
  {
    id: idField('page'),
    title: { type: String, required: true, maxlength: 120 },
    slug: { type: String, required: true, lowercase: true, match: /^[a-z0-9-]{1,80}$/ },
    content: { type: String, default: '' },
    showInFooter: { type: Boolean, default: true },
    isActive: { type: Boolean, default: true },
  },
  baseOptions,
);
pageSchema.index({ slug: 1 }, { unique: true });
export type PageDoc = InferSchemaType<typeof pageSchema> & { _id: Types.ObjectId };
export const PageModel = model('Page', pageSchema);

const languageSchema = new Schema(
  {
    code: { type: String, required: true, lowercase: true, match: /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/ },
    name: { type: String, required: true, maxlength: 60 },
    flag: { type: String, default: '' },
    rtl: { type: Boolean, default: false },
    translations: { type: Schema.Types.Mixed, default: {} },
  },
  baseOptions,
);
languageSchema.index({ code: 1 }, { unique: true });
export type LanguageDoc = InferSchemaType<typeof languageSchema> & { _id: Types.ObjectId };
export const LanguageModel = model('Language', languageSchema);

const settingSchema = new Schema(
  {
    group: { type: String, required: true },
    data: { type: Schema.Types.Mixed, default: {} },
    version: { type: Number, default: 1 },
    updatedBy: { type: String },
  },
  baseOptions,
);
settingSchema.index({ group: 1 }, { unique: true });
export type SettingDoc = InferSchemaType<typeof settingSchema> & { _id: Types.ObjectId };
export const SettingModel = model('Setting', settingSchema);

const settingRevisionSchema = new Schema(
  {
    group: { type: String, required: true },
    data: { type: Schema.Types.Mixed, default: {} },
    version: { type: Number, required: true },
    by: { type: String },
  },
  { versionKey: false, timestamps: { createdAt: true, updatedAt: false } },
);
settingRevisionSchema.index({ group: 1, createdAt: -1 });
export type SettingRevisionDoc = InferSchemaType<typeof settingRevisionSchema> & { _id: Types.ObjectId };
export const SettingRevisionModel = model('SettingRevision', settingRevisionSchema);

const auditSchema = new Schema(
  {
    actorId: { type: String, required: true },
    actorName: { type: String },
    action: { type: String, required: true },
    target: { type: String },
    meta: { type: Schema.Types.Mixed },
    ip: { type: String },
  },
  { versionKey: false, timestamps: { createdAt: true, updatedAt: false } },
);
auditSchema.index({ actorId: 1, createdAt: -1, _id: -1 });
auditSchema.index({ createdAt: -1, _id: -1 });
auditSchema.index({ createdAt: 1 }, { expireAfterSeconds: ttlDays('AUDIT_TTL_DAYS', 365) * secondsInDay });
export type AuditLogDoc = InferSchemaType<typeof auditSchema> & { _id: Types.ObjectId };
export const AuditLogModel = model('AuditLog', auditSchema);
