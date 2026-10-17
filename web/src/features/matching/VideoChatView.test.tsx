import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '@/test/server';
import { FakeSocket, failAck, fakeMediaStream, okAck } from '@/test/fakes';
import { API, makeUser, ok, renderApp, signedIn, mockBaseApi } from '@/test/render';
import { AuthModal } from '@/features/auth/AuthModal';
import { VideoChatView } from './VideoChatView';
import type { PeerSession } from './peer';

const partner = { id: 'p1', name: 'Bella', username: 'bella', avatar: '', gender: 'female', country: 'Spain', countryCode: 'ES', age: 24, likesCount: 7, isVip: false };

function setup(user = makeUser(), opts: { signed?: boolean } = {}) {
  mockBaseApi();
  server.use(
    http.get(`${API}/webrtc/ice-servers`, () => ok({ iceServers: [{ urls: 'stun:x' }] })),
    http.get(`${API}/discover`, () => ok([])),
    http.get(`${API}/gifts`, () => ok([{ id: 'g1', name: 'Rose', price: 40, image: '/r.svg' }])),
  );
  if (opts.signed !== false) signedIn(user);
  const sock = new FakeSocket();
  sock.responders.join_queue = () => okAck({ status: 'waiting', applied: { gender: 'both', country: '', superMatch: false, filtersIgnored: false } });
  sock.responders.send_message = (p) => okAck({ message: { id: `m-${p.text}`, text: p.text } });
  const media = fakeMediaStream();
  const getUserMedia = vi.fn().mockResolvedValue(media.stream);
  const peers: { opts: Parameters<NonNullable<NonNullable<React.ComponentProps<typeof VideoChatView>['deps']>['createPeer']>>[0]; session: PeerSession; started: boolean; closed: boolean }[] = [];
  const createPeer = (o: (typeof peers)[number]['opts']) => {
    const rec = { opts: o, started: false, closed: false, session: undefined as unknown as PeerSession };
    rec.session = { start: async () => { rec.started = true; }, handle: vi.fn(async () => {}), close: () => { rec.closed = true; } } as unknown as PeerSession;
    peers.push(rec);
    return rec.session;
  };
  const view = renderApp(<><VideoChatView deps={{ getUserMedia, createPeer }} /><AuthModal /></>, { socketFactory: () => sock.asSocket() });
  return { sock, media, getUserMedia, peers, ...view };
}

const startChat = async (sock: FakeSocket) => {
  await userEvent.click(await screen.findByRole('button', { name: /start video chat/i }));
  await waitFor(() => expect(sock.count('join_queue')).toBe(1));
};
const match = (sock: FakeSocket, extra: Record<string, unknown> = {}) => act(() => sock.fire('match_found', { partner, peerId: 's2', initiator: true, ...extra }));

beforeEach(() => vi.useRealTimers());
afterEach(() => vi.restoreAllMocks());

