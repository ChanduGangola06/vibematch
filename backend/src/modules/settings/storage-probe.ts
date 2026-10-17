import { randomBytes } from 'node:crypto';
import { AppError } from '../../core/errors/index.js';
import type { StorageProvider } from '../users/user.service.js';

/**
 * Real connectivity test (v1 only checked that the fields were filled in and slept 1.5 s):
 * uploads a tiny object, then deletes it. Failure reasons are returned without leaking credentials.
 */
export async function settingsStorageProbe(provider: StorageProvider): Promise<{ ok: true; url: string }> {
  const store = await provider.get();
  const key = `probe/${randomBytes(6).toString('hex')}.txt`;
  try {
    const stored = await store.put(key, Buffer.from('vibematch storage probe'), 'text/plain');
    await store.delete(key);
    return { ok: true, url: stored.url };
  } catch (err) {
    throw new AppError(400, 'storage_test_failed', 'Storage test failed', { detail: `Could not write to the configured storage: ${(err as Error).message}`.slice(0, 300) });
  }
}
