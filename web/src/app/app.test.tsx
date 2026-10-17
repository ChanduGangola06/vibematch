import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { server } from '@/test/server';
import { API, mockBaseApi, ok, page, problem, renderApp, signedIn } from '@/test/render';
import { ErrorBoundary } from '@/shared/ui/ErrorBoundary';
import { routes } from './router';

const at = (path: string) => renderApp(<RouterProvider router={createMemoryRouter(routes, { initialEntries: [path] })} />, { memoryRouter: false });
const extras = () => server.use(
  http.get(`${API}/pages`, () => ok([{ title: 'Terms', slug: 'terms' }])),
  http.get(`${API}/discover`, () => ok([])),
  http.get(`${API}/notifications`, () => page([])),
  http.get(`${API}/notifications/unread-count`, () => ok({ count: 2 })),
);

describe('application shell', () => {
  it('home shows the header with sign-in for visitors and footer CMS links', async () => {
    mockBaseApi(); extras();
    at('/');
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/terms');
  });

  it('signed-in header shows the gem balance, opens the shop and the profile menu', async () => {
    mockBaseApi({ payments: { stripeEnabled: true } }); extras();
    signedIn({ gems: 321 });
    server.use(http.get(`${API}/packs`, () => ok([{ id: 'p', name: 'Starter', description: '', price: 1, gems: 10, popular: false }])));
    at('/');
    expect(await screen.findByTestId('gem-balance')).toHaveTextContent('321');
    await userEvent.click(screen.getByRole('button', { name: /open shop/i }));
    expect(await screen.findByRole('button', { name: /buy starter/i })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByRole('button', { name: /profile menu/i }));
    expect(within(await screen.findByRole('dialog')).getByRole('link', { name: /messages/i })).toBeInTheDocument();
  });

  it('unknown CMS slug renders the not-found page, and /install runs outside the shell', async () => {
    mockBaseApi(); extras();
    server.use(http.get(`${API}/pages/zzz`, () => problem(404, 'not_found')));
    at('/zzz');
    expect(await screen.findByText(/page not found/i)).toBeInTheDocument();
  });

  it('error boundary shows a fallback instead of a blank screen', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const Boom = () => { throw new Error('boom'); };
    renderApp(<ErrorBoundary><Boom /></ErrorBoundary>);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    spy.mockRestore();
  });
});

describe('install wizard', () => {
  const status = (installed: boolean) => http.get(`${API}/install/status`, () => ok({ installed, database: { connected: true, transactions: true } }));
  it('says so when already installed', async () => {
    mockBaseApi(); server.use(status(true));
    at('/install');
    expect(await screen.findByText(/already installed/i)).toBeInTheDocument();
  });
  it('submits the wizard and reports completion', async () => {
    mockBaseApi(); let body: Record<string, unknown> = {};
    server.use(status(false), http.post(`${API}/install/complete`, async ({ request }) => { body = (await request.json()) as Record<string, unknown>; return ok({ installed: true }, { status: 201 }); }));
    at('/install');
    await userEvent.type(await screen.findByLabelText('Admin email'), 'a@b.co');
    await userEvent.type(screen.getByLabelText('Admin password'), 'longenough1');
    await userEvent.click(screen.getByRole('button', { name: 'Install' }));
    expect(await screen.findByText(/installation complete/i)).toBeInTheDocument();
    expect(body).toMatchObject({ adminEmail: 'a@b.co', adminUsername: 'admin', siteName: 'VibeMatch' });
  });
  it('shows field errors', async () => {
    mockBaseApi();
    server.use(status(false), http.post(`${API}/install/complete`, () => problem(422, 'validation_failed', { errors: [{ path: 'adminPassword', message: 'Too weak' }] })));
    at('/install');
    await userEvent.type(await screen.findByLabelText('Admin email'), 'a@b.co');
    await userEvent.type(screen.getByLabelText('Admin password'), 'longenough1');
    await userEvent.click(screen.getByRole('button', { name: 'Install' }));
    await waitFor(() => expect(screen.getByText('Too weak')).toBeInTheDocument());
  });
});
