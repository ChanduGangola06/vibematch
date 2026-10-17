/**
 * Copies a VibeMatch v1 database into a v2 database.
 *
 *   npx tsx scripts/migrate-legacy.ts --source mongodb://…/vibematch --target mongodb://…/vibematch_v2          # dry run
 *   npx tsx scripts/migrate-legacy.ts --source … --target … --apply                                              # write
 *
 * The source is only read. The target must be a different database (v1 and v2 both use a `settings`
 * collection with incompatible shapes). Safe to re-run: rows are upserted by their natural id.
 */
import mongoose from 'mongoose';
import { SecretBox } from '../src/core/security/crypto.js';
import { syncIndexes } from '../src/infra/db/models/index.js';
import { migrateLegacy } from '../src/migration/legacy.js';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
const flag = (name: string) => process.argv.includes(`--${name}`);

const source = arg('source') ?? process.env.LEGACY_MONGODB_URI;
const target = arg('target') ?? process.env.MONGODB_URI;
if (!source || !target) {
  console.error('Usage: migrate-legacy --source <v1 mongodb uri> --target <v2 mongodb uri> [--apply] [--keep-demo-admin]');
  process.exit(2);
}

const srcConn = await mongoose.createConnection(source).asPromise();
await mongoose.connect(target);
if (srcConn.name === mongoose.connection.name && srcConn.host === mongoose.connection.host) {
  console.error('Source and target are the same database. Use a new database for v2.');
  process.exit(2);
}

const key = process.env.SETTINGS_ENCRYPTION_KEY;
if (flag('apply')) await syncIndexes();

const report = await migrateLegacy({
  source: srcConn.db!,
  apply: flag('apply'),
  secretBox: key ? new SecretBox(key) : undefined,
  keepDemoAdmin: flag('keep-demo-admin'),
});

console.log(flag('apply') ? '\nMigration APPLIED' : '\nDRY RUN (nothing written). Re-run with --apply to write.');
console.table(report.counts);
if (report.warnings.length) console.log(`\nWarnings (${report.warnings.length}):\n - ${report.warnings.join('\n - ')}`);
if (flag('apply') && !key) console.log('\nNOTE: SETTINGS_ENCRYPTION_KEY is not set — migrated secrets were stored unencrypted. Set the key and re-save them in Admin → Settings.');

await srcConn.close();
await mongoose.disconnect();
