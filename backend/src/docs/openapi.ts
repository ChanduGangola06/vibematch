import { z, type ZodType } from 'zod';
import type { RouteDescription } from '../gateway/index.js';

type Json = Record<string, unknown>;

export interface OpenApiInfo {
  title: string;
  version: string;
  serverUrl: string;
}

/** zod → JSON Schema (draft 2020-12 is what OpenAPI 3.1 uses). Unrepresentable types degrade to `{}`. */
function toSchema(schema: ZodType, io: 'input' | 'output' = 'input'): Json {
  const json = z.toJSONSchema(schema, { io, unrepresentable: 'any', reused: 'inline' }) as Json;
  delete json.$schema;
  return json;
}

function toParameters(schema: ZodType | undefined, where: 'path' | 'query'): Json[] {
  if (!schema) return [];
  const json = toSchema(schema);
  const props = (json.properties ?? {}) as Record<string, Json>;
  const required = new Set((json.required ?? []) as string[]);
  return Object.entries(props).map(([name, s]) => ({
    name, in: where, required: where === 'path' || required.has(name), schema: s,
    ...(typeof s.description === 'string' ? { description: s.description } : {}),
  }));
}

const operationId = (r: RouteDescription): string =>
  `${r.method}${r.path.split('/').filter(Boolean).map((seg) => seg.replace(/^:/, 'By_').replace(/[^A-Za-z0-9_]/g, '_')).map((s) => s[0]!.toUpperCase() + s.slice(1)).join('')}`;

const problemRef = { $ref: '#/components/responses/Problem' };

function security(r: RouteDescription): Json[] | undefined {
  const bearer = { bearerAuth: [] };
  const key = r.apiKey ? { apiKeyAuth: [] } : undefined;
  switch (r.auth) {
    case 'public': return key ? [key] : [];
    case 'optional': return [{}, bearer];
    case 'user':
    case 'admin': return [key ? { ...bearer, ...key } : bearer];
  }
}

function operation(r: RouteDescription): Json {
  const params = [...toParameters(r.schema.params, 'path'), ...toParameters(r.schema.query, 'query')];
  if (r.idempotent) {
    params.push({
      name: 'Idempotency-Key', in: 'header', required: r.idempotent === 'required', schema: { type: 'string', minLength: 8, maxLength: 128 },
      description: 'Retries with the same key and body replay the first response instead of repeating the action.',
    });
  }

  const op: Json = {
    operationId: operationId(r),
    summary: r.summary,
    tags: r.tags.length ? r.tags : ['misc'],
    ...(params.length ? { parameters: params } : {}),
    security: security(r),
    'x-roles': r.auth === 'public' || r.auth === 'optional' ? undefined : r.roles,
    'x-rate-limit-policy': r.rateLimit,
    responses: {
      '2XX': r.schema.response
        ? { description: 'Success', content: { 'application/json': { schema: { type: 'object', required: ['data', 'meta'], properties: { data: toSchema(r.schema.response, 'output'), page: { $ref: '#/components/schemas/Page' }, meta: { $ref: '#/components/schemas/Meta' } } } } } }
        : { description: 'Success (`data` carries the payload; 204 has no body)' },
      '4XX': problemRef,
      '5XX': problemRef,
    },
  };

  if (r.docs.requestBody) {
    op.requestBody = r.docs.requestBody;
  } else if (r.schema.body) {
    const content: Json = { [r.body === 'form' ? 'application/x-www-form-urlencoded' : 'application/json']: { schema: toSchema(r.schema.body) } };
    if (r.body === 'form') content['application/json'] = { schema: toSchema(r.schema.body) };
    op.requestBody = { required: true, content };
  }
  return JSON.parse(JSON.stringify(op)) as Json; // drops undefined members
}

/**
 * OpenAPI 3.1 description generated from the live route registry — the registry is the single source
 * of truth, so documentation, validation and authorization can never disagree.
 */
export function buildOpenApi(routes: RouteDescription[], info: OpenApiInfo): Json {
  const paths: Record<string, Json> = {};
  for (const r of [...routes].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))) {
    const p = r.path.replace(/:(\w+)/g, '{$1}');
    (paths[p] ??= {})[r.method] = operation(r);
  }
  return {
    openapi: '3.1.0',
    info: {
      title: info.title, version: info.version,
      description: 'VibeMatch REST API. Errors use RFC 9457 problem details (application/problem+json). Lists use cursor pagination (`limit`, `cursor`) except admin tables (`page`, `pageSize`).',
    },
    servers: [{ url: info.serverUrl }],
    tags: [...new Set(routes.flatMap((r) => r.tags))].sort().map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Access token from /auth/login, /auth/register, /auth/social or /auth/token (15 min).' },
        apiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key', description: 'Leveled API key (public < mobile < partner < admin).' },
      },
      responses: {
        Problem: { description: 'Error (RFC 9457)', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } },
      },
      schemas: {
        Problem: {
          type: 'object', required: ['type', 'title', 'status', 'code'],
          properties: {
            type: { type: 'string', format: 'uri' }, title: { type: 'string' }, status: { type: 'integer' }, code: { type: 'string', description: 'Stable machine-readable identifier' },
            detail: { type: 'string' }, instance: { type: 'string' }, requestId: { type: 'string' },
            errors: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, message: { type: 'string' }, code: { type: 'string' } } } },
          },
        },
        Meta: { type: 'object', required: ['requestId'], properties: { requestId: { type: 'string' } } },
        Page: {
          oneOf: [
            { type: 'object', required: ['limit', 'hasMore', 'nextCursor'], properties: { limit: { type: 'integer' }, hasMore: { type: 'boolean' }, nextCursor: { type: ['string', 'null'] } } },
            { type: 'object', required: ['page', 'pageSize', 'total', 'totalPages'], properties: { page: { type: 'integer' }, pageSize: { type: 'integer' }, total: { type: 'integer' }, totalPages: { type: 'integer' } } },
          ],
        },
      },
    },
  };
}
