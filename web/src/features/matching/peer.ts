export type Signal = { type: 'offer' | 'answer' | 'candidate'; sdp?: unknown; candidate?: unknown };

export interface PeerOptions {
  iceServers: RTCIceServer[];
  localStream: MediaStream | null;
  initiator: boolean;
  send(signal: Signal): void;
  onRemoteStream(stream: MediaStream): void;
  onConnectionState?(state: RTCPeerConnectionState): void;
  /** Injection point for tests. */
  createConnection?(config: RTCConfiguration): RTCPeerConnection;
}

/**
 * One WebRTC call leg. The server relays opaque signals between the two matched peers; this class turns
 * them into the offer/answer/ICE exchange. Candidates arriving before the remote description are queued.
 */
export class PeerSession {
  private readonly pc: RTCPeerConnection;
  private pending: RTCIceCandidateInit[] = [];
  private remoteSet = false;
  private closed = false;

  constructor(private readonly o: PeerOptions) {
    this.pc = (o.createConnection ?? ((c) => new RTCPeerConnection(c)))({ iceServers: o.iceServers });
    o.localStream?.getTracks().forEach((t) => this.pc.addTrack(t, o.localStream!));
    this.pc.onicecandidate = (e) => {
      if (e.candidate && !this.closed) o.send({ type: 'candidate', candidate: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate });
    };
    this.pc.ontrack = (e) => {
      const stream = e.streams[0];
      if (stream) o.onRemoteStream(stream);
    };
    this.pc.onconnectionstatechange = () => o.onConnectionState?.(this.pc.connectionState);
  }

  async start(): Promise<void> {
    if (!this.o.initiator) return;
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.o.send({ type: 'offer', sdp: offer });
  }

  async handle(signal: Signal): Promise<void> {
    if (this.closed) return;
    if (signal.type === 'offer') {
      await this.pc.setRemoteDescription(signal.sdp as RTCSessionDescriptionInit);
      this.remoteSet = true;
      await this.flush();
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      this.o.send({ type: 'answer', sdp: answer });
    } else if (signal.type === 'answer') {
      await this.pc.setRemoteDescription(signal.sdp as RTCSessionDescriptionInit);
      this.remoteSet = true;
      await this.flush();
    } else if (signal.candidate) {
      const c = signal.candidate as RTCIceCandidateInit;
      if (this.remoteSet) await this.pc.addIceCandidate(c).catch(() => {});
      else this.pending.push(c);
    }
  }

  private async flush() {
    const queued = this.pending;
    this.pending = [];
    for (const c of queued) await this.pc.addIceCandidate(c).catch(() => {});
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pc.onicecandidate = null;
    this.pc.ontrack = null;
    this.pc.onconnectionstatechange = null;
    this.pc.close();
  }
}
