import { describe, expect, it } from 'vitest';
import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';
import {
  computePhysiologicalIndices,
  enforceHemodynamicCoherence,
  estimatePhysiologicalBp,
  isPhysiologicalBp,
  type PwaMedianFeatures,
} from '../pwaPhysiologicalBpEngine';

const baseFeatures: PwaMedianFeatures = {
  bDivA: -0.75,
  dDivA: -0.35,
  agi: 0.4,
  sutMs: 140,
  diastolicPhaseMs: 480,
  stiffnessIndex: 8,
  augmentationIndex: 18,
  dicroticDepth: 0.22,
  areaRatio: 1.45,
  pw50Ms: 220,
  kValue: 0.38,
  vMax: 52,
};

describe('pwaPhysiologicalBpEngine', () => {
  it('índices en [0,1] desde morfología', () => {
    const idx = computePhysiologicalIndices(baseFeatures, {
      hr: 72,
      rmssd: 35,
      cyclePeriodMs: 830,
    });
    expect(idx.resistanceIndex).toBeGreaterThanOrEqual(0);
    expect(idx.resistanceIndex).toBeLessThanOrEqual(1);
    expect(idx.complianceIndex).toBeGreaterThanOrEqual(0);
    expect(idx.complianceIndex).toBeLessThanOrEqual(1);
  });

  it('estimación dentro de rangos fisiológicos sin offsets hardcodeados', () => {
    const raw = estimatePhysiologicalBp(baseFeatures, {
      hr: 72,
      rmssd: 35,
      cyclePeriodMs: 830,
    });
    const { sbp, dbp } = enforceHemodynamicCoherence(raw.systolic, raw.diastolic);
    expect(isPhysiologicalBp(sbp, dbp)).toBe(true);
    expect(sbp).toBeGreaterThan(dbp);
    expect(dbp).toBeGreaterThanOrEqual(VITAL_THRESHOLDS.BP.DIASTOLIC_MIN);
    expect(sbp).toBeLessThanOrEqual(VITAL_THRESHOLDS.BP.SYSTOLIC_MAX);
  });

  it('rechaza presión fuera de rango fisiológico', () => {
    expect(isPhysiologicalBp(250, 80)).toBe(false);
    expect(isPhysiologicalBp(120, 20)).toBe(false);
  });
});
