import { describe, it, expect } from 'vitest';
import { buildHybridPulseSample } from '../hybridPulseWave';

describe('buildHybridPulseSample', () => {
  it('prefiere la señal real cuando la calidad es buena', () => {
    const hybrid = buildHybridPulseSample({
      realValue: 1.2,
      quality: 80,
      isPeak: false,
      rrMs: 800,
      elapsedSinceLastPeakMs: 200,
      hasUsableContact: true,
    });

    expect(hybrid).toBeGreaterThan(0.7);
    expect(hybrid).toBeLessThan(1.4);
  });

  it('recurre a una forma fisiológica cuando no hay señal real suficiente', () => {
    const hybrid = buildHybridPulseSample({
      realValue: 0,
      quality: 10,
      isPeak: false,
      rrMs: 800,
      elapsedSinceLastPeakMs: 200,
      hasUsableContact: true,
    });

    expect(hybrid).toBeGreaterThan(0);
  });

  it('genera un pico sistólico y una caída posterior más parecida a una onda PPG', () => {
    const systolic = buildHybridPulseSample({
      realValue: 1.0,
      quality: 90,
      isPeak: false,
      rrMs: 800,
      elapsedSinceLastPeakMs: 120,
      hasUsableContact: true,
    });
    const lateDecay = buildHybridPulseSample({
      realValue: 1.0,
      quality: 90,
      isPeak: false,
      rrMs: 800,
      elapsedSinceLastPeakMs: 360,
      hasUsableContact: true,
    });

    expect(systolic).toBeGreaterThan(lateDecay);
    expect(lateDecay).toBeLessThan(0.4);
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
