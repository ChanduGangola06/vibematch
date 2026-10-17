import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

let replSet: MongoMemoryReplSet | undefined;

/**
 * Starts a single-node replica set (so transactions work like production) and connects mongoose.
 * Call once per test file in `beforeAll`.
 */
export async function startTestDb(): Promise<string> {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  const uri = replSet.getUri('vibematch-test');
  await mongoose.connect(uri);
  return uri;
}

export async function clearTestDb(): Promise<void> {
  const collections = await mongoose.connection.db!.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
}

export async function stopTestDb(): Promise<void> {
  await mongoose.disconnect();
  await replSet?.stop();
  replSet = undefined;
}

/** Counts MongoDB operations issued by `fn` — used to prove endpoints have no N+1 behaviour. */
export async function countDbOps(fn: () => Promise<unknown>): Promise<number> {
  let n = 0;
  mongoose.set('debug', () => {
    n++;
  });
  try {
    await fn();
  } finally {
    mongoose.set('debug', false);
  }
  return n;
}
