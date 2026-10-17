import type { ModuleRegistrar } from '../../app.js';
import { z } from 'zod';
import { cursorQuerySchema } from '../../core/pagination/index.js';
import { historyEntrySchema } from '../dto.js';
import type { HistoryService } from './history.service.js';

export const historyRoutes = (history: HistoryService): ModuleRegistrar => ({ v1 }) => {
  v1.add({
    method: 'get', path: '/matches', summary: 'People I have video-chatted with', tags: ['history'],
    auth: 'user', roles: ['guest', 'user', 'admin'], schema: { query: cursorQuerySchema, response: z.array(historyEntrySchema) },
    handler: async ({ query, auth }) => {
      const page = await history.list(auth.userId, 'video_chat', query);
      return { data: page.items, page: page.page };
    },
  });
  v1.add({
    method: 'get', path: '/matches/viewed-me', summary: 'People who viewed my profile', tags: ['history'],
    auth: 'user', schema: { query: cursorQuerySchema, response: z.array(historyEntrySchema) },
    handler: async ({ query, auth }) => {
      const page = await history.list(auth.userId, 'view', query);
      return { data: page.items, page: page.page };
    },
  });
};
