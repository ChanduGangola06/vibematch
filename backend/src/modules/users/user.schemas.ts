import { z } from 'zod';

export const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const RESERVED = new Set(['admin', 'administrator', 'root', 'system', 'support', 'vibematch', 'moderator', 'null', 'undefined', 'api']);

/** Usernames are case-insensitive; the canonical stored form is lower case. */
export const usernameSchema = z
  .string()
  .regex(USERNAME_RE, 'Username must be 3-20 characters: letters, numbers and underscores')
  .transform((s) => s.toLowerCase())
  .refine((s) => !RESERVED.has(s) && !/^(guest|demo)_/.test(s), 'This username is reserved');

export const emailSchema = z.email().max(254).transform((s) => s.toLowerCase());

const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', '12345678', '123456789', '1234567890', 'qwertyui', 'qwerty123',
  'iloveyou', 'admin123', 'letmein1', 'welcome1', 'abc12345', '11111111', '00000000', 'vibematch',
]);

/** bcrypt ignores everything after 72 *bytes*; reject instead of silently truncating. */
export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .refine((s) => Buffer.byteLength(s, 'utf8') <= 72, 'Password must be at most 72 bytes')
  .refine((s) => !COMMON_PASSWORDS.has(s.toLowerCase()), 'This password is too common');

export const genderSchema = z.enum(['male', 'female', 'other']);

/** What the account owner sees about themselves. */
export const selfUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  name: z.string(),
  email: z.string().optional(),
  avatar: z.string(),
  gender: z.string(),
  country: z.string(),
  countryCode: z.string(),
  age: z.number().optional(),
  bio: z.string(),
  phone: z.string(),
  address: z.string(),
  gems: z.number(),
  likesCount: z.number(),
  followersCount: z.number(),
  followingCount: z.number(),
  vipExpiry: z.string().optional(),
  isVip: z.boolean(),
  role: z.enum(['guest', 'user', 'admin']),
  isGuest: z.boolean(),
  createdAt: z.string(),
});
export type SelfUser = z.infer<typeof selfUserSchema>;

/** What other people see. No email, phone, address, gems. */
export const publicUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  name: z.string(),
  avatar: z.string(),
  gender: z.string(),
  country: z.string(),
  countryCode: z.string(),
  age: z.number().optional(),
  bio: z.string(),
  likesCount: z.number(),
  followersCount: z.number(),
  followingCount: z.number(),
  isOnline: z.boolean(),
  isVip: z.boolean(),
});
export type PublicUser = z.infer<typeof publicUserSchema>;

export const adminUserSchema = selfUserSchema.extend({
  isBanned: z.boolean(),
  isDemo: z.boolean(),
  isOnline: z.boolean(),
  lastLoginAt: z.string().optional(),
  requirePasskey: z.boolean(),
  videoUrl: z.string(),
});
export type AdminUser = z.infer<typeof adminUserSchema>;
