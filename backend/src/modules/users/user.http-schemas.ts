import { z } from 'zod';
import { genderSchema, usernameSchema } from './user.schemas.js';

/** Fields a user may change about themselves. Anything else (role, gems, ban flags…) is rejected by `.strict()`. */
export const updateProfileBody = z
  .object({
    name: z.string().trim().min(1).max(60),
    username: usernameSchema,
    bio: z.string().trim().max(500),
    age: z.number().int().min(13).max(120),
    gender: genderSchema,
    phone: z.string().trim().max(30).regex(/^[+\d\s().-]*$/, 'Invalid phone number'),
    address: z.string().trim().max(200),
    country: z.string().trim().max(60),
    countryCode: z.string().regex(/^[A-Za-z]{2}$/).transform((s) => s.toUpperCase()),
    /** Only the bundled default avatars can be selected here; photos go through POST /users/me/avatar. */
    avatar: z.string().regex(/^\/images\/avatars\/(male|female)-\d{1,2}\.svg$/),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field');
export type UpdateProfileInput = z.infer<typeof updateProfileBody>;

export const deleteAccountBody = z.object({ password: z.string().min(1).max(200).optional() });
