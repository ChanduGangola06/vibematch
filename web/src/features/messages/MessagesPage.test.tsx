import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { server } from '@/test/server';
import { FakeSocket } from '@/test/fakes';
import { API, makeUser, mockBaseApi, ok, page, problem, renderApp, signedIn } from '@/test/render';
import MessagesPage from './MessagesPage';

const partner = (id: string, name: string) => ({ id, username: name.toLowerCase(), name, avatar: '', gender: 'female', country: 'FR', countryCode: 'FR', bio: '', likesCount: 0, followersCount: 0, followingCount: 0, isOnline: false, isVip: false, isFollowing: true, isMutualFollow: true });
const conv = (id: string, name: string, text: string, unread = 0) => ({ partner: partner(id, name), lastMessage: { id: 'm', senderId: id, text, isGift: false }, lastMessageAt: new Date().toISOString(), unreadCount: unread });
const msg = (id: string, from: string, text: string, to = 'u1') => ({ id, senderId: from, receiverId: to, text, isRead: false, createdAt: new Date().toISOString() });

function base() {
  mockBaseApi();
  server.use(http.get(`${API}/conversations`, () => page([conv('p1', 'Bella', 'hey you', 2), conv('p2', 'Chloe', 'see you')])));
}

describe('MessagesPage', () => {
  it('asks anonymous visitors to sign in', async () => {
    base();
    renderApp(<MessagesPage />);
    expect(await screen.findByText(/sign in to see your messages/i)).toBeInTheDocument();
  });

  it('lists conversations with unread badges and opens a thread (oldest first), marking it read', async () => {
    base();
    signedIn();
    let read = 0;
    server.use(
      http.get(`${API}/conversations/p1/messages`, () => page([msg('m2', 'u1', 'second', 'p1'), msg('m1', 'p1', 'first')])),
      http.post(`${API}/conversations/p1/read`, () => { read++; return ok({ updated: 1 }); }),
    );
    renderApp(<MessagesPage />, { route: '/messages' });
    const row = await screen.findByRole('button', { name: /bella/i });
    expect(within(row).getByLabelText('2 unread')).toBeInTheDocument();
    await userEvent.click(row);
    const log = await screen.findByRole('log');
    await waitFor(() => expect(within(log).getAllByText(/first|second/).map((n) => n.textContent?.match(/first|second/)?.[0])).toEqual(['first', 'second']));
    await waitFor(() => expect(read).toBe(1));
  });

  it('sends a message with an Idempotency-Key and clears the input', async () => {
    base();
    signedIn();
    let key: string | null = null;
    let body: unknown;
    server.use(
      http.get(`${API}/conversations/p1/messages`, () => page([])),
      http.post(`${API}/conversations/p1/messages`, async ({ request }) => { key = request.headers.get('idempotency-key'); body = await request.json(); return ok(msg('new', 'u1', 'hello', 'p1'), { status: 201 }); }),
    );
    renderApp(<MessagesPage />, { route: '/messages?chat=p1' });
    const input = await screen.findByLabelText('Message');
    await userEvent.type(input, 'hello');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(body).toEqual({ text: 'hello' }));
    expect(key).toMatch(/^[\w-]{8,}$/);
    await waitFor(() => expect(input).toHaveValue(''));
  });

  it('explains the follow rule when the server refuses a stranger', async () => {
    base();
    signedIn();
    server.use(
      http.get(`${API}/conversations/p1/messages`, () => page([])),
      http.post(`${API}/conversations/p1/messages`, () => problem(403, 'chat_not_allowed')),
    );
    renderApp(<MessagesPage />, { route: '/messages?chat=p1' });
    await userEvent.type(await screen.findByLabelText('Message'), 'hi');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText(/once you both follow each other/i)).toBeInTheDocument();
  });

  it('pages older messages with the cursor', async () => {
    base();
    signedIn();
    server.use(http.get(`${API}/conversations/p1/messages`, ({ request }) => {
      const cursor = new URL(request.url).searchParams.get('cursor');
      return cursor ? page([msg('old', 'p1', 'ancient')]) : page([msg('new', 'p1', 'recent')], { limit: 30, hasMore: true, nextCursor: 'c1' });
    }));
    renderApp(<MessagesPage />, { route: '/messages?chat=p1' });
    await screen.findByText('recent');
    await userEvent.click(screen.getByRole('button', { name: /load earlier/i }));
    expect(await screen.findByText('ancient')).toBeInTheDocument();
  });

  it('a pushed message refreshes the inbox in real time', async () => {
    base();
    signedIn();
    const sock = new FakeSocket();
    let n = 0;
    server.use(http.get(`${API}/conversations`, () => page([conv('p1', 'Bella', n++ ? 'brand new message' : 'hey you')])));
    renderApp(<MessagesPage />, { socketFactory: () => sock.asSocket() });
    await screen.findByText('hey you');
    await waitFor(() => expect(sock.connected).toBe(true));
    act(() => sock.fire('new_message_notification', { senderId: 'p1', text: 'brand new message' }));
    expect(await screen.findByText('brand new message')).toBeInTheDocument();
  });

  it('clearing a chat confirms first', async () => {
    base();
    signedIn();
    let cleared = 0;
    server.use(http.get(`${API}/conversations/p1/messages`, () => page([])), http.delete(`${API}/conversations/p1`, () => { cleared++; return new Response(null, { status: 204 }); }));
    const confirm = vi.spyOn(window, 'confirm');
    renderApp(<MessagesPage />, { route: '/messages?chat=p1' });
    confirm.mockReturnValueOnce(false);
    await userEvent.click(await screen.findByRole('button', { name: /clear chat/i }));
    expect(cleared).toBe(0);
    confirm.mockReturnValueOnce(true);
    await userEvent.click(screen.getByRole('button', { name: /clear chat/i }));
    await waitFor(() => expect(cleared).toBe(1));
  });

  it('shows the empty state with a call to action', async () => {
    mockBaseApi();
    signedIn();
    server.use(http.get(`${API}/conversations`, () => page([])));
    renderApp(<MessagesPage />);
    expect(await screen.findByText(/no messages yet/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /meet someone new/i })).toHaveAttribute('href', '/');
    expect(makeUser().id).toBe('u1');
  });
});
