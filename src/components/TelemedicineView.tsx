import React, { useRef, useEffect } from 'react';
import { Phone, PhoneOff, Video, VideoOff, Mic, MicOff } from 'lucide-react';

interface TelemedicineViewProps {
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  connectionState: string;
  inCall: boolean;
  onStartCall: () => void;
  onAcceptCall: () => void;
  onHangUp: () => void;
  onToggleVideo?: () => void;
  onToggleAudio?: () => void;
}

export function TelemedicineView({
  localStream, remoteStream, connectionState, inCall,
  onStartCall, onAcceptCall, onHangUp,
}: TelemedicineViewProps) {
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (localVideoRef.current) localVideoRef.current.srcObject = localStream;
  }, [localStream]);

  useEffect(() => {
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = remoteStream;
  }, [remoteStream]);

  const showLocal = inCall && localStream;
  const showRemote = inCall && remoteStream;

  return (
    <div className="relative bg-black rounded-2xl overflow-hidden aspect-video">
      {!inCall && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-zinc-950/90">
          <Phone className="w-12 h-12 text-emerald-400" />
          <p className="text-zinc-400 text-sm font-medium">Telemedicina</p>
          <div className="flex gap-3">
            <button onClick={onStartCall}
              className="px-6 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-sm font-semibold transition-colors flex items-center gap-2">
              <Phone className="w-4 h-4" /> Iniciar llamada
            </button>
            <button onClick={onAcceptCall}
              className="px-6 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-sm font-semibold transition-colors flex items-center gap-2">
              <Phone className="w-4 h-4" /> Responder
            </button>
          </div>
          <span className={`text-xs font-medium px-2 py-1 rounded-full ${
            connectionState === 'CONNECTED' ? 'bg-emerald-900/50 text-emerald-400' :
            connectionState === 'CONNECTING' ? 'bg-yellow-900/50 text-yellow-400' :
            'bg-zinc-800 text-zinc-500'
          }`}>
            {connectionState}
          </span>
        </div>
      )}

      {showRemote && (
        <video ref={remoteVideoRef} autoPlay playsInline
          className="absolute inset-0 w-full h-full object-cover" />
      )}

      {showLocal && (
        <video ref={localVideoRef} autoPlay playsInline muted
          className="absolute bottom-4 right-4 w-1/4 aspect-video rounded-lg object-cover border-2 border-zinc-700 shadow-lg" />
      )}

      {inCall && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex gap-3">
          <button onClick={onHangUp}
            className="p-3 bg-red-600 hover:bg-red-500 rounded-full transition-colors">
            <PhoneOff className="w-5 h-5 text-white" />
          </button>
        </div>
      )}

      {inCall && !remoteStream && connectionState === 'CONNECTING' && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-center">
            <div className="animate-spin rounded-full h-10 w-10 border-2 border-emerald-400 border-t-transparent mx-auto mb-3" />
            <p className="text-zinc-400 text-sm">Conectando...</p>
          </div>
        </div>
      )}
    </div>
  );
}
