import { z } from 'zod';
import type { ModuleRegistrar } from '../../app.js';
import { cursorQuerySchema } from '../../core/pagination/index.js';
import { checkoutResultSchema, fulfilResultSchema, purchaseSchema } from '../dto.js';
import type { PaymentService } from './payment.service.js';

const packId = z.string().min(1).max(100);
const checkoutBody = z.object({ packId, returnUrl: z.string().url().max(500).optional() });
const storeBody = z.object({ packId, receipt: z.string().min(20).max(20_000) });

const verifySchemas = {
  stripe: z.object({ sessionId: z.string().min(5).max(200) }),
  paypal: z.object({ orderId: z.string().min(5).max(64) }),
  razorpay: z.object({ orderId: z.string().min(5).max(100), paymentId: z.string().min(5).max(100), signature: z.string().min(10).max(200) }),
  google: storeBody,
  apple: storeBody,
} as const;

export const paymentRoutes = (payments: PaymentService): ModuleRegistrar => ({ v1 }) => {
  for (const provider of ['stripe', 'paypal', 'razorpay'] as const) {
    v1.add({
      method: 'post', path: `/payments/${provider}/checkout`, summary: `Start a ${provider} checkout for a gem pack`, tags: ['payments'],
      auth: 'user', rateLimit: 'sensitive', schema: { body: checkoutBody, response: checkoutResultSchema },
      handler: async ({ body, auth }) => ({ status: 201, data: await payments.checkout(auth.userId, provider, body.packId, body.returnUrl) }),
    });
  }

  for (const provider of Object.keys(verifySchemas) as (keyof typeof verifySchemas)[]) {
    v1.add({
      method: 'post', path: `/payments/${provider}/verify`, summary: `Confirm a ${provider} payment and credit the gems`, tags: ['payments'],
      auth: 'user', rateLimit: 'sensitive', idempotent: 'optional',
      schema: { body: verifySchemas[provider] as never, response: fulfilResultSchema },
      handler: async ({ body, auth }) => {
        const r = await payments.verify(auth.userId, provider, body as Record<string, unknown>);
        return { status: r.alreadyProcessed ? 200 : 201, data: r };
      },
    });
  }

  // Gateways call these server-to-server; authenticity comes from the signature, not from a login.
  for (const provider of ['stripe', 'paypal', 'razorpay'] as const) {
    v1.add({
      method: 'post', path: `/payments/webhooks/${provider}`, summary: `${provider} webhook`, tags: ['payments'],
      auth: 'public', body: 'raw', rateLimit: 'global',
      handler: async ({ req }) => {
        const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
        const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const processed = await payments.webhook(provider, raw, headers);
        return { data: { received: true, processed } };
      },
    });
  }

  v1.add({
    method: 'get', path: '/payments/purchases', summary: 'My purchase history', tags: ['payments'],
    auth: 'user', schema: { query: cursorQuerySchema, response: z.array(purchaseSchema) },
    handler: async ({ query, auth }) => {
      const page = await payments.listForUser(auth.userId, query);
      return { data: page.items, page: page.page };
    },
  });
};
