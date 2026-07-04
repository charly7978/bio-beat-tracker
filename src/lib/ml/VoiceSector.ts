/**
 * SECTOR UI - Guía de Voz
 *
 * Permite a la IA interactuar de forma humana con el usuario.
 */
export class VoiceSector {
  private synthesis = window.speechSynthesis; // anti-sim-allow: reason="Web Speech API for AI live guidance" ref="AI-LIVE-VOICE"
  private lastSpoken = '';

  speak(text: string) { // anti-sim-allow: reason="Live AI assistant voice interaction" ref="AI-LIVE-VOICE"
    if (!text || text === this.lastSpoken || this.synthesis.speaking) return; // anti-sim-allow: reason="Check state of speech synthesis" ref="AI-LIVE-VOICE"

    this.lastSpoken = text;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'es-ES';
    utterance.rate = 1.0;
    this.synthesis.speak(utterance); // anti-sim-allow: reason="Executing speech synthesis" ref="AI-LIVE-VOICE"
  }
}

export const voiceSector = new VoiceSector();
