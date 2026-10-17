import { z } from 'zod';
import type { ModuleRegistrar } from '../../../app.js';
import { BadRequestError } from '../../../core/errors/index.js';
import { imageUpload } from '../../../middleware/upload.js';
import { PackModel, VipPlanModel } from '../../../infra/db/models/commerce.js';
import type { AuditService } from '../audit.service.js';
import type { CatalogService } from './catalog.service.js';

const idParam = z.object({ id: z.string().min(1).max(64) });
const upload = [imageUpload('giftImage', 512 * 1024, ['image/svg+xml'])];
const file = (req: unknown) => (req as { file?: { buffer: Buffer } }).file?.buffer;
/** Multipart fields arrive as strings. */
const numeric = z.string().trim().regex(/^\d+(\.\d+)?$/).transform(Number);

const packBody = z.object({
  name: z.string().trim().min(1).max(80), description: z.string().trim().max(500).default(''),
  price: z.number().min(0).max(100_000), gems: z.number().int().min(1).max(100_000_000),
  popular: z.boolean().default(false), googlePayId: z.string().trim().max(150).optional(), applePayId: z.string().trim().max(150).optional(),
});
const planBody = z.object({
  name: z.string().trim().min(1).max(80), description: z.string().trim().max(500).default(''),
  priceGems: z.number().int().min(0).max(100_000_000), durationDays: z.number().int().min(1).max(3650), popular: z.boolean().default(false),
});

export const catalogRoutes = (svc: CatalogService, audit: AuditService): ModuleRegistrar => ({ v1 }) => {
  // ---- gifts (multipart) ----------------------------------------------------------------------
  v1.add({
    method: 'get', path: '/admin/gifts', summary: 'Gift catalogue (admin)', tags: ['admin', 'catalog'], auth: 'admin',
    handler: async () => ({ data: await svc.listGifts() }),
  });
  v1.add({
    method: 'post', path: '/admin/gifts', summary: 'Create a gift (multipart: name, price, giftImage)', tags: ['admin', 'catalog'],
    auth: 'admin', rateLimit: 'upload', body: 'none', middleware: upload,
    docs: { requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', required: ['name', 'price', 'giftImage'], properties: { name: { type: 'string' }, price: { type: 'integer' }, giftImage: { type: 'string', format: 'binary' } } } } } } },
    handler: async ({ req }) => {
      const f = z.object({ name: z.string().trim().min(1).max(80), price: numeric }).safeParse(req.body);
      if (!f.success) throw new BadRequestError('name and price are required');
      const gift = await svc.createGift(f.data.name, Math.round(f.data.price), file(req));
      await audit.record(req, { action: 'gift.create', target: gift.id, meta: { name: gift.name, price: gift.price } });
      return { status: 201, data: gift };
    },
  });
  v1.add({
    method: 'patch', path: '/admin/gifts/:id', summary: 'Edit a gift (multipart, image optional)', tags: ['admin', 'catalog'],
    auth: 'admin', rateLimit: 'upload', body: 'none', middleware: upload, schema: { params: idParam },
    docs: { requestBody: { content: { 'multipart/form-data': { schema: { type: 'object', properties: { name: { type: 'string' }, price: { type: 'integer' }, giftImage: { type: 'string', format: 'binary' } } } } } } },
    handler: async ({ params, req }) => {
      const f = z.object({ name: z.string().trim().min(1).max(80).optional(), price: numeric.optional() }).safeParse(req.body ?? {});
      if (!f.success) throw new BadRequestError('Invalid name or price');
      const gift = await svc.updateGift(params.id, { name: f.data.name, price: f.data.price === undefined ? undefined : Math.round(f.data.price) }, file(req));
      await audit.record(req, { action: 'gift.update', target: params.id });
      return { data: gift };
    },
  });
  v1.add({
    method: 'delete', path: '/admin/gifts/:id', summary: 'Delete a gift', tags: ['admin', 'catalog'], auth: 'admin', schema: { params: idParam },
    handler: async ({ params, req }) => {
      await svc.deleteGift(params.id);
      await audit.record(req, { action: 'gift.delete', target: params.id });
      return { status: 204 };
    },
  });

  // ---- packs ------------------------------------------------------------------------------------
  v1.add({
    method: 'get', path: '/admin/packs', summary: 'Gem packs (admin)', tags: ['admin', 'catalog'], auth: 'admin',
    handler: async () => ({ data: (await PackModel.find().sort({ price: 1 }).lean()).map(({ _id, ...p }) => p) }),
  });
  v1.add({
    method: 'post', path: '/admin/packs', summary: 'Create a gem pack', tags: ['admin', 'catalog'], auth: 'admin', schema: { body: packBody },
    handler: async ({ body, req }) => {
      const p = await svc.createPack(body);
      await audit.record(req, { action: 'pack.create', target: p.id, meta: { price: body.price, gems: body.gems } });
      return { status: 201, data: p };
    },
  });
  v1.add({
    method: 'patch', path: '/admin/packs/:id', summary: 'Edit a gem pack', tags: ['admin', 'catalog'], auth: 'admin',
    schema: { params: idParam, body: packBody.partial().refine((v) => Object.keys(v).length > 0, 'Provide at least one field') },
    handler: async ({ params, body, req }) => {
      const p = await svc.updatePack(params.id, body);
      await audit.record(req, { action: 'pack.update', target: params.id, meta: { fields: Object.keys(body) } });
      return { data: p };
    },
  });
  v1.add({
    method: 'delete', path: '/admin/packs/:id', summary: 'Delete a gem pack', tags: ['admin', 'catalog'], auth: 'admin', schema: { params: idParam },
    handler: async ({ params, req }) => {
      await svc.deletePack(params.id);
      await audit.record(req, { action: 'pack.delete', target: params.id });
      return { status: 204 };
    },
  });

  // ---- VIP plans -------------------------------------------------------------------------------
  v1.add({
    method: 'get', path: '/admin/vip-plans', summary: 'VIP plans (admin)', tags: ['admin', 'catalog'], auth: 'admin',
    handler: async () => ({ data: (await VipPlanModel.find().sort({ priceGems: 1 }).lean()).map(({ _id, ...p }) => p) }),
  });
  v1.add({
    method: 'post', path: '/admin/vip-plans', summary: 'Create a VIP plan', tags: ['admin', 'catalog'], auth: 'admin', schema: { body: planBody },
    handler: async ({ body, req }) => {
      const p = await svc.createPlan(body);
      await audit.record(req, { action: 'vip_plan.create', target: p.id });
      return { status: 201, data: p };
    },
  });
  v1.add({
    method: 'patch', path: '/admin/vip-plans/:id', summary: 'Edit a VIP plan', tags: ['admin', 'catalog'], auth: 'admin',
    schema: { params: idParam, body: planBody.partial().refine((v) => Object.keys(v).length > 0, 'Provide at least one field') },
    handler: async ({ params, body, req }) => {
      const p = await svc.updatePlan(params.id, body);
      await audit.record(req, { action: 'vip_plan.update', target: params.id });
      return { data: p };
    },
  });
  v1.add({
    method: 'delete', path: '/admin/vip-plans/:id', summary: 'Delete a VIP plan', tags: ['admin', 'catalog'], auth: 'admin', schema: { params: idParam },
    handler: async ({ params, req }) => {
      await svc.deletePlan(params.id);
      await audit.record(req, { action: 'vip_plan.delete', target: params.id });
      return { status: 204 };
    },
  });
};
