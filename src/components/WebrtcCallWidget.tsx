import { useState, useRef, useCallback } from 'react';
import { Phone, PhoneOff, Copy, Check } from 'lucide-react';

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

export function WebrtcCallWidget() {
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const [state, setState] = useState<RTCPeerConnectionState>('new');
  const [localSdp, setLocalSdp] = useState('');
  const [remoteInput, setRemoteInput] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const cleanup = useCallback(() => {
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    setState('new');
    setLocalSdp('');
    setError('');
  }, []);

  const startCall = useCallback(async () => {
    cleanup();
    setError('');
    try {
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      pcRef.current = pc;

      pc.onconnectionstatechange = () => setState(pc.connectionState);
      pc.oniceconnectionstatechange = () => setState(pc.connectionState);
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete' && pc.localDescription) {
          setLocalSdp(JSON.stringify(pc.localDescription));
        }
      };
      pc.ondatachannel = (e) => {
        e.channel.onmessage = (msg) => console.log('[Telemed] Data:', msg.data);
      };

      pc.createDataChannel('vitals');
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
    } catch (err) {
      setError(String(err));
    }
  }, [cleanup]);

  const acceptCall = useCallback(async () => {
    if (!remoteInput) return;
    setError('');
    try {
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      pcRef.current = pc;

      pc.onconnectionstatechange = () => setState(pc.connectionState);
      pc.oniceconnectionstatechange = () => setState(pc.connectionState);
      pc.ondatachannel = (e) => {
        e.channel.onmessage = (msg) => console.log('[Telemed] Data:', msg.data);
      };

      const desc = JSON.parse(remoteInput) as RTCSessionDescriptionInit;
      await pc.setRemoteDescription(desc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      setLocalSdp(JSON.stringify(pc.localDescription));
    } catch (err) {
      setError(String(err));
    }
  }, [remoteInput]);

  const copySdp = useCallback(() => {
    if (!localSdp) return;
    navigator.clipboard.writeText(localSdp).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(error => console.error('Error copying to clipboard:', error));
  }, [localSdp]);

  const isIdle = state === 'new' || state === 'closed';

  return (
    <div className="space-y-2">
      {state !== 'connected' && state !== 'connecting' && (
        <button onClick={startCall} disabled={!isIdle}
          className="w-full py-1.5 rounded-lg bg-emerald-600/20 border border-emerald-900/40 text-emerald-400 hover:bg-emerald-600/30 font-bold text-[10px] transition-all flex items-center justify-center gap-1.5 disabled:opacity-50">
          <Phone className="w-3 h-3" />
          {isIdle ? 'CREAR OFERTA (Iniciador)' : 'RECONECTAR'}
        </button>
      )}

      {localSdp && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[9px] text-zinc-500">SDP Local (copia y comparte):</span>
            <button onClick={copySdp} className="text-emerald-400 hover:text-emerald-300">
              {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
            </button>
          </div>
          <pre className="text-[7px] text-zinc-600 bg-black/50 rounded p-1.5 max-h-12 overflow-hidden break-all select-all font-mono">
            {localSdp.slice(0, 160)}...
          </pre>
        </div>
      )}

      {isIdle && !localSdp && (
        <div className="space-y-1.5">
          <textarea value={remoteInput} onChange={(e) => setRemoteInput(e.target.value)}
            placeholder="Pega el SDP remoto aquí..."
            className="w-full bg-black border border-zinc-800 rounded-lg p-1.5 text-[9px] text-zinc-400 font-mono h-12 resize-none focus:outline-none focus:border-emerald-500"
          />
          <button onClick={acceptCall} disabled={!remoteInput}
            className="w-full py-1 rounded-lg bg-emerald-600/10 border border-emerald-900/30 text-emerald-400 hover:bg-emerald-600/20 font-bold text-[9px] transition-all disabled:opacity-30">
            RESPONDER (Pegar SDP + Crear Answer)
          </button>
        </div>
      )}

      {state !== 'new' && (
        <div className="flex items-center justify-between pt-1">
          <span className="text-[9px] text-zinc-500">
            Estado:{' '}
            <span className={`font-bold ${state === 'connected' ? 'text-emerald-400' : state === 'connecting' ? 'text-yellow-400' : state === 'failed' ? 'text-red-400' : 'text-zinc-400'}`}>
              {state}
            </span>
          </span>
          <button onClick={cleanup} className="text-red-400 hover:text-red-300">
            <PhoneOff className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {error && <p className="text-red-400 text-[8px]">{error}</p>}
    </div>
  );
}
