import { describe, it, expect } from 'vitest';
import { GenerativePulseModel } from '../generativePulseModel';
import { generatePpg, generateNoise, generateFlatObject } from './ppgFixtures';

const FS = 30;
const N = 300;

describe('GenerativePulseModel', () => {
  it('explica una señal PPG periódica con alta varianza y morfología', () => {
    const model = new GenerativePulseModel();
    const bpm = 72;
    const periodSamples = (FS * 60) / bpm;
    const signal = generatePpg(bpm, FS, N, 0.05);
    const d = model.analyze(signal, periodSamples);
    expect(d.explainedVariance).toBeGreaterThan(0.7);
    expect(d.morphologyLikelihood).toBeGreaterThan(0.55);
    expect(d.predictionError).toBeLessThan(0.5);
    expect(d.cycleCount).toBeGreaterThan(8);
  });

  it('no explica ruido de banda ancha (baja varianza explicada)', () => {
    const model = new GenerativePulseModel();
    const signal = generateNoise(N);
    // periodo arbitrario: el ruido no debe volverse "explicable".
    const d = model.analyze(signal, (FS * 60) / 72);
    expect(d.explainedVariance).toBeLessThan(0.4);
    expect(d.morphologyLikelihood).toBeLessThan(0.5);
  });

  it('devuelve error máximo con periodo inválido u objeto plano', () => {
    const model = new GenerativePulseModel();
    const flat = generateFlatObject(N);
    const d = model.analyze(flat, 0);
    expect(d.predictionError).toBe(1);
    expect(d.explainedVariance).toBe(0);
    expect(d.cycleCount).toBe(0);
  });

  it('aprende una plantilla estable entre ventanas repetidas', () => {
    const model = new GenerativePulseModel();
    const bpm = 72;
    const periodSamples = (FS * 60) / bpm;
    let stability = 0;
    for (let k = 0; k < 8; k++) {
      const signal = generatePpg(bpm, FS, N, 0.05, 1000 + k);
      stability = model.analyze(signal, periodSamples).templateStability;
    }
    expect(stability).toBeGreaterThan(0.4);
  });
});
