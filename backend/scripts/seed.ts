/**
 * Development seed: gem packs, VIP plans, gifts (from the bundled artwork), demo profiles and the default language.
 *   npx tsx scripts/seed.ts
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import { getEnv } from '../src/config/env.js';
import { connectDb } from '../src/infra/db/connection.js';
import { GiftModel, PackModel, VipPlanModel } from '../src/infra/db/models/commerce.js';
import { LanguageModel } from '../src/infra/db/models/content.js';
import { syncIndexes } from '../src/infra/db/models/index.js';
import { UserModel } from '../src/infra/db/models/user.js';

await connectDb(getEnv());
await syncIndexes();

const packs = [
  { name: 'Starter', price: 0.99, gems: 100 }, { name: 'Popular', price: 4.99, gems: 600, popular: true },
  { name: 'Mega', price: 9.99, gems: 1400 }, { name: 'Ultimate', price: 24.99, gems: 4000 },
];
for (const p of packs) await PackModel.updateOne({ name: p.name }, { $setOnInsert: p }, { upsert: true });
for (const v of [{ name: 'Weekly VIP', priceGems: 300, durationDays: 7 }, { name: 'Monthly VIP', priceGems: 1000, durationDays: 30, popular: true }]) {
  await VipPlanModel.updateOne({ name: v.name }, { $setOnInsert: v }, { upsert: true });
}

const giftDir = path.resolve(import.meta.dirname, '../public/images/gift');
let gifts = 0;
try {
  const seen = new Set<string>();
  for (const file of readdirSync(giftDir).filter((f) => f.endsWith('.svg'))) {
    const name = file.replace(/_\d+\.svg$/, '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    if (seen.has(name)) continue;
    seen.add(name);
    await GiftModel.updateOne({ name }, { $setOnInsert: { name, price: 10 + (seen.size % 8) * 10, imagePath: `/images/gift/${file}` } }, { upsert: true });
    gifts++;
  }
} catch { /* artwork folder not present */ }

const demos = [
  ['Abigail', 'female', 22, 'United States', 'US'], ['Lily', 'female', 28, 'United Kingdom', 'GB'], ['Emma', 'female', 24, 'Canada', 'CA'],
  ['Sophie', 'female', 26, 'France', 'FR'], ['Lucas', 'male', 27, 'Brazil', 'BR'], ['Noah', 'male', 25, 'Germany', 'DE'],
] as const;
for (const [i, [name, gender, age, country, countryCode]] of demos.entries()) {
  const id = `demo_seed_${i + 1}`;
  await UserModel.updateOne({ id }, { $setOnInsert: { id, username: id, usernameLower: id, name, gender, age, country, countryCode, isDemo: true, isOnline: true, avatar: `/images/avatars/${gender}-${i + 1}.svg`, likesCount: 100 * (i + 1) } }, { upsert: true });
}
await LanguageModel.updateOne({ code: 'en' }, { $setOnInsert: { code: 'en', name: 'English', flag: 'us.svg', rtl: false, translations: {} } }, { upsert: true });

console.log(`seeded: ${packs.length} packs, 2 VIP plans, ${gifts} gifts, ${demos.length} demo profiles`);
await mongoose.disconnect();
