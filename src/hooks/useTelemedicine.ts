import { useState, useRef, useCallback, useEffect } from 'react';
import { WebRTCManager, type ConnectionState } from '../lib/telemedicine/webrtcManager';

export function useTelemedicine() {
  const [connectionState, setConnectionState] = useState<ConnectionState>('IDLE');
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [inCall, setInCall] = useState(false);
  const [incomingOffer, setIncomingOffer] = useState<RTCSessionDescriptionInit | null>(null);
  const webrtcRef = useRef<WebRTCManager | null>(null);
  const managerRef = useRef<WebRTCManager | null>(null);

  if (!managerRef.current) {
    managerRef.current = new WebRTCManager();
    const m = managerRef.current;
    m.onConnectionStateChange(setConnectionState);
    m.onRemoteStreamChange(setRemoteStream);
    m.onDataReceivedChange((data) => {
      window.dispatchEvent(new CustomEvent('telemedicine-data', { detail: data }));
    });
  }

  useEffect(() => {
    return () => { managerRef.current?.hangUp(); };
  }, []);

  const startCall = useCallback(async () => {
    const m = managerRef.current;
    if (!m) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      setLocalStream(stream);
      await m.startCall(stream);
      setInCall(true);
    } catch (e) {
      console.error('[Telemedicine] Failed to start call:', e);
    }
  }, []);

  const acceptCall = useCallback(async () => {
    const m = managerRef.current;
    if (!m || !incomingOffer) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      setLocalStream(stream);
      await m.acceptCall(incomingOffer, stream);
      setInCall(true);
      setIncomingOffer(null);
    } catch (e) {
      console.error('[Telemedicine] Failed to accept call:', e);
    }
  }, [incomingOffer]);

  const hangUp = useCallback(() => {
    managerRef.current?.hangUp();
    localStream?.getTracks().forEach(t => t.stop());
    setLocalStream(null);
    setRemoteStream(null);
    setInCall(false);
    setConnectionState('IDLE');
  }, [localStream]);

  const sendVitals = useCallback((data: Record<string, unknown>) => {
    managerRef.current?.sendVitals(data);
  }, []);

  return {
    connectionState, remoteStream, localStream, inCall, incomingOffer,
    setIncomingOffer, startCall, acceptCall, hangUp, sendVitals,
  };
}
