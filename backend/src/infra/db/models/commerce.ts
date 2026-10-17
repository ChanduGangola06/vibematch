import { model, Schema, type InferSchemaType, type Types } from 'mongoose';
import { baseOptions, idField } from './common.js';

const giftSchema = new Schema(
  {
    id: idField('g'),
    name: { type: String, required: true, maxlength: 80 },
    price: { type: Number, required: true, min: 0 },
    imagePath: { type: String, required: true },
  },
  baseOptions,
);
giftSchema.index({ createdAt: -1 });
export type GiftDoc = InferSchemaType<typeof giftSchema> & { _id: Types.ObjectId };
export const GiftModel = model('Gift', giftSchema);

const packSchema = new Schema(
  {
    id: idField('pack'),
    name: { type: String, required: true, maxlength: 80 },
    description: { type: String, default: '', maxlength: 500 },
    price: { type: Number, required: true, min: 0 },
    gems: { type: Number, required: true, min: 1 },
    popular: { type: Boolean, default: false },
    googlePayId: { type: String },
    applePayId: { type: String },
  },
  baseOptions,
);
packSchema.index({ price: 1 });
packSchema.index({ googlePayId: 1 }, { sparse: true });
packSchema.index({ applePayId: 1 }, { sparse: true });
export type PackDoc = InferSchemaType<typeof packSchema> & { _id: Types.ObjectId };
export const PackModel = model('Pack', packSchema);

const vipPlanSchema = new Schema(
  {
    id: idField('vip'),
    name: { type: String, required: true, maxlength: 80 },
    description: { type: String, default: '', maxlength: 500 },
    priceGems: { type: Number, required: true, min: 0 },
    durationDays: { type: Number, required: true, min: 1 },
    popular: { type: Boolean, default: false },
  },
  baseOptions,
);
vipPlanSchema.index({ priceGems: 1 });
export type VipPlanDoc = InferSchemaType<typeof vipPlanSchema> & { _id: Types.ObjectId };
export const VipPlanModel = model('VipPlan', vipPlanSchema);

export const PURCHASE_PROVIDERS = ['stripe', 'paypal', 'razorpay', 'google', 'apple'] as const;
export type PurchaseProvider = (typeof PURCHASE_PROVIDERS)[number];

const purchaseSchema = new Schema(
  {
    id: idField('txn'),
    userId: { type: String, required: true },
    username: { type: String, default: '' },
    provider: { type: String, enum: PURCHASE_PROVIDERS, required: true },
    providerTxnId: { type: String, required: true },
    receiptHash: { type: String },
    packId: { type: String, required: true },
    packName: { type: String, default: '' },
    gems: { type: Number, required: true, min: 1 },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'USD' },
    status: { type: String, enum: ['completed', 'refunded'], default: 'completed' },
  },
  baseOptions,
);
purchaseSchema.index({ provider: 1, providerTxnId: 1 }, { unique: true });
purchaseSchema.index({ receiptHash: 1 }, { unique: true, partialFilterExpression: { receiptHash: { $type: 'string' } } });
purchaseSchema.index({ userId: 1, createdAt: -1, _id: -1 });
purchaseSchema.index({ createdAt: -1, _id: -1 });
export type PurchaseDoc = InferSchemaType<typeof purchaseSchema> & { _id: Types.ObjectId };
export const PurchaseModel = model('Purchase', purchaseSchema);

export const LEDGER_REASONS = [
  'signup_bonus',
  'purchase',
  'gift_sent',
  'vip_subscribe',
  'admin_adjust',
  'refund',
] as const;
export type LedgerReason = (typeof LEDGER_REASONS)[number];

const ledgerSchema = new Schema(
  {
    id: idField('led'),
    userId: { type: String, required: true },
    delta: { type: Number, required: true },
    balanceAfter: { type: Number, required: true, min: 0 },
    reason: { type: String, enum: LEDGER_REASONS, required: true },
    refType: { type: String },
    refId: { type: String },
  },
  { versionKey: false, timestamps: { createdAt: true, updatedAt: false } },
);
ledgerSchema.index({ userId: 1, createdAt: -1, _id: -1 });
// A given business event (e.g. a purchase) can credit gems at most once.
ledgerSchema.index(
  { refType: 1, refId: 1, reason: 1 },
  { unique: true, partialFilterExpression: { refId: { $type: 'string' } } },
);
export type GemLedgerDoc = InferSchemaType<typeof ledgerSchema> & { _id: Types.ObjectId };
export const GemLedgerModel = model('GemLedger', ledgerSchema);
