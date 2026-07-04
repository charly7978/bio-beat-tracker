import { describe, it, expect, vi } from 'vitest';
import { SignalBrain } from '../SignalBrain';

describe('SignalBrain', () => {
  it('should build a prompt with all features', () => {
    const brain = new SignalBrain();
    const features = {
      bpm: 72,
      sqi: 80,
      pi: 0.005,
      periodicity: 0.9,
      motion: 0.1,
      snr: 12.5,
      skewness: 0.5
    };

    // @ts-ignore - accessing private method for test
    const prompt = brain.buildPrompt(features);

    expect(prompt).toContain('BPM: 72');
    expect(prompt).toContain('Calidad (SQI): 80');
    expect(prompt).toContain('Perfusión (PI): 0.0050');
    expect(prompt).toContain('Periodicidad: 0.90');
    expect(prompt).toContain('Movimiento: 0.10');
    expect(prompt).toContain('SNR: 12.50');
    expect(prompt).toContain('Skewness: 0.50');
  });

  it('should parse a JSON response correctly', () => {
    const brain = new SignalBrain();
    const jsonResponse = '{"verdict": "REAL_BEAT", "confidence": 0.95, "reason": "La señal es muy rítmica y limpia"}';

    // @ts-ignore
    const reasoning = brain.parseResponse(jsonResponse);

    expect(reasoning.verdict).toBe('REAL_BEAT');
    expect(reasoning.confidence).toBe(0.95);
    expect(reasoning.thought).toBe('La señal es muy rítmica y limpia');
  });

  it('should fallback to text parsing if JSON fails', () => {
    const brain = new SignalBrain();
    const textResponse = 'Parece un REAL_BEAT porque el ritmo es constante.';

    // @ts-ignore
    const reasoning = brain.parseResponse(textResponse);

    expect(reasoning.verdict).toBe('REAL_BEAT');
    expect(reasoning.confidence).toBe(0.7);
  });
});
