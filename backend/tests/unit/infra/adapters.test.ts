import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import nodemailer from 'nodemailer';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { NodemailerAdapter, renderTemplate } from '../../../src/infra/mail/index.js';
import { FcmPushAdapter, LazyPushAdapter, NullPushAdapter } from '../../../src/infra/push/index.js';
import { BunnyStorage, LocalStorage, S3Storage, assertSafeKey, createStorage } from '../../../src/infra/storage/index.js';

describe('mail adapter', () => {
  it('sends through the injected transport', async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true });
    const sendMail = vi.spyOn(transport, 'sendMail');
    const ok = await new NodemailerAdapter({ fromName: 'Vibe "Match"', fromEmail: 'no@x.io' }, transport).send({
      to: 'a@b.c', subject: 'Hi', html: '<p>x</p>',
    });
    expect(ok).toBe(true);
    expect(sendMail.mock.calls[0]![0]).toMatchObject({ from: '"Vibe Match" <no@x.io>', to: 'a@b.c' });
  });

  it('returns false and logs on transport failure', async () => {
    const error = vi.fn();
    const transport = { sendMail: vi.fn().mockRejectedValue(new Error('smtp down')) } as never;
    expect(await new NodemailerAdapter({ fromName: 'a', fromEmail: 'b@c.d' }, transport, { error }).send({ to: 'x@y.z', subject: 's', html: 'h' })).toBe(false);
    expect(error).toHaveBeenCalled();
  });

  it('escapes template variables (prevents HTML injection through usernames)', () => {
    expect(renderTemplate('Hi %nameuser%, %packname% / %unknown%', { nameuser: '<script>x</script>', packname: 'A&B' })).toBe(
      'Hi &lt;script&gt;x&lt;/script&gt;, A&amp;B / %unknown%',
    );
  });
});

describe('push adapter', () => {
  it('multicasts, de-duplicates tokens and reports invalid ones', async () => {
    const messaging = {
      sendEachForMulticast: vi.fn().mockResolvedValue({
        successCount: 1,
        responses: [{ success: true }, { success: false, error: { code: 'messaging/registration-token-not-registered' } }],
      }),
    };
    const res = await new FcmPushAdapter(messaging).send(['t1', 't2', 't1', ''], { title: 'T', body: 'B', data: { a: '1' } });
    expect(messaging.sendEachForMulticast.mock.calls[0]![0].tokens).toEqual(['t1', 't2']);
    expect(res).toEqual({ sent: 1, invalidTokens: ['t2'] });
    expect(await new FcmPushAdapter(messaging).send([], { title: 'T', body: 'B' })).toEqual({ sent: 0, invalidTokens: [] });
    expect(await new NullPushAdapter().send()).toEqual({ sent: 0, invalidTokens: [] });
  });

  it('lazy proxy builds the real adapter once', async () => {
    const factory = vi.fn(async () => new NullPushAdapter());
    const lazy = new LazyPushAdapter(factory);
    await lazy.send(['a'], { title: 't', body: 'b' });
    await lazy.send(['a'], { title: 't', body: 'b' });
    expect(factory).toHaveBeenCalledTimes(1);
  });
});

describe('storage strategies', () => {
  let dir: string;
  afterAll(async () => dir && (await rm(dir, { recursive: true, force: true })));

  it('LocalStorage writes, returns a public url, deletes, and blocks traversal', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vm-store-'));
    const s = new LocalStorage(dir, '/images');
    const obj = await s.put('users/a.png', Buffer.from('png'), 'image/png');
    expect(obj.url).toBe('/images/users/a.png');
    expect((await readFile(path.join(dir, 'users/a.png'))).toString()).toBe('png');
    await s.delete('users/a.png');
    await expect(stat(path.join(dir, 'users/a.png'))).rejects.toThrow();
    await s.delete('users/a.png'); // idempotent
    await expect(s.put('../evil.txt', Buffer.from('x'), 'text/plain')).rejects.toThrow(/Invalid storage key/);
    await expect(s.put('a/../../evil', Buffer.from('x'), 'text/plain')).rejects.toThrow();
    expect(() => assertSafeKey('/abs')).toThrow();
    expect(() => assertSafeKey('ok/file.png')).not.toThrow();
  });

  it('S3Storage sends Put/Delete commands and builds CDN urls', async () => {
    const send = vi.fn().mockResolvedValue({});
    const s = new S3Storage({ bucket: 'b', publicBaseUrl: 'https://cdn.x.io/', client: { send } });
    const obj = await s.put('gift/g.png', Buffer.from('x'), 'image/png');
    expect(obj.url).toBe('https://cdn.x.io/gift/g.png');
    await s.delete('gift/g.png');
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]![0].input).toMatchObject({ Bucket: 'b', Key: 'gift/g.png', ContentType: 'image/png' });
  });

  it('BunnyStorage uploads/deletes via HTTP with the access key', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 201 }));
    const s = new BunnyStorage({ storageZone: 'zone', accessKey: 'k', pullZoneUrl: 'https://pull.b-cdn.net' }, fetchImpl as never);
    const obj = await s.put('a.png', Buffer.from('x'), 'image/png');
    expect(obj.url).toBe('https://pull.b-cdn.net/a.png');
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://storage.bunnycdn.com/zone/a.png');
    expect(fetchImpl.mock.calls[0]![1].headers.AccessKey).toBe('k');
    fetchImpl.mockResolvedValueOnce(new Response('', { status: 404 }));
    await s.delete('a.png');
    fetchImpl.mockResolvedValueOnce(new Response('', { status: 500 }));
    await expect(s.delete('a.png')).rejects.toThrow();
    fetchImpl.mockResolvedValueOnce(new Response('', { status: 500 }));
    await expect(s.put('a.png', Buffer.from('x'), 'image/png')).rejects.toThrow();
  });

  it('factory selects the strategy from settings', () => {
    expect(createStorage({ type: 'local' }, '/tmp/x')).toBeInstanceOf(LocalStorage);
    expect(createStorage({ type: 's3', region: 'us-east-1', bucket: 'b', accessKey: 'a', secretKey: 's' }, '/tmp')).toBeInstanceOf(S3Storage);
    expect(createStorage({ type: 'bunny', storageZone: 'z', accessKey: 'a', pullZoneUrl: 'https://x' }, '/tmp')).toBeInstanceOf(BunnyStorage);
  });
});
