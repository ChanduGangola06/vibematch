/**
 * Local MongoDB replica set for development without Docker (transactions need a replica set).
 * Data persists in .dev-data/db.   npm run dev:db
 */
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const port = Number(process.env.DEV_DB_PORT ?? 27017);
const rs = await MongoMemoryReplSet.create({
  replSet: { count: 1, storageEngine: 'wiredTiger' },
  instanceOpts: [{ port, dbPath: new URL('../.dev-data/db', import.meta.url).pathname, storageEngine: 'wiredTiger' }],
});
console.log(`MongoDB replica set ready: ${rs.getUri('vibematch')}`);
const stop = async () => { await rs.stop({ doCleanup: false }); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);
