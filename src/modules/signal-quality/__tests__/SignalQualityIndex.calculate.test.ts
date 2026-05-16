import { describe, it, expect } from 'vitest';
import { SignalQualityIndex } from '../SignalQualityIndex';
import type { SignalQualityMetrics } from '../../../types/measurements';

function mobilePpg(partial: Partial<SignalQualityMetrics>): SignalQualityMetrics {
  return {
    sqi: 0,
    perfusionIndex: 0.002,
    snr: 0.75,
    periodicity: 0.26,
    motionScore: 0.18,
    saturationRatio: 0,
    underexposureRatio: 0.05,
    frameDropRatio: 0.04,
    fpsEffective: 28,
    timestampJitterMs: 30,
    ...partial,
  };
}

describe('SignalQualityIndex.calculate (móvil PPG)', () => {
  it('señal típica con dedo alcanza SQI usable (>28), no se anula por motion leve', () => {
    const sqi = SignalQualityIndex.calculate(mobilePpg({}));
    expect(sqi).toBeGreaterThanOrEqual(28);
    expect(sqi).toBeLessThanOrEqual(100);
  });

  it('PI muy bajo devuelve 0', () => {
    expect(SignalQualityIndex.calculate(mobilePpg({ perfusionIndex: 0.00005 }))).toBe(0);
  });

  it('smoothDisplayedSqi sube con EMA sin comprimir por UNSTABLE', () => {
    let ema = 0;
    for (let i = 0; i < 12; i++) {
      ema = SignalQualityIndex.smoothDisplayedSqi(ema, 42, 'UNSTABLE_CONTACT');
    }
    expect(ema).toBeGreaterThanOrEqual(20);
  });
});
