import { z } from 'zod';
import type { ModuleRegistrar } from '../../app.js';
import { z as zod } from 'zod';
import { packSchema, vipPlanSchema, vipSubscribeResultSchema } from '../dto.js';
import type { PackRecord, PackRepository, VipPlanRepository } from './store.repository.js';
import type { VipService } from './vip.service.js';

/** Store-product ids are only useful to the native apps; web checkout does not need them. */
const toPackDto = (p: PackRecord) => p;

export const storeRoutes = (
  packs: Pick<PackRepository, 'list'>,
  plans: Pick<VipPlanRepository, 'list'>,
  vip: VipService,
): ModuleRegistrar => ({ v1 }) => {
  v1.add({
    method: 'get', path: '/packs', summary: 'Gem packs for sale', tags: ['store'], auth: 'public', schema: { response: zod.array(packSchema) },
    handler: async ({ res }) => {
      res.setHeader('Cache-Control', 'public, max-age=60');
      return { data: (await packs.list()).map(toPackDto) };
    },
  });
  v1.add({
    method: 'get', path: '/vip-plans', summary: 'VIP plans (priced in gems)', tags: ['store'], auth: 'public', schema: { response: zod.array(vipPlanSchema) },
    handler: async ({ res }) => {
      res.setHeader('Cache-Control', 'public, max-age=60');
      return { data: await plans.list() };
    },
  });
  v1.add({
    method: 'post', path: '/vip-plans/:planId/subscribe', summary: 'Buy VIP with gems (Idempotency-Key required)', tags: ['store'],
    auth: 'user', idempotent: 'required', rateLimit: 'sensitive', body: 'none',
    schema: { params: z.object({ planId: z.string().min(1).max(64) }), response: vipSubscribeResultSchema },
    handler: async ({ params, auth }) => ({ status: 201, data: await vip.subscribe(auth.userId, params.planId) }),
  });
};
