/**
 * Boots the real server.ts against a throw-away in-memory MongoDB, probes it over HTTP, then
 * sends SIGTERM and checks for a clean exit. Run: `npm run smoke`.
 */
import { spawn } from 'node:child_process';
import { MongoMemoryServer } from 'mongodb-memory-server';

const mongo = await MongoMemoryServer.create();
const port = 3999;
const useDist = process.argv.includes('--dist');
const child = spawn(useDist ? 'node' : 'npx', useDist ? ['dist/server.js'] : ['tsx', 'src/server.ts'], {
  env: {
    ...process.env,
    NODE_ENV: 'development',
    PORT: String(port),
    MONGODB_URI: mongo.getUri('smoke'),
    JWT_SECRET: 'smoke-test-secret-smoke-test-secret-1234',
    LOG_LEVEL: 'info',
    LOG_FLUSH_MS: '100',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
child.stdout.on('data', (d) => (out += d));
child.stderr.on('data', (d) => (out += d));

const base = `http://127.0.0.1:${port}`;
async function waitUp() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${base}/health/live`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server did not start\n${out}`);
}

let failed = false;
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`);
  if (!ok) failed = true;
};

try {
  await waitUp();
  const ready = await fetch(`${base}/health/ready`);
  const rb = (await ready.json()) as { data: { status: string; checks: { name: string; ok: boolean }[] } };
  check('readiness 200 with mongo ok', ready.status === 200 && rb.data.checks.some((c) => c.name === 'mongo' && c.ok));
  const nf = await fetch(`${base}/api/v1/does-not-exist`);
  check('404 is problem+json', nf.status === 404 && (nf.headers.get('content-type') ?? '').includes('problem+json'));
  const m = await fetch(`${base}/metrics`);
  check('metrics needs a key', m.status === 401);
  check('security headers', nf.headers.get('x-content-type-options') === 'nosniff' && !nf.headers.get('x-powered-by'));
} catch (e) {
  console.error(e);
  failed = true;
}

const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
child.kill('SIGTERM');
const code = await Promise.race([exited, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 15000))]);
check('graceful shutdown exit code 0', code === 0, `(got ${String(code)})`);
if (code === 'timeout') child.kill('SIGKILL');
await mongo.stop();
if (failed) console.log(out);
process.exit(failed ? 1 : 0);
