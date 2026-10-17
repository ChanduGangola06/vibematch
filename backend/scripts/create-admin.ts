/**
 * Creates (or promotes) an administrator without the web installer:
 *   ADMIN_PASSWORD='…' npx tsx scripts/create-admin.ts --username boss --email boss@example.com
 */
import mongoose from 'mongoose';
import { getEnv } from '../src/config/env.js';
import { hashPassword } from '../src/core/security/index.js';
import { connectDb } from '../src/infra/db/connection.js';
import { UserModel } from '../src/infra/db/models/user.js';
import { emailSchema, passwordSchema, usernameSchema } from '../src/modules/users/user.schemas.js';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};

const username = usernameSchema.parse(arg('username'));
const email = emailSchema.parse(arg('email'));
const password = passwordSchema.parse(process.env.ADMIN_PASSWORD); // via env so it never lands in shell history

const env = getEnv();
await connectDb(env);
const hash = await hashPassword(password, env.BCRYPT_COST);
const res = await UserModel.updateOne(
  { usernameLower: username },
  { $set: { role: 'admin', passwordHash: hash, email, emailLower: email, isBanned: false }, $setOnInsert: { username, usernameLower: username, name: username, avatar: '/images/avatars/male-1.svg', gems: 0 } },
  { upsert: true },
);
console.log(res.upsertedCount ? `created admin "${username}"` : `promoted/updated "${username}" to admin`);
await mongoose.disconnect();
