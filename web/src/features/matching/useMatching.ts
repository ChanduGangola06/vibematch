import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { useSession } from '@/features/session/SessionProvider';
import { client, unwrap } from '@/shared/api/client';
import { emitAck, useSocket } from '@/shared/socket/SocketProvider';
import { PeerSession, type PeerOptions, type Signal } from './peer';

export type Phase = 'idle' | 'starting' | 'searching' | 'connected';

export interface Filters {
  gender: 'both' | 'male' | 'female';
  country: string;
  superMatch: boolean;
}
export const DEFAULT_FILTERS: Filters = { gender: 'both', country: 'All Countries', superMatch: false };

export interface Partner {
  id: string;
  name: string;
  username: string;
  avatar: string;
  gender: string;
  country: string;
  countryCode: string;
  age?: number;
  likesCount: number;
  isVip: boolean;
}

export interface ChatMsg {
  id: string;
  mine: boolean;
  text: string;
  gift?: { name: string; image: string; cost: number } | undefined;
}

interface State {
  phase: Phase;
  partner: Partner | null;
  isDemo: boolean;
  videoUrl: string | null;
  messages: ChatMsg[];
  error: string | null;
  liked: boolean;
  following: boolean;
  filtersIgnored: boolean;
}
const initial: State = { phase: 'idle', partner: null, isDemo: false, videoUrl: null, messages: [], error: null, liked: false, following: false, filtersIgnored: false };

type Action =
  | { type: 'starting' }
  | { type: 'searching'; filtersIgnored?: boolean }
  | { type: 'matched'; partner: Partner; isDemo: boolean; videoUrl: string | null }
  | { type: 'message'; msg: ChatMsg }
  | { type: 'partnerLikes'; likesCount: number }
  | { type: 'flags'; liked?: boolean; following?: boolean }
  | { type: 'error'; error: string }
  | { type: 'reset' };

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'starting': return { ...initial, phase: 'starting' };
    case 'searching': return { ...initial, phase: 'searching', filtersIgnored: a.filtersIgnored ?? false };
    case 'matched': return { ...initial, phase: 'connected', partner: a.partner, isDemo: a.isDemo, videoUrl: a.videoUrl };
    case 'message': return s.messages.some((m) => m.id === a.msg.id) ? s : { ...s, messages: [...s.messages, a.msg] };
    case 'partnerLikes': return s.partner ? { ...s, partner: { ...s.partner, likesCount: a.likesCount } } : s;
    case 'flags': return { ...s, ...(a.liked !== undefined ? { liked: a.liked } : {}), ...(a.following !== undefined ? { following: a.following } : {}) };
    case 'error': return { ...initial, error: a.error };
    case 'reset': return initial;
  }
}

export interface MatchingDeps {
  createPeer?(opts: PeerOptions): PeerSession;
  getUserMedia?(c: MediaStreamConstraints): Promise<MediaStream>;
}

const MEDIA_ERRORS: Record<string, string> = {
  NotAllowedError: 'Camera and microphone access was denied. Allow it in your browser settings to start chatting.',
  NotFoundError: 'No camera or microphone was found.',
  NotReadableError: 'Your camera is being used by another application.',
};

/**
 * State machine for random video chat: idle → starting (media + ICE) → searching → connected → searching …
 * The server owns matching and decides who may signal whom; this hook only relays and renders.
 */
