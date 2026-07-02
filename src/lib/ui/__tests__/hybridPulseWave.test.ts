import { describe, it, expect } from 'vitest';
import { buildHybridPulseSample } from '../hybridPulseWave';

describe('buildHybridPulseSample', () => {
  it('prefiere la señal real cuando la calidad es buena', () => {
    const hybrid = buildHybridPulseSample({
      realValue: 1.2,
      quality: 80,
      isPeak: false,
      rrMs: 800,
      elapsedSinceLastPeakMs: 80,
      hasUsableContact: true,
    });

    expect(hybrid).toBeGreaterThan(0.7);
    expect(hybrid).toBeLessThan(1.8);
  });

  it('recurre al template cuando no hay señal real suficiente', () => {
    const hybrid = buildHybridPulseSample({
      realValue: 0,
      quality: 10,
      isPeak: false,
      rrMs: 800,
      elapsedSinceLastPeakMs: 80,
      hasUsableContact: true,
    });

    expect(hybrid).toBeGreaterThan(0);
  });

  it('genera un pico máximo y un valle negativo (efecto latigazo)', () => {
    const peak = buildHybridPulseSample({
      realValue: 1.0,
      quality: 90,
      isPeak: false,
      rrMs: 800,
      elapsedSinceLastPeakMs: 80,
      hasUsableContact: true,
    });
    const postRecovery = buildHybridPulseSample({
      realValue: 1.0,
      quality: 90,
      isPeak: false,
      rrMs: 800,
      elapsedSinceLastPeakMs: 250,
      hasUsableContact: true,
    });

    expect(peak).toBeGreaterThan(postRecovery);
    expect(postRecovery).toBeGreaterThanOrEqual(0);
  });

  it('permanece plana sin contacto', () => {
    const hybrid = buildHybridPulseSample({
      realValue: 0.6,
      quality: 40,
      isPeak: false,
      rrMs: 800,
      elapsedSinceLastPeakMs: 200,
      hasUsableContact: false,
    });

    expect(hybrid).toBe(0);
  });
});
