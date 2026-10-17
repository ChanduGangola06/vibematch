import { createHash } from 'node:crypto';
import type { Cache } from './cache.js';

export interface CachedMethodSpec {
  /** Seconds. */
  ttl: number;
  /** Tags attached to every entry produced by this method (used for invalidation). */
  tags: string[];
}

type AsyncFn = (...args: never[]) => Promise<unknown>;

/**
 * Decorator: wraps the listed *read* methods of a repository with cache-aside behaviour while
 * leaving every other method untouched. Keys are derived from method name + arguments.
 *
 *   const repo = cachedRepository(rawRepo, cache, 'packs', { list: { ttl: 300, tags: ['packs'] } });
 *   await repo.invalidate('packs');   // call after writes / on the matching domain event
 */
export function cachedRepository<R extends object, K extends keyof R & string>(
  repo: R,
  cache: Cache,
  namespace: string,
  specs: { [P in K]: CachedMethodSpec },
): R & { invalidate(...tags: string[]): Promise<void> } {
  const keyOf = (method: string, args: unknown[]): string => {
    const digest = args.length ? createHash('sha1').update(JSON.stringify(args)).digest('hex').slice(0, 16) : '_';
    return `${namespace}:${method}:${digest}`;
  };

  return new Proxy(repo, {
    get(target, prop, receiver) {
      if (prop === 'invalidate') {
        return async (...tags: string[]) => {
          for (const t of tags) await cache.invalidateTag(t);
        };
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      const spec = typeof prop === 'string' ? (specs as Record<string, CachedMethodSpec | undefined>)[prop] : undefined;
      if (spec && typeof value === 'function') {
        return (...args: unknown[]) =>
          cache.wrap(
            keyOf(prop as string, args),
            () => (value as AsyncFn).apply(target, args as never[]) as Promise<unknown>,
            spec,
          );
      }
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as R & { invalidate(...tags: string[]): Promise<void> };
}
