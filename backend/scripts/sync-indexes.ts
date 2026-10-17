import { getEnv } from '../src/config/env.js';
import { connectDb, disconnectDb } from '../src/infra/db/connection.js';
import { syncIndexes } from '../src/infra/db/models/index.js';

const env = getEnv();
await connectDb(env);
await syncIndexes();
console.log('indexes synchronised');
await disconnectDb();
