/**
 * SECTOR UI - Guía de Voz
 *
 * Permite a la IA interactuar de forma humana con el usuario.
 */
export class VoiceSector {
  private synthesis = window.speechSynthesis;
  private lastSpoken = '';

  speak(text: string) {
    if (!text || text === this.lastSpoken || this.synthesis.speaking) return;

    this.lastSpoken = text;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'es-ES';
    utterance.rate = 1.0;
    this.synthesis.speak(utterance);
  }
}

export const voiceSector = new VoiceSector();
