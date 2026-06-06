import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

interface SignalMessage {
  type: 'offer' | 'answer' | 'candidate';
  sdp?: string;
  candidate?: RTCIceCandidateInit;
  targetId?: string;
  sourceId?: string;
}

const sessions = new Map<string, { offer?: string; answer?: string; candidates: string[] }>();

serve(async (req: Request) => {
  const msg: SignalMessage = await req.json();

  switch (msg.type) {
    case 'offer': {
      if (!msg.sdp) return new Response('Missing SDP', { status: 400 });
      const sessionId = crypto.randomUUID();
      sessions.set(sessionId, { offer: msg.sdp, candidates: [] });
      return new Response(JSON.stringify({ sessionId }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    case 'answer': {
      if (!msg.sdp) return new Response('Missing SDP', { status: 400 });
      for (const [id, session] of sessions) {
        if (session.offer && !session.answer) {
          session.answer = msg.sdp;
          return new Response(JSON.stringify({ sessionId: id }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }
      return new Response('No pending session', { status: 404 });
    }
    case 'candidate': {
      const candidate = JSON.stringify(msg.candidate);
      for (const session of sessions.values()) {
        if (session.offer && !session.answer) {
          session.candidates.push(candidate);
        }
      }
      return new Response('OK');
    }
    default:
      return new Response('Unknown type', { status: 400 });
  }
});
