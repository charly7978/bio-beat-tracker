import { describe, expect, it } from 'vitest';
import {
  passesRrPlausibility,
  scorePeakCandidate,
  PEAK_SCORE_THRESHOLDS,
} from '../peakScoring';

describe('peakScoring', () => {
  it('pico con buena señal supera umbral mínimo', () => {
    const s = scorePeakCandidate({
      elConf: 0.65,
      ensConf: 0.5,
      sqi: 60,
      perfusionIndex: 0.007,
      rrMs: 820,
      prevRrMedianMs: 810,
    });
    expect(s).toBeGreaterThanOrEqual(PEAK_SCORE_THRESHOLDS.minScore);
  });

  it('pico con señal débil obtiene puntuación baja', () => {
    const s = scorePeakCandidate({
      elConf: 0.2,
      ensConf: 0.2,
      sqi: 20,
      perfusionIndex: 0.002,
    });
    expect(s).toBeLessThan(PEAK_SCORE_THRESHOLDS.minScore);
  });

  it('rechaza RR muy alejado de la mediana previa', () => {
    expect(passesRrPlausibility(1200, 800)).toBe(false);
    expect(passesRrPlausibility(850, 800)).toBe(true);
  });
});
