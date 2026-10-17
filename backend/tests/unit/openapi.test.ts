import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateOpenApi } from '../../src/docs/generate.js';

type Doc = {
  openapi: string;
  paths: Record<string, Record<string, any>>;
  components: { securitySchemes: Record<string, unknown>; schemas: Record<string, unknown>; responses: Record<string, unknown> };
};

const committed = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../../docs/openapi.json'), 'utf8')) as Doc;
const generated = generateOpenApi() as unknown as Doc;
const operations = Object.entries(generated.paths).flatMap(([p, item]) => Object.entries(item).map(([method, op]) => ({ p, method, op })));

describe('OpenAPI contract', () => {
  it('docs/openapi.json is up to date (run `npm run openapi` after changing routes)', () => {
    expect(generated).toEqual(committed);
  });

  it('is a well-formed OpenAPI 3.1 document covering the whole API', () => {
    expect(generated.openapi).toBe('3.1.0');
    expect(operations.length).toBeGreaterThan(120);
    const ids = operations.map((o) => o.op.operationId as string);
    expect(new Set(ids).size).toBe(ids.length); // unique operationIds (client generators rely on it)
  });

  it('declares security on every operation and the right scheme for admin routes', () => {
    for (const { p, method, op } of operations) {
      expect(op.security, `${method} ${p}`).toBeDefined();
      if (p.startsWith('/admin')) expect(JSON.stringify(op.security), `${method} ${p}`).toContain('bearerAuth');
      if (op['x-roles']) expect(op.security.length, `${method} ${p}`).toBeGreaterThan(0);
    }
    expect(generated.components.securitySchemes).toHaveProperty('bearerAuth');
    expect(generated.components.securitySchemes).toHaveProperty('apiKeyAuth');
  });

  it('every {path} parameter is declared, and every $ref resolves', () => {
    const refs = new Set<string>();
    JSON.stringify(generated, (_k, v) => {
      if (typeof v === 'string' && v.startsWith('#/components/')) refs.add(v);
      return v;
    });
    for (const ref of refs) {
      const [, , group, name] = ref.split('/');
      expect((generated.components as Record<string, Record<string, unknown>>)[group!]![name!], ref).toBeDefined();
    }
    for (const { p, method, op } of operations) {
      for (const [, name] of p.matchAll(/\{(\w+)\}/g)) {
        expect(op.parameters?.some((x: { name: string; in: string }) => x.name === name && x.in === 'path'), `${method} ${p} {${name}}`).toBe(true);
      }
    }
  });

  it('documents idempotency keys, API keys and cursor pagination where they apply', () => {
    const pay = generated.paths['/gifts/{giftId}/send']!.post;
    expect(pay.parameters.find((x: { name: string }) => x.name === 'Idempotency-Key')).toMatchObject({ in: 'header', required: true });
    expect(JSON.stringify(generated.paths['/init']!.get.security)).toContain('apiKeyAuth');
    const inbox = generated.paths['/conversations']!.get;
    expect(inbox.parameters.map((x: { name: string }) => x.name)).toEqual(expect.arrayContaining(['limit', 'cursor']));
    expect(generated.paths['/auth/token']!.post.requestBody.content).toHaveProperty('application/x-www-form-urlencoded');
    expect(generated.paths['/users/me/avatar']!.post.requestBody.content).toHaveProperty('multipart/form-data');
  });
});
