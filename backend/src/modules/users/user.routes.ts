import { z } from 'zod';
import type { ModuleRegistrar } from '../../app.js';
import { UnauthorizedError } from '../../core/errors/index.js';
import { imageUpload } from '../../middleware/upload.js';
import { selfUserSchema } from './user.schemas.js';
import { deleteAccountBody, updateProfileBody } from './user.http-schemas.js';
import { MAX_AVATAR_BYTES, type UserService } from './user.service.js';
import { usernameSchema, publicUserSchema } from './user.schemas.js';
import { usernameCheckSchema } from '../dto.js';

const profileSchema = publicUserSchema.extend({ isFollowing: z.boolean(), isMutualFollow: z.boolean() });

export const userRoutes = (users: UserService): ModuleRegistrar => ({ v1 }) => {
  v1.add({
    method: 'get', path: '/users/check-username', summary: 'Is a username available?', tags: ['users'],
    auth: 'public',
    schema: { query: z.object({ username: z.string().min(1).max(40) }), response: usernameCheckSchema },
    handler: async ({ query }) => ({ data: await users.checkUsername(query.username) }),
  });

  v1.add({
    method: 'get', path: '/users/by-username/:username', summary: 'Public profile by username', tags: ['users'],
    auth: 'optional', schema: { params: z.object({ username: usernameSchema }), response: profileSchema },
    handler: async ({ params, auth }) => ({ data: await users.profile(auth?.userId, { username: params.username }) }),
  });

  v1.add({
    method: 'get', path: '/users/:id', summary: 'Public profile by id (use "me" for yourself)', tags: ['users'],
    auth: 'optional', schema: { params: z.object({ id: z.string().min(1).max(64) }), response: profileSchema },
    handler: async ({ params, auth }) => {
      if (params.id === 'me' && !auth) throw new UnauthorizedError();
      return { data: await users.profile(auth?.userId, { id: params.id === 'me' ? auth!.userId : params.id }) };
    },
  });

  v1.add({
    method: 'patch', path: '/users/me', summary: 'Update my profile', tags: ['users'],
    auth: 'user', rateLimit: 'sensitive',
    schema: { body: updateProfileBody, response: selfUserSchema },
    handler: async ({ body, auth }) => ({ data: await users.updateMe(auth.userId, body) }),
  });

  v1.add({
    method: 'post', path: '/users/me/avatar', summary: 'Upload a profile photo (png/jpeg/webp/gif, ≤ 2 MB)', tags: ['users'],
    auth: 'user', rateLimit: 'upload', body: 'none',
    middleware: [imageUpload('avatar', MAX_AVATAR_BYTES)],
    docs: { requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', required: ['avatar'], properties: { avatar: { type: 'string', format: 'binary' } } } } } } },
    schema: { response: selfUserSchema },
    handler: async ({ req, auth }) => ({ data: await users.uploadAvatar(auth.userId, (req as unknown as { file?: { buffer: Buffer } }).file?.buffer) }),
  });

  v1.add({
    method: 'post', path: '/users/me/delete', summary: 'Permanently delete my account', tags: ['users'],
    auth: 'user', roles: ['guest', 'user', 'admin'], rateLimit: 'sensitive',
    schema: { body: deleteAccountBody },
    handler: async ({ body, auth }) => {
      await users.deleteMe(auth.userId, body.password);
      return { status: 204 };
    },
  });
};
