import { z } from 'zod';
import type { ModuleRegistrar } from '../../app.js';
import { offsetQuerySchema } from '../../core/pagination/index.js';
import type { AuditService } from '../admin/audit.service.js';
import { footerPageSchema, languageSchema, languageWithTranslationsSchema, pageSchema } from '../dto.js';
import type { LanguageService } from './language.service.js';
import type { PageService } from './page.service.js';

const slug = z.string().toLowerCase().regex(/^[a-z0-9-]{1,80}$/, 'Slug may contain lowercase letters, digits and dashes');
const pageBody = z.object({
  title: z.string().trim().min(1).max(120),
  slug,
  content: z.string().max(200_000).optional(),
  showInFooter: z.boolean().optional(),
  isActive: z.boolean().optional(),
});
const idParam = z.object({ id: z.string().min(1).max(80) });
const code = z.string().toLowerCase().regex(/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/);
const translations = z.record(z.string().min(1).max(200), z.string().max(2000)).refine((o) => Object.keys(o).length <= 10_000, 'Too many keys');

export const contentRoutes = (pages: PageService, languages: LanguageService, audit: AuditService): ModuleRegistrar => ({ v1 }) => {
  // ---- public ---------------------------------------------------------------------------------
  v1.add({
    method: 'get', path: '/pages', summary: 'Footer pages', tags: ['content'], auth: 'public', schema: { response: z.array(footerPageSchema) },
    handler: async ({ res }) => {
      res.setHeader('Cache-Control', 'public, max-age=60');
      return { data: await pages.listPublic() };
    },
  });
  v1.add({
    method: 'get', path: '/pages/:slug', summary: 'One CMS page', tags: ['content'], auth: 'public',
    schema: { params: z.object({ slug }), response: pageSchema },
    handler: async ({ params, res }) => {
      res.setHeader('Cache-Control', 'public, max-age=60');
      return { data: await pages.getPublic(params.slug) };
    },
  });
  v1.add({
    method: 'get', path: '/languages', summary: 'Available languages', tags: ['content'], auth: 'public', schema: { response: z.array(languageSchema) },
    handler: async ({ res }) => {
      res.setHeader('Cache-Control', 'public, max-age=60');
      return { data: await languages.list() };
    },
  });
  v1.add({
    method: 'get', path: '/languages/:code', summary: 'A language with its translations', tags: ['content'], auth: 'public',
    schema: { params: z.object({ code }), response: languageWithTranslationsSchema },
    handler: async ({ params, res }) => {
      res.setHeader('Cache-Control', 'public, max-age=60');
      return { data: await languages.get(params.code) };
    },
  });

  // ---- admin: pages ---------------------------------------------------------------------------
  v1.add({
    method: 'get', path: '/admin/pages', summary: 'List CMS pages', tags: ['admin', 'content'], auth: 'admin',
    schema: { query: offsetQuerySchema.extend({ search: z.string().trim().max(80).optional() }) },
    handler: async ({ query }) => {
      const r = await pages.list(query);
      return { data: r.items, page: r.page };
    },
  });
  v1.add({
    method: 'post', path: '/admin/pages', summary: 'Create a CMS page (HTML is sanitised)', tags: ['admin', 'content'], auth: 'admin',
    schema: { body: pageBody },
    handler: async ({ body, req }) => {
      const page = await pages.create(body);
      await audit.record(req, { action: 'page.create', target: page.id, meta: { slug: page.slug } });
      return { status: 201, data: page };
    },
  });
  v1.add({
    method: 'patch', path: '/admin/pages/:id', summary: 'Update a CMS page', tags: ['admin', 'content'], auth: 'admin',
    schema: { params: idParam, body: pageBody.partial().refine((v) => Object.keys(v).length > 0, 'Provide at least one field') },
    handler: async ({ params, body, req }) => {
      const page = await pages.update(params.id, body);
      await audit.record(req, { action: 'page.update', target: params.id });
      return { data: page };
    },
  });
  v1.add({
    method: 'delete', path: '/admin/pages/:id', summary: 'Delete a CMS page', tags: ['admin', 'content'], auth: 'admin',
    schema: { params: idParam },
    handler: async ({ params, req }) => {
      await pages.remove(params.id);
      await audit.record(req, { action: 'page.delete', target: params.id });
      return { status: 204 };
    },
  });

  // ---- admin: languages -----------------------------------------------------------------------
  v1.add({
    method: 'post', path: '/admin/languages', summary: 'Add a language', tags: ['admin', 'content'], auth: 'admin',
    schema: { body: z.object({ code, name: z.string().trim().min(1).max(60), flag: z.string().max(60).default(''), rtl: z.boolean().default(false) }) },
    handler: async ({ body, req }) => {
      const lang = await languages.create(body);
      await audit.record(req, { action: 'language.create', target: lang.code });
      return { status: 201, data: lang };
    },
  });
  v1.add({
    method: 'put', path: '/admin/languages/:code', summary: 'Update a language / its translations', tags: ['admin', 'content'], auth: 'admin',
    schema: {
      params: z.object({ code }),
      body: z.object({ name: z.string().trim().min(1).max(60), flag: z.string().max(60), rtl: z.boolean(), translations }).partial().refine((v) => Object.keys(v).length > 0, 'Provide at least one field'),
    },
    handler: async ({ params, body, req }) => {
      await languages.update(params.code, body);
      await audit.record(req, { action: 'language.update', target: params.code, meta: { keys: body.translations ? Object.keys(body.translations).length : undefined } });
      return { data: await languages.get(params.code) };
    },
  });
  v1.add({
    method: 'delete', path: '/admin/languages/:code', summary: 'Delete a language', tags: ['admin', 'content'], auth: 'admin',
    schema: { params: z.object({ code }) },
    handler: async ({ params, req }) => {
      await languages.remove(params.code);
      await audit.record(req, { action: 'language.delete', target: params.code });
      return { status: 204 };
    },
  });
};
