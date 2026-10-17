import { model, Schema, type InferSchemaType, type Types } from 'mongoose';
import { baseOptions, idField } from './common.js';

export const USER_ROLES = ['guest', 'user', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

const authProviderSchema = new Schema(
  { provider: { type: String, required: true }, providerUid: { type: String, required: true } },
  { _id: false },
);

const userSchema = new Schema(
  {
    id: idField(),
    username: { type: String, required: true, trim: true },
    usernameLower: { type: String, required: true, lowercase: true },
    name: { type: String, default: '' },
    email: { type: String, trim: true },
    emailLower: { type: String, lowercase: true },
    passwordHash: { type: String, select: false },
    role: { type: String, enum: USER_ROLES, default: 'user' },
    avatar: { type: String, default: '' },
    gender: { type: String, enum: ['male', 'female', 'other', ''], default: '' },
    country: { type: String, default: '' },
    countryCode: { type: String, default: '' },
    age: { type: Number, min: 13, max: 120 },
    bio: { type: String, default: '', maxlength: 500 },
    phone: { type: String, default: '' },
    address: { type: String, default: '' },
    gems: { type: Number, default: 0, min: 0 },
    likesCount: { type: Number, default: 0, min: 0 },
    followersCount: { type: Number, default: 0, min: 0 },
    followingCount: { type: Number, default: 0, min: 0 },
    vipExpiry: { type: Date },
    isBanned: { type: Boolean, default: false },
    isDemo: { type: Boolean, default: false },
    isOnline: { type: Boolean, default: false },
    videoUrl: { type: String, default: '' },
    fcmTokens: { type: [String], default: [] },
    authProviders: { type: [authProviderSchema], default: [] },
    failedLogins: { type: Number, default: 0 },
    lockedUntil: { type: Date },
    lastLoginAt: { type: Date },
    requirePasskey: { type: Boolean, default: false },
  },
  baseOptions,
);

userSchema.index({ usernameLower: 1 }, { unique: true });
userSchema.index({ emailLower: 1 }, { unique: true, partialFilterExpression: { emailLower: { $type: 'string' } } });
userSchema.index({ isDemo: 1, isOnline: 1 });
userSchema.index({ role: 1 });
userSchema.index({ vipExpiry: 1 }, { sparse: true });
userSchema.index({ 'authProviders.provider': 1, 'authProviders.providerUid': 1 }, { sparse: true });
userSchema.index({ createdAt: -1, _id: -1 });

export type UserDoc = InferSchemaType<typeof userSchema> & { _id: Types.ObjectId };
export const UserModel = model('User', userSchema);
