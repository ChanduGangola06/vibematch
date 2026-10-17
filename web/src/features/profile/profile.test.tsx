import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { server } from '@/test/server';
import { API, mockBaseApi, ok, problem, renderApp, signedIn } from '@/test/render';
import { EditProfileModal } from './EditProfileModal';
import ProfilePage from './ProfilePage';

const profile = (over = {}) => ({ id: 'p9', username: 'bella', name: 'Bella', avatar: '', gender: 'female', country: 'Spain', countryCode: 'ES', age: 24, bio: 'hi there', likesCount: 3, followersCount: 5, followingCount: 2, isOnline: true, isVip: false, isFollowing: false, isMutualFollow: false, ...over });
const at = (route: string) => renderApp(<Routes><Route path="/u/:username" element={<ProfilePage />} /></Routes>, { route });

describe('ProfilePage', () => {
  it('shows the profile, follows, and records a view', async () => {
    mockBaseApi();
    signedIn();
    let viewed = 0;
    server.use(
      http.get(`${API}/users/by-username/bella`, () => ok(profile())),
      http.post(`${API}/users/p9/views`, () => { viewed++; return new Response(null, { status: 204 }); }),
      http.put(`${API}/users/p9/follow`, () => ok({ isFollowing: true, followersCount: 6, followingCount: 2 })),
    );
    at('/u/bella');
    expect(await screen.findByRole('heading', { name: /bella/i })).toBeInTheDocument();
    await waitFor(() => expect(viewed).toBe(1));
    await userEvent.click(screen.getByRole('button', { name: 'Follow' }));
    expect(await screen.findByRole('button', { name: 'Unfollow' })).toBeInTheDocument();
  });

  it('offers editing on your own profile and no view is recorded', async () => {
    mockBaseApi();
    signedIn({ id: 'p9', username: 'bella' });
    let viewed = 0;
    server.use(http.get(`${API}/users/by-username/bella`, () => ok(profile())), http.post(`${API}/users/p9/views`, () => { viewed++; return new Response(null, { status: 204 }); }));
    at('/u/bella');
    expect(await screen.findByRole('button', { name: 'Edit profile' })).toBeInTheDocument();
    expect(viewed).toBe(0);
  });

  it('handles unknown users', async () => {
    mockBaseApi();
    server.use(http.get(`${API}/users/by-username/ghost`, () => problem(404, 'not_found')));
    at('/u/ghost');
    expect(await screen.findByText(/user not found/i)).toBeInTheDocument();
  });
});

describe('EditProfileModal', () => {
  it('saves changes with PATCH and shows server field errors', async () => {
    mockBaseApi();
    signedIn();
    let attempt = 0;
    let body: Record<string, unknown> = {};
    server.use(http.patch(`${API}/users/me`, async ({ request }) => {
      body = (await request.json()) as Record<string, unknown>;
      return attempt++ === 0 ? problem(422, 'validation_failed', { errors: [{ path: 'username', message: 'Username taken' }] }) : ok({ ...signedInUser(), name: 'Alice 2' });
    }));
    let closed = false;
    renderApp(<EditProfileModal open onClose={() => { closed = true; }} />);
    const name = await screen.findByLabelText('Name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Alice 2');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Username taken')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(closed).toBe(true));
    expect(body.name).toBe('Alice 2');
  });
});

import { makeUser } from '@/test/render';
const signedInUser = () => makeUser();
