import { describe, expect, it, vi } from 'vitest';
import { PeerSession, type Signal } from './peer';

class FakePc {
  localDescription: unknown; remoteDescription: unknown; closed = false;
  added: unknown[] = []; tracks: unknown[] = [];
  onicecandidate: ((e: { candidate: unknown }) => void) | null = null;
  ontrack: ((e: { streams: unknown[] }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  connectionState = 'new';
  addTrack(t: unknown) { this.tracks.push(t); }
  async createOffer() { return { type: 'offer', sdp: 'OFFER' }; }
  async createAnswer() { return { type: 'answer', sdp: 'ANSWER' }; }
  async setLocalDescription(d: unknown) { this.localDescription = d; }
  async setRemoteDescription(d: unknown) { this.remoteDescription = d; }
  async addIceCandidate(c: unknown) { if (!this.remoteDescription) throw new Error('no remote description'); this.added.push(c); }
  close() { this.closed = true; }
}

const make = (initiator: boolean) => {
  const pc = new FakePc();
  const sent: Signal[] = [];
  const remote = vi.fn();
  const stream = { getTracks: () => [{ id: 'a' }, { id: 'v' }] } as unknown as MediaStream;
  const peer = new PeerSession({ iceServers: [], localStream: stream, initiator, send: (s) => sent.push(s), onRemoteStream: remote, createConnection: () => pc as unknown as RTCPeerConnection });
  return { pc, sent, remote, peer };
};

describe('PeerSession', () => {
  it('initiator creates and sends an offer; the responder sends nothing until it gets one', async () => {
    const a = make(true);
    await a.peer.start();
    expect(a.sent).toEqual([{ type: 'offer', sdp: { type: 'offer', sdp: 'OFFER' } }]);
    expect(a.pc.localDescription).toEqual({ type: 'offer', sdp: 'OFFER' });
    expect(a.pc.tracks).toHaveLength(2); // local tracks attached

    const b = make(false);
    await b.peer.start();
    expect(b.sent).toEqual([]);
  });

  it('responder answers an offer; the initiator applies the answer', async () => {
    const b = make(false);
    await b.peer.handle({ type: 'offer', sdp: { type: 'offer', sdp: 'OFFER' } });
    expect(b.pc.remoteDescription).toEqual({ type: 'offer', sdp: 'OFFER' });
    expect(b.sent).toEqual([{ type: 'answer', sdp: { type: 'answer', sdp: 'ANSWER' } }]);

    const a = make(true);
    await a.peer.start();
    await a.peer.handle({ type: 'answer', sdp: { type: 'answer', sdp: 'ANSWER' } });
    expect(a.pc.remoteDescription).toEqual({ type: 'answer', sdp: 'ANSWER' });
  });

  it('queues ICE candidates that arrive before the remote description and flushes them after', async () => {
    const b = make(false);
    await b.peer.handle({ type: 'candidate', candidate: { candidate: 'c1' } });
    await b.peer.handle({ type: 'candidate', candidate: { candidate: 'c2' } });
    expect(b.pc.added).toEqual([]);
    await b.peer.handle({ type: 'offer', sdp: { type: 'offer', sdp: 'OFFER' } });
    expect(b.pc.added).toEqual([{ candidate: 'c1' }, { candidate: 'c2' }]);
    await b.peer.handle({ type: 'candidate', candidate: { candidate: 'c3' } });
    expect(b.pc.added).toHaveLength(3);
  });

  it('forwards local candidates, remote tracks and connection state', async () => {
    const a = make(true);
    a.pc.onicecandidate?.({ candidate: { toJSON: () => ({ candidate: 'local' }) } });
    a.pc.onicecandidate?.({ candidate: null });
    expect(a.sent).toEqual([{ type: 'candidate', candidate: { candidate: 'local' } }]);
    const s = {} as MediaStream;
    a.pc.ontrack?.({ streams: [s] });
    expect(a.remote).toHaveBeenCalledWith(s);
  });

  it('close() is idempotent and silences everything afterwards', async () => {
    const a = make(true);
    a.peer.close();
    a.peer.close();
    expect(a.pc.closed).toBe(true);
    await a.peer.handle({ type: 'offer', sdp: {} });
    expect(a.pc.remoteDescription).toBeUndefined();
    expect(a.pc.onicecandidate).toBeNull();
  });
});