export function useMatching(deps: MatchingDeps = {}) {
  const { socket } = useSocket();
  const session = useSession();
  const qc = useQueryClient();
  const [state, dispatch] = useReducer(reducer, initial);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [mic, setMic] = useState(true);
  const [cam, setCam] = useState(true);

  const peer = useRef<PeerSession | null>(null);
  const local = useRef<MediaStream | null>(null);
  const filters = useRef<Filters>(DEFAULT_FILTERS);
  const partnerId = useRef<string | null>(null);
  const phase = useRef<Phase>('idle');
  const ice = useRef<RTCIceServer[]>([]);
  const seq = useRef(0);
  useEffect(() => {
    phase.current = state.phase;
    partnerId.current = state.partner?.id ?? null;
  });

  const closePeer = useCallback(() => {
    peer.current?.close();
    peer.current = null;
    setRemoteStream(null);
  }, []);

  const releaseMedia = useCallback(() => {
    local.current?.getTracks().forEach((t) => t.stop());
    local.current = null;
    setLocalStream(null);
  }, []);

  const join = useCallback(async () => {
    if (!socket) throw new Error('Not connected to the server yet');
    const f = filters.current;
    const res = await emitAck<{ status: string; applied: { filtersIgnored: boolean } }>(socket, 'join_queue', {
      gender: f.gender,
      ...(f.country && f.country !== 'All Countries' ? { country: f.country } : {}),
      superMatch: f.superMatch,
    });
    // a very fast match can arrive before the ack: don't clobber it
    if (phase.current !== 'connected') dispatch({ type: 'searching', filtersIgnored: res.applied.filtersIgnored });
  }, [socket]);

  const start = useCallback(async (f: Filters = DEFAULT_FILTERS) => {
    filters.current = f;
    const my = ++seq.current;
    dispatch({ type: 'starting' });
    try {
      if (!local.current) {
        const gum = deps.getUserMedia ?? ((c) => navigator.mediaDevices.getUserMedia(c));
        local.current = await gum({ video: { facingMode: 'user' }, audio: true });
        setLocalStream(local.current);
        setMic(true);
        setCam(true);
      }
      ice.current = (await qc.fetchQuery({ queryKey: ['ice'], queryFn: () => unwrap(client.GET('/webrtc/ice-servers')), staleTime: 5 * 60_000 })).iceServers as RTCIceServer[];
      if (my !== seq.current) return;
      await join();
    } catch (e) {
      releaseMedia();
      const name = (e as { name?: string }).name ?? '';
      dispatch({ type: 'error', error: MEDIA_ERRORS[name] ?? (e as Error).message ?? 'Could not start the call' });
    }
  }, [deps.getUserMedia, join, qc, releaseMedia]);

  const stop = useCallback(() => {
    seq.current++;
    if (socket?.connected) socket.emit(phase.current === 'connected' ? 'skip_match' : 'leave_queue', {});
    closePeer();
    releaseMedia();
    dispatch({ type: 'reset' });
  }, [socket, closePeer, releaseMedia]);

  const next = useCallback(async () => {
    if (!socket) return;
    closePeer();
    socket.emit('skip_match', {});
    dispatch({ type: 'searching' });
    try { await join(); } catch (e) { dispatch({ type: 'error', error: (e as Error).message }); }
  }, [socket, closePeer, join]);

  // ---- server events ------------------------------------------------------------------------------------
  useEffect(() => {
    if (!socket) return;
    const onFound = (d: { partner: Partner; initiator: boolean; isDemo?: boolean; videoUrl?: string }) => {
      closePeer();
      dispatch({ type: 'matched', partner: d.partner, isDemo: Boolean(d.isDemo), videoUrl: d.videoUrl ?? null });
      if (d.isDemo) return;
      const make = deps.createPeer ?? ((o: PeerOptions) => new PeerSession(o));
      const p = make({
        iceServers: ice.current,
        localStream: local.current,
        initiator: d.initiator,
        send: (signal: Signal) => socket.emit('signal', { signal }, () => {}),
        onRemoteStream: setRemoteStream,
      });
      peer.current = p;
      void p.start().catch(() => dispatch({ type: 'error', error: 'Could not establish the connection' }));
    };
    const onSignal = (d: { signal: Signal }) => { void peer.current?.handle(d.signal).catch(() => {}); };
    const onSkipped = () => {
      closePeer();
      dispatch({ type: 'searching' });
      void join().catch((e: Error) => dispatch({ type: 'error', error: e.message }));
    };
    const onMessage = (m: { id: string; from: string; text: string; gift?: { name: string; image: string; cost: number } }) => {
      if (m.from !== partnerId.current) return; // chat from someone else belongs to the inbox, not this call
      dispatch({ type: 'message', msg: { id: m.id, mine: false, text: m.text, gift: m.gift } });
    };
    const onLiked = (d: { newLikesCount: number }) => session.patchUser({ likesCount: d.newLikesCount });
    const onMatchError = (e: { message: string }) => dispatch({ type: 'error', error: e.message });
    socket.on('match_found', onFound);
    socket.on('signal', onSignal);
    socket.on('partner_skipped', onSkipped);
    socket.on('receive_message', onMessage);
    socket.on('partner_liked', onLiked);
    socket.on('match_error', onMatchError);
    return () => {
      socket.off('match_found', onFound); socket.off('signal', onSignal); socket.off('partner_skipped', onSkipped);
      socket.off('receive_message', onMessage); socket.off('partner_liked', onLiked); socket.off('match_error', onMatchError);
    };
  }, [socket, closePeer, join, deps.createPeer, session]);

  // leaving the page ends the call
  useEffect(() => () => {
    seq.current++;
    peer.current?.close();
    local.current?.getTracks().forEach((t) => t.stop());
  }, []);

  // ---- in-call actions -------------------------------------------------------------------------------------
  const sendMessage = useCallback(async (text: string) => {
    if (!socket || !text.trim()) return;
    const r = await emitAck<{ message: { id: string } }>(socket, 'send_message', { text: text.trim() });
    dispatch({ type: 'message', msg: { id: r.message.id, mine: true, text: text.trim() } });
  }, [socket]);

  const sendGift = useCallback(async (giftId: string) => {
    if (!socket) return;
    const r = await emitAck<{ balance: number; message: { id: string }; gift: { name: string; image: string; price: number } }>(socket, 'send_gift', { giftId });
    session.patchUser({ gems: r.balance });
    dispatch({ type: 'message', msg: { id: r.message.id, mine: true, text: '', gift: { name: r.gift.name, image: r.gift.image, cost: r.gift.price } } });
  }, [socket, session]);

  const toggleLike = useCallback(async () => {
    const id = partnerId.current;
    if (!id) return;
    const r = state.liked
      ? await unwrap(client.DELETE('/users/{id}/like', { params: { path: { id } } }))
      : await unwrap(client.PUT('/users/{id}/like', { params: { path: { id } } }));
    dispatch({ type: 'flags', liked: r.liked });
    dispatch({ type: 'partnerLikes', likesCount: r.likesCount });
  }, [state.liked]);

  const toggleFollow = useCallback(async () => {
    const id = partnerId.current;
    if (!id) return;
    const r = state.following
      ? await unwrap(client.DELETE('/users/{id}/follow', { params: { path: { id } } }))
      : await unwrap(client.PUT('/users/{id}/follow', { params: { path: { id } } }));
    dispatch({ type: 'flags', following: r.isFollowing });
  }, [state.following]);

  const toggleTrack = (kind: 'audio' | 'video') => {
    const tracks = kind === 'audio' ? local.current?.getAudioTracks() : local.current?.getVideoTracks();
    const on = !(kind === 'audio' ? mic : cam);
    tracks?.forEach((t) => { t.enabled = on; });
    (kind === 'audio' ? setMic : setCam)(on);
  };

  return {
    ...state, localStream, remoteStream, mic, cam,
    start, stop, next, sendMessage, sendGift, toggleLike, toggleFollow,
    toggleMic: () => toggleTrack('audio'), toggleCam: () => toggleTrack('video'),
  };
}
