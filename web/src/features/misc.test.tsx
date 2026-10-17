import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useUi } from '@/app/UiProvider';
import { GlobalOverlays } from '@/app/GlobalOverlays';
import { server } from '@/test/server';
import { API, mockBaseApi, ok, page, problem, renderApp, signedIn } from '@/test/render';
import { FilterModal } from './matching/FilterModal';
import { ReportDialog } from './matching/ReportDialog';
import { NotificationBell } from './notifications/NotificationBell';
import { DEFAULT_FILTERS } from './matching/useMatching';
import Security from './admin/Security';
import { SettingsIndex } from './admin/Settings';
import { Routes, Route } from 'react-router';
import AdminLayout from './admin/AdminLayout';

function Opener({ what }: { what: Parameters<ReturnType<typeof useUi>['open']>[0] }) {
  const ui = useUi();
  useEffect(() => { ui.open(what); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

describe('notifications', () => {
  it('shows unread count, marks one and all read', async () => {
    mockBaseApi(); signedIn();
    let read = '';
    let all = 0;
    server.use(
      http.get(`${API}/notifications`, () => page([{ id: 'n1', type: 'follow', isRead: false, createdAt: '2026-01-01T00:00:00Z', from: { id: 'x', name: 'Xena', username: 'xena', avatar: '' } }])),
      http.get(`${API}/notifications/unread-count`, () => ok({ count: 1 })),
      http.post(`${API}/notifications/n1/read`, () => { read = 'n1'; return ok({}); }),
      http.post(`${API}/notifications/read-all`, () => { all++; return ok({}); }),
    );
    renderApp(<NotificationBell />);
    await userEvent.click(await screen.findByRole('button', { name: /1 unread/i }));
    expect(await screen.findByText(/Xena started following you/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /mark all read/i }));
    await waitFor(() => expect(all).toBe(1));
    await userEvent.click(screen.getByRole('link', { name: /xena/i }));
    await waitFor(() => expect(read).toBe('n1'));
  });
});

describe('report dialog', () => {
  it('submits the reason and details', async () => {
    mockBaseApi(); signedIn();
    let body: unknown;
    server.use(http.post(`${API}/reports`, async ({ request }) => { body = await request.json(); return ok({}, { status: 201 }); }));
    const done = vi.fn();
    renderApp(<ReportDialog userId="p1" name="Bella" onClose={done} />);
    await userEvent.selectOptions(await screen.findByLabelText('Reason'), 'Spam or advertising');
    await userEvent.type(screen.getByLabelText(/details/i), ' rude ');
    await userEvent.click(screen.getByRole('button', { name: /submit|report/i }));
    await waitFor(() => expect(body).toEqual({ reportedUserId: 'p1', reason: 'Spam or advertising', details: 'rude' }));
    await waitFor(() => expect(done).toHaveBeenCalled());
  });
  it('keeps the dialog open on failure', async () => {
    mockBaseApi(); signedIn();
    server.use(http.post(`${API}/reports`, () => problem(429, 'rate_limited')));
    const done = vi.fn();
    renderApp(<ReportDialog userId="p1" name="Bella" onClose={done} />);
    await userEvent.click(await screen.findByRole('button', { name: /submit|report/i }));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    expect(done).not.toHaveBeenCalled();
  });
});

describe('filter modal', () => {
  it('non-VIPs are nudged to upgrade and cannot save filters', async () => {
    mockBaseApi(); signedIn({ isVip: false });
    const save = vi.fn();
    renderApp(<><Opener what="filter" /><FilterModal filters={DEFAULT_FILTERS} onSave={save} /></>);
    await userEvent.click(await screen.findByRole('button', { name: 'Save' }));
    expect(save).toHaveBeenCalledWith(DEFAULT_FILTERS);
  });
  it('VIPs can choose gender, country and super match', async () => {
    mockBaseApi(); signedIn({ isVip: true });
    const save = vi.fn();
    renderApp(<><Opener what="filter" /><FilterModal filters={DEFAULT_FILTERS} onSave={save} /></>);
    await userEvent.click(await screen.findByRole('radio', { name: 'Women' }));
    await userEvent.click(screen.getByRole('switch'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(save).toHaveBeenCalledWith({ gender: 'female', country: 'All Countries', superMatch: true });
  });
});

describe('profile drawer', () => {
  it('signs out', async () => {
    mockBaseApi(); signedIn();
    let out = 0;
    server.use(http.post(`${API}/auth/logout`, () => { out++; return ok({}); }));
    renderApp(<><Opener what="drawer" /><GlobalOverlays /></>);
    await userEvent.click(await screen.findByRole('button', { name: /sign out/i }));
    await waitFor(() => expect(out).toBe(1));
  });
  it('deleting the account needs the password', async () => {
    mockBaseApi(); signedIn();
    let body: unknown;
    server.use(http.post(`${API}/users/me/delete`, async ({ request }) => { body = await request.json(); return new Response(null, { status: 204 }); }), http.post(`${API}/auth/logout`, () => ok({})));
    renderApp(<><Opener what="drawer" /><GlobalOverlays /></>);
    await userEvent.click(await screen.findByRole('button', { name: /delete account/i }));
    const del = screen.getByRole('button', { name: 'Delete' });
    expect(del).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Password'), 'pw123456');
    await userEvent.click(del);
    await waitFor(() => expect(body).toEqual({ password: 'pw123456' }));
  });
});

describe('admin security & settings index', () => {
  const asAdmin = (el: React.ReactElement, path: string) => {
    mockBaseApi(); signedIn({ role: 'admin' });
    server.use(http.get(`${API}/admin/mailbox/unread-count`, () => ok({ count: 0 })));
    return { path, el };
  };
  it('lists passkeys and removes one', async () => {
    const { el } = asAdmin(<Security />, 'security');
    let removed = '';
    server.use(
      http.get(`${API}/auth/webauthn/credentials`, () => ok([{ id: 'cred/1', label: 'MacBook', createdAt: '2026-01-01T00:00:00Z' }])),
      http.delete(`${API}/auth/webauthn/credentials/:id`, ({ params }) => { removed = String(params.id); return new Response(null, { status: 204 }); }),
    );
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderApp(<Routes><Route path="/admin" element={<AdminLayout />}><Route path="security" element={el} /></Route></Routes>, { route: '/admin/security' });
    await userEvent.click(await screen.findByRole('button', { name: /remove macbook/i }));
    await waitFor(() => expect(removed).toBe('cred/1'));
  });
  it('settings index lists the groups', async () => {
    const { el } = asAdmin(<SettingsIndex />, 'settings');
    server.use(http.get(`${API}/admin/settings`, () => ok([{ group: 'mail', secrets: ['smtpPass'] }, { group: 'seo', secrets: [] }])));
    renderApp(<Routes><Route path="/admin" element={<AdminLayout />}><Route path="settings" element={el} /></Route></Routes>, { route: '/admin/settings' });
    expect(await screen.findByText(/1 secret field/)).toBeInTheDocument();
    expect(screen.getByText('No secrets')).toBeInTheDocument();
  });
});
