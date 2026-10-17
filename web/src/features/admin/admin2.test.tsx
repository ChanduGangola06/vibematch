import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { server } from '@/test/server';
import { API, mockBaseApi, ok, page, renderApp, signedIn } from '@/test/render';
import AdminLayout from './AdminLayout';
import { DemoUsers, Gifts, Packs } from './Catalog';
import Languages from './Languages';
import { Mailbox, Reports } from './Moderation';
import { AuditLog, Backup, Purchases } from './Operations';
import Overview from './Overview';

const meta = { page: 1, pageSize: 20, total: 1, totalPages: 1 };
function mount(el: React.ReactElement, name: string, ...handlers: Parameters<typeof server.use>) {
  mockBaseApi(); signedIn({ role: 'admin' });
  server.use(http.get(`${API}/admin/mailbox/unread-count`, () => ok({ count: 0 })), ...handlers);
  return renderApp(<Routes><Route path="/admin" element={<AdminLayout />}><Route path={name} element={el} /></Route></Routes>, { route: `/admin/${name}` });
}

describe('admin pages', () => {
  it('overview shows metrics and re-queries on period change', async () => {
    const periods: string[] = [];
    server.use(http.get(`${API}/admin/metrics`, ({ request }) => { periods.push(new URL(request.url).searchParams.get('period')!); return ok({ period: 'x', newUsers: 5, totalUsers: 100, videoChats: 7, messagesSent: 1, giftsSent: 2, gemsSpentOnGifts: 3, activeVips: 4, purchases: 6, revenue: [{ currency: 'USD', amount: 12.5 }] }); }));
    mount(<Overview />, 'x');
    expect(await screen.findByText('$12.50')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Period'), 'today');
    await waitFor(() => expect(periods).toContain('today'));
  });

  it('reports can be resolved', async () => {
    let patched: unknown;
    server.use(
      http.get(`${API}/admin/reports`, () => page([{ id: 'r1', reason: 'spam', details: 'rude', status: 'pending', createdAt: '2026-01-01T00:00:00Z', reporter: { id: 'a', name: 'Ann', avatar: '', isBanned: false, exists: true, username: 'ann' }, reported: { id: 'b', name: 'Ben', avatar: '', isBanned: false, exists: true, username: 'ben' } }], meta)),
      http.patch(`${API}/admin/reports/r1`, async ({ request }) => { patched = await request.json(); return ok({}); }),
    );
    mount(<Reports />, 'reports');
    await userEvent.click(await screen.findByRole('button', { name: 'Resolve' }));
    await waitFor(() => expect(patched).toEqual({ status: 'resolved' }));
  });

  it('mailbox marks messages read', async () => {
    let patched: unknown;
    server.use(
      http.get(`${API}/admin/mailbox`, () => page([{ id: 'm1', name: 'Zed', email: 'z@x.io', message: 'hi team', status: 'unread', createdAt: '2026-01-01T00:00:00Z' }], meta)),
      http.patch(`${API}/admin/mailbox/m1`, async ({ request }) => { patched = await request.json(); return ok({}); }),
    );
    mount(<Mailbox />, 'mailbox');
    await userEvent.click(await screen.findByRole('button', { name: 'Mark read' }));
    await waitFor(() => expect(patched).toEqual({ status: 'read' }));
  });

  it('purchases and audit log render rows', async () => {
    server.use(
      http.get(`${API}/admin/purchases`, () => page([{ id: 'p', provider: 'stripe', packName: 'Starter', gems: 10, amount: 1, currency: 'USD', status: 'completed', createdAt: '2026-01-01T00:00:00Z' }], meta)),
      http.get(`${API}/admin/audit-log`, () => page([{ id: 'a', actorName: 'root', actorId: 'x', action: 'user.ban', target: 'u1', meta: { a: 1 }, ip: '1.1.1.1', createdAt: '2026-01-01T00:00:00Z' }], meta)),
    );
    const { unmount } = mount(<Purchases />, 'purchases');
    expect(await screen.findByText('Starter (10)')).toBeInTheDocument();
    unmount();
    mount(<AuditLog />, 'audit');
    expect(await screen.findByText('user.ban')).toBeInTheDocument();
  });

  it('gifts are created with multipart form data', async () => {
    let ct = '';
    server.use(
      http.get(`${API}/admin/gifts`, () => ok([])),
      http.post(`${API}/admin/gifts`, async ({ request }) => { ct = request.headers.get('content-type') ?? ''; const f = await request.formData(); expect(f.get('name')).toBe('Rose'); return ok({ id: 'g' }, { status: 201 }); }),
    );
    mount(<Gifts />, 'gifts');
    await userEvent.click(await screen.findByRole('button', { name: 'Add gift' }));
    await userEvent.type(screen.getByLabelText('Name'), 'Rose');
    await userEvent.type(screen.getByLabelText('Price (gems)'), '5');
    await userEvent.upload(screen.getByLabelText('Image'), new File([new Uint8Array([1, 2, 3])], 'r.png', { type: 'image/png' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(ct).toContain('multipart/form-data'));
  });

  it('packs and demo users list and delete with confirmation', async () => {
    let deleted = 0;
    server.use(
      http.get(`${API}/admin/packs`, () => ok([{ id: 'k', name: 'Big', gems: 500, price: 9, popular: true }])),
      http.delete(`${API}/admin/packs/k`, () => { deleted++; return new Response(null, { status: 204 }); }),
      http.get(`${API}/admin/demo-users`, () => page([{ id: 'd', name: 'Demo Dan', country: 'US', isOnline: true, videoUrl: 'x' }], meta)),
    );
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { unmount } = mount(<Packs />, 'packs');
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleted).toBe(1));
    unmount();
    mount(<DemoUsers />, 'demo');
    expect(await screen.findByText('Demo Dan')).toBeInTheDocument();
  });

  it('languages list and edit translations JSON', async () => {
    let body: unknown;
    const handlers = [
      http.get(`${API}/languages`, () => ok([{ code: 'en', name: 'English', flag: 'us.svg', rtl: false }, { code: 'ar', name: 'Arabic', flag: 'sa.svg', rtl: true }])),
      http.get(`${API}/languages/ar`, () => ok({ code: 'ar', name: 'Arabic', flag: 'sa.svg', rtl: true, translations: { Hello: 'مرحبا' } })),
      http.put(`${API}/admin/languages/ar`, async ({ request }) => { body = await request.json(); return ok({}); }),
    ];
    mount(<Languages />, 'languages', ...handlers);
    const row = (await screen.findByText('Arabic')).closest('li')!;
    await userEvent.click(row.querySelector('button')!);
    expect(await screen.findByDisplayValue(/مرحبا/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(body).toMatchObject({ rtl: true, translations: { Hello: 'مرحبا' } }));
  });

  it('backup restore needs the RESTORE confirmation outside dry-run', async () => {
    mount(<Backup />, 'backup');
    await userEvent.upload(await screen.findByLabelText('Backup file'), new File(['{}'], 'b.ndjson'));
    await userEvent.selectOptions(screen.getByLabelText('Mode'), 'replace');
    expect(screen.getByRole('button', { name: 'Restore' })).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Type RESTORE to confirm'), 'RESTORE');
    expect(screen.getByRole('button', { name: 'Restore' })).toBeEnabled();
  });
});
