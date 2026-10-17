import { z } from 'zod';
import { HANDLED } from '../../gateway/index.js';
import type { ModuleRegistrar } from '../../app.js';
import { buildOpenApi } from '../../docs/openapi.js';
import type { RouteDescription } from '../../gateway/index.js';

const startedAt = Date.now();

/** Operational endpoints. Liveness is dependency-free; readiness proves the instance can serve traffic. */
export const registerHealth: ModuleRegistrar = ({ root, deps }) => {
  root.add({
    method: 'get',
    path: '/health/live',
    summary: 'Liveness probe',
    tags: ['ops'],
    auth: 'public',
    rateLimit: 'global',
    schema: { response: z.object({ status: z.literal('ok'), uptimeSeconds: z.number() }) },
    handler: async () => ({
      data: { status: 'ok' as const, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) },
    }),
  });

  root.add({
    method: 'get',
    path: '/health/ready',
    summary: 'Readiness probe (database, cache, …)',
    tags: ['ops'],
    auth: 'public',
    rateLimit: 'global',
    handler: async () => {
      const results = await Promise.all(
        deps.healthChecks.map(async (c) => {
          const t = performance.now();
          try {
            const r = await Promise.race([
              c.run(),
              new Promise<{ ok: boolean }>((resolve) => setTimeout(() => resolve({ ok: false }), 3000)),
            ]);
            return { name: c.name, ok: r.ok, ms: Math.round(performance.now() - t), ...('detail' in r ? { detail: r.detail } : {}) };
          } catch {
            return { name: c.name, ok: false, ms: Math.round(performance.now() - t) };
          }
        }),
      );
      const ready = results.every((r) => r.ok);
      return { status: ready ? 200 : 503, data: { status: ready ? 'ready' : 'degraded', checks: results } };
    },
  });

  root.add({
    method: 'get',
    path: '/metrics',
    summary: 'Prometheus metrics',
    tags: ['ops'],
    auth: 'public',
    apiKey: 'admin',
    rateLimit: 'global',
    handler: async ({ res }) => {
      res.type('text/plain; version=0.0.4').send(await deps.metrics.render());
      return HANDLED;
    },
  });

  if (deps.env.EXPOSE_OPENAPI) {
    root.add({
      method: 'get',
      path: '/openapi.json',
      summary: 'OpenAPI description of this API',
      tags: ['ops'],
      auth: 'public',
      rateLimit: 'global',
      handler: async ({ req, res }) => {
        const reg = req.app.locals.registries as { v1: { describe(): RouteDescription[] } };
        res.json(buildOpenApi(reg.v1.describe(), { title: 'VibeMatch API', version: '2.0.0', serverUrl: '/api/v1' }));
        return HANDLED;
      },
    });
  }
};
