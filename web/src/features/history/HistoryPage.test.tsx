import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '@/test/server';
import { API, mockBaseApi, ok, page, renderApp, signedIn } from '@/test/render';
import HistoryPage from './HistoryPage';

const entry = (id: string, over: Record<string, unknown> = {}, p: Record<string, unknown> = {}) => ({
  id, type: 'video_chat', durationSec: 125, createdAt: new Date().toISOString(),
  partner: { id: `p-${id}`, name: 'Bella', username: 'bella', avatar: '', country: 'Spain', age: 24, isFollowing: false, isMutualFollow: false, exists: true, ...p }, ...over,
});

describe('HistoryPage', () => {
  it('prompts anonymous users to sign in', async () => {
    mockBaseApi();
    renderApp(<HistoryPage />);
    expect(await screen.findByText(/sign in to see your history/i)).toBeInTheDocument();
  });

  it('lists past calls with duration and lets you follow back', async () => {
    mockBaseApi();
    signedIn();
    let followed = '';
    server.use(
      http.get(`${API}/matches`, () => page([entry('1')])),
      http.put(`${API}/users/:id/follow`, ({ params }) => { followed = String(params.id); return ok({ isFollowing: true, followersCount: 1, followingCount: 1 }); }),
    );
    renderApp(<HistoryPage />);
    expect(await screen.findByText(/Bella, 24/)).toBeInTheDocument();
    expect(screen.getByText(/2m 05s/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Follow' }));
    await waitFor(() => expect(followed).toBe('p-1'));
    expect(await screen.findByRole('button', { name: 'Unfollow' })).toBeInTheDocument();
  });

  it('switches to "viewed me" and renders deleted users gracefully', async () => {
    mockBaseApi();
    signedIn();
    server.use(
      http.get(`${API}/matches`, () => page([])),
      http.get(`${API}/matches/viewed-me`, () => page([entry('v1', { type: 'view', durationSec: 0 }, { exists: false, name: 'Deleted user' })])),
    );
    renderApp(<HistoryPage />);
    expect(await screen.findByText(/no video chats yet/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: /viewed me/i }));
    expect(await screen.findByText('Deleted user')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /deleted/i })).not.toBeInTheDocument();
  });
});
