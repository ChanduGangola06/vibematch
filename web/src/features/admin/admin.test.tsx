import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { server } from '@/test/server';
import { API, mockBaseApi, ok, page, problem, renderApp, signedIn } from '@/test/render';
import AdminLayout from './AdminLayout';
import { ApiKeys } from './Operations';
import { SettingsGroup } from './Settings';
import Users from './Users';

const shell = (el: React.ReactElement, path = '/admin/x', route = path) => renderApp(
  <Routes><Route path="/admin" element={<AdminLayout />}><Route path={path.replace('/admin/', '')} element={el} /></Route></Routes>, { route });

const user = (over = {}) => ({ id: 'u2', username: 'bob', name: 'Bob', email: 'b@x.io', avatar: '', role: 'user', gems: 10, isVip: false, isBanned: false, isGuest: false, isDemo: false, createdAt: '2026-01-01T00:00:00.000Z', ...over });

describe('AdminLayout guard', () => {
  it('turns non-admins away without calling admin endpoints', async () => {
    mockBaseApi();
    signedIn();
    let hit = 0;
    server.use(http.get(`${API}/admin/mailbox/unread-count`, () => { hit++; return ok({ count: 0 }); }));
    shell(<p>secret</p>);
    expect(await screen.findByText(/administrators only/i)).toBeInTheDocument();
    expect(screen.queryByText('secret')).not.toBeInTheDocument();
    expect(hit).toBe(0);
  });
});

describe('Users', () => {
  it('searches server-side and bans after confirmation', async () => {
    mockBaseApi();
    signedIn({ role: 'admin' });
    let lastQuery = '';
    let banned = 0;
    server.use(
      http.get(`${API}/admin/mailbox/unread-count`, () => ok({ count: 3 })),
      http.get(`${API}/admin/users`, ({ request }) => { lastQuery = new URL(request.url).search; return page([user()], { page: 1, pageSize: 20, total: 1, totalPages: 1 }); }),
      http.post(`${API}/admin/users/u2/ban`, () => { banned++; return ok(user({ isBanned: true })); }),
    );
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    shell(<Users />, '/admin/users');
    expect(await screen.findByText('@bob', { exact: false })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Search users'), 'bo');
    await waitFor(() => expect(lastQuery).toContain('q=bo'));
    await userEvent.click(screen.getByRole('button', { name: 'Ban' }));
    await waitFor(() => expect(banned).toBe(1));
    expect(await screen.findByLabelText('3 unread')).toBeInTheDocument();
  });

  it('does not ban when the confirm is declined', async () => {
    mockBaseApi();
    signedIn({ role: 'admin' });
    let banned = 0;
    server.use(
      http.get(`${API}/admin/mailbox/unread-count`, () => ok({ count: 0 })),
      http.get(`${API}/admin/users`, () => page([user()], { page: 1, pageSize: 20, total: 1, totalPages: 1 })),
      http.post(`${API}/admin/users/u2/ban`, () => { banned++; return ok({}); }),
    );
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    shell(<Users />, '/admin/users');
    await userEvent.click(await screen.findByRole('button', { name: 'Ban' }));
    expect(banned).toBe(0);
  });
});

describe('ApiKeys', () => {
  it('shows the plaintext key once after creation', async () => {
    mockBaseApi();
    signedIn({ role: 'admin' });
    let body: unknown;
    server.use(
      http.get(`${API}/admin/mailbox/unread-count`, () => ok({ count: 0 })),
      http.get(`${API}/admin/api-keys`, () => page([], { page: 1, pageSize: 20, total: 0, totalPages: 1 })),
      http.post(`${API}/admin/api-keys`, async ({ request }) => { body = await request.json(); return ok({ id: 'k1', key: 'vm_mobile_abc_SECRET' }, { status: 201 }); }),
    );
    shell(<ApiKeys />, '/admin/api-keys');
    await userEvent.click(await screen.findByRole('button', { name: 'New key' }));
    await userEvent.type(screen.getByLabelText('Name'), 'Android');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByTestId('api-key-secret')).toHaveTextContent('vm_mobile_abc_SECRET');
    expect(body).toMatchObject({ name: 'Android', level: 'mobile' });
  });
});

describe('Settings group', () => {
  it('sends only the changed fields and never echoes an untouched secret', async () => {
    mockBaseApi();
    signedIn({ role: 'admin' });
    let body: unknown;
    server.use(
      http.get(`${API}/admin/mailbox/unread-count`, () => ok({ count: 0 })),
      http.get(`${API}/admin/settings`, () => ok([{ group: 'payments', secrets: ['stripeSecretKey'] }])),
      http.get(`${API}/admin/settings/payments`, () => ok({ currency: 'USD', stripeEnabled: true, stripeSecretKey: '••••abcd', _version: 3 })),
      http.get(`${API}/admin/settings/payments/revisions`, () => ok([{ version: 3, by: 'a', createdAt: '2026-01-01T00:00:00.000Z' }, { version: 2, by: 'a', createdAt: '2025-12-01T00:00:00.000Z' }])),
      http.put(`${API}/admin/settings/payments`, async ({ request }) => { body = await request.json(); return ok({ currency: 'EUR', stripeEnabled: true, stripeSecretKey: '••••abcd', _version: 4 }); }),
    );
    renderApp(<Routes><Route path="/admin" element={<AdminLayout />}><Route path="settings/:group" element={<SettingsGroup />} /></Route></Routes>, { route: '/admin/settings/payments' });
    const cur = await screen.findByLabelText('Currency');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    await userEvent.clear(cur);
    await userEvent.type(cur, 'EUR');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(body).toEqual({ currency: 'EUR' }));
    expect(await screen.findByText(/Currently set \(••••abcd\)/)).toBeInTheDocument();
  });

  it('surfaces validation errors from the server', async () => {
    mockBaseApi();
    signedIn({ role: 'admin' });
    server.use(
      http.get(`${API}/admin/mailbox/unread-count`, () => ok({ count: 0 })),
      http.get(`${API}/admin/settings`, () => ok([{ group: 'general', secrets: [] }])),
      http.get(`${API}/admin/settings/general`, () => ok({ siteName: 'X', _version: 1 })),
      http.get(`${API}/admin/settings/general/revisions`, () => ok([])),
      http.put(`${API}/admin/settings/general`, () => problem(422, 'validation_failed', { detail: 'siteName too long' })),
    );
    renderApp(<Routes><Route path="/admin" element={<AdminLayout />}><Route path="settings/:group" element={<SettingsGroup />} /></Route></Routes>, { route: '/admin/settings/general' });
    const f = await screen.findByLabelText('Site Name');
    await userEvent.type(f, 'Y');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(/siteName too long/)).toBeInTheDocument();
  });
});
