import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { server } from '@/test/server';
import { API, mockBaseApi, ok, problem, renderApp } from '@/test/render';
import CmsPage from './CmsPage';
import ContactPage from './ContactPage';

const withRoute = (el: React.ReactElement, path: string) => <Routes><Route path={path} element={el} /><Route path="*" element={<p>fallback</p>} /></Routes>;

describe('CmsPage', () => {
  it('renders the page title and html', async () => {
    mockBaseApi();
    server.use(http.get(`${API}/pages/terms`, () => ok({ title: 'Terms', slug: 'terms', content: '<p>Be kind</p>', updatedAt: '2026-01-01T00:00:00.000Z' })));
    renderApp(withRoute(<CmsPage />, '/:slug'), { route: '/terms' });
    expect(await screen.findByRole('heading', { name: 'Terms' })).toBeInTheDocument();
    expect(screen.getByText('Be kind')).toBeInTheDocument();
  });
  it('shows not-found for unknown slugs', async () => {
    mockBaseApi();
    server.use(http.get(`${API}/pages/nope`, () => problem(404, 'not_found')));
    renderApp(withRoute(<CmsPage />, '/:slug'), { route: '/nope' });
    expect(await screen.findByText(/page not found/i)).toBeInTheDocument();
  });
});

describe('ContactPage', () => {
  it('submits the message and shows thanks', async () => {
    mockBaseApi();
    let body: unknown;
    server.use(http.post(`${API}/contact`, async ({ request }) => { body = await request.json(); return new Response(null, { status: 204 }); }));
    renderApp(<ContactPage />);
    await userEvent.type(screen.getByLabelText('Name'), 'Sam');
    await userEvent.type(screen.getByLabelText('Email'), 'sam@example.com');
    await userEvent.type(screen.getByLabelText('Message'), 'Hello there');
    await userEvent.click(screen.getByRole('button', { name: /send message/i }));
    expect(await screen.findByText(/thank you/i)).toBeInTheDocument();
    expect(body).toEqual({ name: 'Sam', email: 'sam@example.com', message: 'Hello there' });
  });
  it('shows field errors from the server', async () => {
    mockBaseApi();
    server.use(http.post(`${API}/contact`, () => problem(422, 'validation_failed', { errors: [{ path: 'email', message: 'Invalid email' }] })));
    renderApp(<ContactPage />);
    await userEvent.type(screen.getByLabelText('Name'), 'Sam');
    await userEvent.type(screen.getByLabelText('Email'), 'sam@example.com');
    await userEvent.type(screen.getByLabelText('Message'), 'Hello there');
    await userEvent.click(screen.getByRole('button', { name: /send message/i }));
    await waitFor(() => expect(screen.getByText('Invalid email')).toBeInTheDocument());
  });
});
