import { model, Schema, type InferSchemaType, type Types } from 'mongoose';
import { API_KEY_LEVELS } from '../../../core/security/api-key.js';
import { baseOptions, idField } from './common.js';

const refreshTokenSchema = new Schema(
  {
    familyId: { type: String, required: true, index: true },
    tokenHash: { type: String, required: true },
    userId: { type: String, required: true, index: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date },
    usedAt: { type: Date },
    replacedBy: { type: String },
    ip: { type: String },
    userAgent: { type: String, maxlength: 300 },
  },
  baseOptions,
);
refreshTokenSchema.index({ tokenHash: 1 }, { unique: true });
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export type RefreshTokenDoc = InferSchemaType<typeof refreshTokenSchema> & { _id: Types.ObjectId };
export const RefreshTokenModel = model('RefreshToken', refreshTokenSchema);

const credentialSchema = new Schema(
  {
    userId: { type: String, required: true, index: true },
    credentialId: { type: String, required: true },
    publicKey: { type: String, required: true },
    counter: { type: Number, default: 0 },
    transports: { type: [String], default: [] },
    deviceType: { type: String },
    backedUp: { type: Boolean },
    label: { type: String, default: 'Passkey', maxlength: 60 },
    lastUsedAt: { type: Date },
  },
  baseOptions,
);
credentialSchema.index({ credentialId: 1 }, { unique: true });
export type AuthCredentialDoc = InferSchemaType<typeof credentialSchema> & { _id: Types.ObjectId };
export const AuthCredentialModel = model('AuthCredential', credentialSchema);

const challengeSchema = new Schema(
  {
    key: { type: String, required: true },
    // '' until WebAuthn options are generated for a login token
    challenge: { type: String, default: '' },
    purpose: { type: String, enum: ['register', 'login'], required: true },
    userId: { type: String },
    expiresAt: { type: Date, required: true },
  },
  baseOptions,
);
challengeSchema.index({ key: 1 }, { unique: true });
challengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export type AuthChallengeDoc = InferSchemaType<typeof challengeSchema> & { _id: Types.ObjectId };
export const AuthChallengeModel = model('AuthChallenge', challengeSchema);

const apiKeySchema = new Schema(
  {
    id: idField('key'),
    name: { type: String, required: true, maxlength: 80 },
    prefix: { type: String, required: true },
    keyHash: { type: String, required: true },
    level: { type: String, enum: API_KEY_LEVELS, required: true },
    scopes: { type: [String], default: [] },
    expiresAt: { type: Date },
    revokedAt: { type: Date },
    lastUsedAt: { type: Date },
    createdBy: { type: String },
  },
  baseOptions,
);
apiKeySchema.index({ keyHash: 1 }, { unique: true });
apiKeySchema.index({ prefix: 1 });
export type ApiKeyDoc = InferSchemaType<typeof apiKeySchema> & { _id: Types.ObjectId };
export const ApiKeyModel = model('ApiKey', apiKeySchema);

const idempotencySchema = new Schema(
  {
    key: { type: String, required: true },
    scope: { type: String, required: true },
    route: { type: String, required: true },
    requestHash: { type: String, required: true },
    status: { type: String, enum: ['in_progress', 'completed'], required: true },
    responseStatus: { type: Number },
    responseBody: { type: Schema.Types.Mixed },
    expiresAt: { type: Date, required: true },
  },
  baseOptions,
);
idempotencySchema.index({ scope: 1, key: 1, route: 1 }, { unique: true });
idempotencySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export type IdempotencyDoc = InferSchemaType<typeof idempotencySchema> & { _id: Types.ObjectId };
export const IdempotencyModel = model('IdempotencyKey', idempotencySchema);
