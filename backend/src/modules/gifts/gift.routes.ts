import { z } from 'zod';
import type { ModuleRegistrar } from '../../app.js';
import { giftSchema, giftSendResultSchema } from '../dto.js';
import type { GiftService } from './gift.service.js';

export const giftRoutes = (gifts: GiftService): ModuleRegistrar => ({ v1 }) => {
  v1.add({
    method: 'get', path: '/gifts', summary: 'Gift catalogue', tags: ['gifts'], auth: 'public', schema: { response: z.array(giftSchema) },
    handler: async ({ res }) => {
      res.setHeader('Cache-Control', 'public, max-age=60');
      return { data: await gifts.list() };
    },
  });

  v1.add({
    method: 'post', path: '/gifts/:giftId/send', summary: 'Send a gift (costs gems; Idempotency-Key required)', tags: ['gifts'],
    auth: 'user', idempotent: 'required', rateLimit: 'sensitive',
    schema: { params: z.object({ giftId: z.string().min(1).max(64) }), body: z.object({ receiverId: z.string().min(1).max(64) }), response: giftSendResultSchema },
    handler: async ({ params, body, auth }) => ({ status: 201, data: await gifts.send(auth.userId, body.receiverId, params.giftId) }),
  });
};
