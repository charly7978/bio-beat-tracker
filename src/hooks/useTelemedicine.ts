import { useState, useRef, useCallback } from 'react';

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

export function useTelemedicine() {
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const [connectionState, setConnectionState] = useState<RTCPeerConnectionState>('new');
  const [localSdp, setLocalSdp] = useState('');
  const [remoteSdpInput, setRemoteSdpInput] = useState('');
  const [error, setError] = useState('');

  const cleanup = useCallback(() => {
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    setConnectionState('new');
  }, []);

  const startCall = useCallback(async () => {
    cleanup();
    setError('');
    try {
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      pcRef.current = pc;

      pc.onconnectionstatechange = () => setConnectionState(pc.connectionState);
      pc.oniceconnectionstatechange = () => setConnectionState(pc.connectionState);
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete' && pc.localDescription) {
          setLocalSdp(JSON.stringify(pc.localDescription));
        }
      };
      pc.ondatachannel = (e) => {
        e.channel.onmessage = (msg) => console.log('[Telemed] Data:', msg.data);
      };

      const dc = pc.createDataChannel('vitals');
      dc.onopen = () => console.log('[Telemed] DataChannel open');

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
    } catch (err) {
      setError(String(err));
    }
  }, [cleanup]);

  const acceptCall = useCallback(async (remoteSdp: string) => {
    try {
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      pcRef.current = pc;

      pc.onconnectionstatechange = () => setConnectionState(pc.connectionState);
      pc.oniceconnectionstatechange = () => setConnectionState(pc.connectionState);
      pc.ondatachannel = (e) => {
        e.channel.onmessage = (msg) => console.log('[Telemed] Data:', msg.data);
      };

      const desc = JSON.parse(remoteSdp) as RTCSessionDescriptionInit;
      await pc.setRemoteDescription(desc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      setLocalSdp(JSON.stringify(pc.localDescription));
    } catch (err) {
      setError(String(err));
    }
  }, []);

  const hangUp = useCallback(() => {
    cleanup();
  }, [cleanup]);

  return {
    connectionState,
    localSdp,
    remoteSdpInput,
    setRemoteSdpInput,
    error,
    startCall,
    acceptCall,
    hangUp,
  };
}