describe('VideoChatView', () => {
  it('anonymous visitors are asked to sign in instead of starting', async () => {
    const { sock } = setup(makeUser(), { signed: false });
    await userEvent.click(await screen.findByRole('button', { name: /start video chat/i }));
    expect(await screen.findByRole('dialog')).toHaveAccessibleName(/sign in to start chatting/i);
    expect(sock.count('join_queue')).toBe(0);
  });

  it('start: asks for camera, loads ICE servers, joins the queue and shows the searching state', async () => {
    const { sock, getUserMedia } = setup();
    await startChat(sock);
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(sock.last('join_queue')).toEqual({ gender: 'both', superMatch: false });
    expect(await screen.findByRole('status')).toHaveTextContent(/looking for someone/i);
  });

  it('camera denied → friendly error and no queue join', async () => {
    mockBaseApi();
    signedIn();
    const sock = new FakeSocket();
    const denied = vi.fn().mockRejectedValue(Object.assign(new Error('x'), { name: 'NotAllowedError' }));
    renderApp(<VideoChatView deps={{ getUserMedia: denied }} />, { socketFactory: () => sock.asSocket() });
    server.use(http.get(`${API}/discover`, () => ok([])));
    await userEvent.click(await screen.findByRole('button', { name: /start video chat/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/camera and microphone access was denied/i);
    expect(sock.count('join_queue')).toBe(0);
  });

  it('match: shows the partner, builds a peer with the server-chosen role, relays signals only to it', async () => {
    const { sock, peers } = setup();
    await startChat(sock);
    await match(sock, { initiator: true });
    expect(await screen.findByText(/Bella, 24/)).toBeInTheDocument();
    expect(peers).toHaveLength(1);
    expect(peers[0]!.opts.initiator).toBe(true);
    expect(peers[0]!.opts.iceServers).toEqual([{ urls: 'stun:x' }]);
    expect(peers[0]!.started).toBe(true);

    peers[0]!.opts.send({ type: 'offer', sdp: { x: 1 } });
    expect(sock.last('signal')).toEqual({ signal: { type: 'offer', sdp: { x: 1 } } }); // no `to`: the server picks the peer
    act(() => sock.fire('signal', { from: 's2', signal: { type: 'answer', sdp: {} } }));
    expect(peers[0]!.session.handle).toHaveBeenCalledWith({ type: 'answer', sdp: {} });
  });

  it('chat: sends through the socket, shows own and partner messages, ignores messages from other people', async () => {
    const { sock } = setup();
    await startChat(sock);
    await match(sock);
    await userEvent.type(await screen.findByLabelText('Message'), 'hello there');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(sock.last('send_message')).toEqual({ text: 'hello there' });
    const log = screen.getByRole('log');
    expect(await within(log).findByText('hello there')).toBeInTheDocument();

    act(() => sock.fire('receive_message', { id: 'x1', from: 'p1', text: 'hi Alice' }));
    act(() => sock.fire('receive_message', { id: 'x2', from: 'stranger', text: 'spam from elsewhere' }));
    expect(await within(log).findByText('hi Alice')).toBeInTheDocument();
    expect(within(log).queryByText(/spam from elsewhere/)).not.toBeInTheDocument();
  });

  it('next: leaves the current partner and queues again; partner leaving re-queues automatically', async () => {
    const { sock, peers } = setup();
    await startChat(sock);
    await match(sock);
    await userEvent.click(await screen.findByRole('button', { name: /next person/i }));
    expect(sock.count('skip_match')).toBe(1);
    await waitFor(() => expect(sock.count('join_queue')).toBe(2));
    expect(peers[0]!.closed).toBe(true);

    await match(sock);
    act(() => sock.fire('partner_skipped', { reason: 'skipped' }));
    await waitFor(() => expect(sock.count('join_queue')).toBe(3));
    expect(await screen.findByRole('status')).toBeInTheDocument();
  });

  it('demo partner plays the profile video and creates no peer connection', async () => {
    const { sock, peers } = setup();
    await startChat(sock);
    await match(sock, { isDemo: true, videoUrl: '/videos/demo.mp4' });
    const video = await screen.findByLabelText(/video of bella/i);
    expect(video).toHaveAttribute('src', '/videos/demo.mp4');
    expect(peers).toHaveLength(0);
  });

  it('end call stops the camera, leaves the server and returns to the start screen', async () => {
    const { sock, media } = setup();
    await startChat(sock);
    await match(sock);
    await userEvent.click(await screen.findByRole('button', { name: /end call/i }));
    expect(sock.count('skip_match')).toBe(1);
    media.tracks.forEach((t) => expect(t.stop).toHaveBeenCalled());
    expect(await screen.findByRole('button', { name: /start video chat/i })).toBeInTheDocument();
  });

  it('mic/camera toggles flip the real tracks', async () => {
    const { sock, media } = setup();
    await startChat(sock);
    await userEvent.click(await screen.findByRole('button', { name: /mute microphone/i }));
    expect(media.tracks[0]!.enabled).toBe(false);
    expect(screen.getByRole('button', { name: /unmute microphone/i })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: /turn camera off/i }));
    expect(media.tracks[1]!.enabled).toBe(false);
  });

  it('non-VIP filters: the server says they were ignored and the UI offers the upgrade', async () => {
    const { sock } = setup();
    sock.responders.join_queue = () => okAck({ status: 'waiting', applied: { gender: 'both', country: '', superMatch: false, filtersIgnored: true } });
    await startChat(sock);
    expect(await screen.findByRole('button', { name: /filters need vip/i })).toBeInTheDocument();
  });

  it('gifts: sends through the socket, updates the balance, and routes to the shop when out of gems', async () => {
    const { sock } = setup(makeUser({ gems: 100 }));
    sock.responders.send_gift = () => okAck({ balance: 60, message: { id: 'gm1' }, gift: { name: 'Rose', image: '/r.svg', price: 40 } });
    await startChat(sock);
    await match(sock);
    await userEvent.click(await screen.findByRole('button', { name: /send a gift/i }));
    await userEvent.click(await screen.findByRole('button', { name: /rose, 40 gems/i }));
    await waitFor(() => expect(sock.last('send_gift')).toEqual({ giftId: 'g1' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    sock.responders.send_gift = () => failAck('insufficient_gems', 'Not enough gems');
    await userEvent.click(screen.getByRole('button', { name: /send a gift/i }));
    await userEvent.click(await screen.findByRole('button', { name: /rose, 40 gems/i }));
    await waitFor(() => expect(sock.count('send_gift')).toBe(2));
  });

  it('like and follow call the REST API for the matched partner', async () => {
    const { sock } = setup();
    const calls: string[] = [];
    server.use(
      http.put(`${API}/users/p1/like`, () => { calls.push('like'); return ok({ liked: true, likesCount: 8 }); }),
      http.put(`${API}/users/p1/follow`, () => { calls.push('follow'); return ok({ isFollowing: true, followersCount: 1, followingCount: 1 }); }),
    );
    await startChat(sock);
    await match(sock);
    await userEvent.click(await screen.findByRole('button', { name: 'Like' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /remove like/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Follow' }));
    await waitFor(() => expect(calls).toEqual(['like', 'follow']));
    expect(screen.getByLabelText(/8 likes/i)).toBeInTheDocument();
  });
});
