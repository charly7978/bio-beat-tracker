import { describe, expect, it } from 'vitest';
import {
  passesRrPlausibility,
  scorePeakCandidate,
  PEAK_SCORE_THRESHOLDS,
} from '../peakScoring';

describe('peakScoring', () => {
  it('dual ponderado supera umbral mínimo con buena señal', () => {
    const s = scorePeakCandidate({
      source: 'dual',
      elConf: 0.5,
      ensConf: 0.4,
      spectralAgreement: 0.7,
      sqi: 55,
      perfusionIndex: 0.006,
      rrMs: 820,
      prevRrMedianMs: 810,
    });
    expect(s).toBeGreaterThanOrEqual(PEAK_SCORE_THRESHOLDS.dualMin);
  });

  it('solo exige puntuación más alta que dual', () => {
    const dual = scorePeakCandidate({
      source: 'dual',
      elConf: 0.35,
      ensConf: 0.3,
      spectralAgreement: 0.4,
      sqi: 40,
      perfusionIndex: 0.004,
    });
    const solo = scorePeakCandidate({
      source: 'solo_elgendi',
      elConf: 0.2,
      ensConf: 0.28,
      spectralAgreement: 0.35,
      sqi: 40,
      perfusionIndex: 0.004,
    });
    expect(solo).toBeLessThan(dual);
  });

  it('rechaza RR muy alejado de la mediana previa', () => {
    expect(passesRrPlausibility(1200, 800)).toBe(false);
    expect(passesRrPlausibility(850, 800)).toBe(true);
  });
});
