import { describe, it, expect } from 'vitest';
import { computeEmissions, RegimeBeliefEngine, argmaxRegime, beliefEntropy } from '../regimeBeliefEngine';
import type { RegimeEvidence } from '../types';

const PULSE_EVIDENCE: RegimeEvidence = {
  explainedVariance: 0.9,
  morphologyLikelihood: 0.9,
  predictionError: 0.2,
  bvpCoherence: 0.9,
  skewness: 0.4,
  periodicity: 0.8,
  perfusionIndex: 0.012,
  motionScore: 0.05,
  bpm: 72,
  rrCv: 0.04,
  ectopyScore: 0,
};

const NO_PULSE_EVIDENCE: RegimeEvidence = {
  explainedVariance: 0.05,
  morphologyLikelihood: 0.1,
  predictionError: 0.95,
  bvpCoherence: 0.02,
  skewness: 0.0,
  periodicity: 0.05,
  perfusionIndex: 0.0001,
  motionScore: 0.05,
  bpm: 0,
  rrCv: 0,
  ectopyScore: 0,
};

describe('computeEmissions', () => {
  it('favorece SINUS_NORMAL con evidencia de pulso regular a 72 bpm', () => {
    const e = computeEmissions(PULSE_EVIDENCE);
    expect(e.SINUS_NORMAL).toBeGreaterThan(e.NO_PERFUSION);
    expect(e.SINUS_NORMAL).toBeGreaterThan(e.TACHYCARDIA);
    expect(e.SINUS_NORMAL).toBeGreaterThan(e.BRADYCARDIA);
  });

  it('favorece NO_PERFUSION cuando la señal no es explicable como pulso', () => {
    const e = computeEmissions(NO_PULSE_EVIDENCE);
    expect(e.NO_PERFUSION).toBeGreaterThan(e.SINUS_NORMAL);
    expect(e.NO_PERFUSION).toBeGreaterThan(0.6);
  });

  it('favorece TACHYCARDIA a bpm alto', () => {
    const e = computeEmissions({ ...PULSE_EVIDENCE, bpm: 140 });
    expect(e.TACHYCARDIA).toBeGreaterThan(e.SINUS_NORMAL);
  });

  it('favorece IRREGULAR con RR muy variable', () => {
    const e = computeEmissions({ ...PULSE_EVIDENCE, rrCv: 0.45 });
    expect(e.IRREGULAR).toBeGreaterThan(e.SINUS_NORMAL);
  });
});

describe('RegimeBeliefEngine (propagación temporal)', () => {
  it('converge a SINUS_NORMAL tras evidencia sostenida de pulso', () => {
    const engine = new RegimeBeliefEngine();
    let belief = engine.getBelief();
    for (let i = 0; i < 15; i++) belief = engine.update(PULSE_EVIDENCE);
    expect(argmaxRegime(belief)).toBe('SINUS_NORMAL');
    expect(1 - belief.NO_PERFUSION).toBeGreaterThan(0.6);
  });

  it('mantiene NO_PERFUSION con objeto/ruido sostenido', () => {
    const engine = new RegimeBeliefEngine();
    let belief = engine.getBelief();
    for (let i = 0; i < 15; i++) belief = engine.update(NO_PULSE_EVIDENCE);
    expect(argmaxRegime(belief)).toBe('NO_PERFUSION');
    expect(belief.NO_PERFUSION).toBeGreaterThan(0.6);
  });

  it('la entropía baja al converger', () => {
    const engine = new RegimeBeliefEngine();
    for (let i = 0; i < 15; i++) engine.update(PULSE_EVIDENCE);
    expect(beliefEntropy(engine.getBelief())).toBeLessThan(0.6);
  });
});
