export type ConnectionState = 'IDLE' | 'CONNECTING' | 'CONNECTED' | 'DISCONNECTED' | 'FAILED';
export type CallDirection = 'OUTGOING' | 'INCOMING';

export interface TelemedicinePeer {
  peerId: string;
  displayName: string;
  role: 'DOCTOR' | 'PATIENT';
  connectionState: ConnectionState;
}

export interface TelemedicineConfig {
  iceServers: RTCIceServer[];
  signalingUrl: string;
}

const DEFAULT_CONFIG: TelemedicineConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
  signalingUrl: '/functions/v1/webrtc-signal',
};

export class WebRTCManager {
  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private config: TelemedicineConfig;
  private onRemoteStream: ((stream: MediaStream) => void) | null = null;
  private onConnectionState: ((state: ConnectionState) => void) | null = null;
  private onDataReceived: ((data: unknown) => void) | null = null;

  constructor(config?: Partial<TelemedicineConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  get remoteMediaStream(): MediaStream | null { return this.remoteStream; }
  get localMediaStream(): MediaStream | null { return this.localStream; }
  get connectionState(): ConnectionState {
    if (!this.pc) return 'IDLE';
    const s = this.pc.connectionState;
    if (s === 'new' || s === 'connecting') return 'CONNECTING';
    if (s === 'connected') return 'CONNECTED';
    if (s === 'disconnected') return 'DISCONNECTED';
    return 'FAILED';
  }

  onRemoteStreamChange(cb: (stream: MediaStream) => void): void { this.onRemoteStream = cb; }
  onConnectionStateChange(cb: (state: ConnectionState) => void): void { this.onConnectionState = cb; }
  onDataReceivedChange(cb: (data: unknown) => void): void { this.onDataReceived = cb; }

  async startCall(localStream: MediaStream): Promise<void> {
    this.localStream = localStream;
    this.pc = this.createPeerConnection();
    localStream.getTracks().forEach(track => {
      if (this.pc && localStream) this.pc.addTrack(track, localStream);
    });
    this.dataChannel = this.pc.createDataChannel('vitals');
    this.dataChannel.onmessage = (e) => {
      try { this.onDataReceived?.(JSON.parse(e.data)); }
      catch { this.onDataReceived?.(e.data); }
    };
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await this.sendSignal({ type: 'offer', sdp: offer.sdp });
  }

  async acceptCall(
    offer: RTCSessionDescriptionInit,
    localStream: MediaStream,
  ): Promise<void> {
    this.localStream = localStream;
    this.pc = this.createPeerConnection();
    localStream.getTracks().forEach(track => {
      if (this.pc && localStream) this.pc.addTrack(track, localStream);
    });
    this.pc.ondatachannel = (e) => {
      this.dataChannel = e.channel;
      this.dataChannel.onmessage = (ev) => {
        try { this.onDataReceived?.(JSON.parse(ev.data)); }
        catch { this.onDataReceived?.(ev.data); }
      };
    };
    await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await this.sendSignal({ type: 'answer', sdp: answer.sdp });
  }

  async handleICECandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (this.pc) await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
  }

  async handleAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    if (this.pc) await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
  }

  sendVitals(data: Record<string, unknown>): void {
    if (this.dataChannel?.readyState === 'open') {
      this.dataChannel.send(JSON.stringify(data));
    }
  }

  hangUp(): void {
    this.dataChannel?.close();
    this.pc?.close();
    this.pc = null;
    this.dataChannel = null;
    this.remoteStream = null;
    this.onConnectionState?.('DISCONNECTED');
  }

  private createPeerConnection(): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: this.config.iceServers });
    pc.onicecandidate = (e) => {
      if (e.candidate) this.sendSignal({ type: 'candidate', candidate: e.candidate.toJSON() });
    };
    pc.ontrack = (e) => {
      this.remoteStream = e.streams[0] || new MediaStream([e.track]);
      this.onRemoteStream?.(this.remoteStream);
    };
    pc.onconnectionstatechange = () => {
      this.onConnectionState?.(this.connectionState);
    };
    return pc;
  }

  private async sendSignal(data: Record<string, unknown>): Promise<void> {
    try {
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
      const anonKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || '';
      await fetch(`${supabaseUrl}${this.config.signalingUrl}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${anonKey}` },
        body: JSON.stringify(data),
      });
    } catch (e) {
      console.warn('[WebRTC] Signal send failed:', e);
    }
  }
}
