import { describe, it, expect } from 'vitest';
import { CardiovascularStateInference } from '../index';
import type { CvsiInput } from '../types';
import { generatePpg, generateFlatObject, generateNoise, regularRr } from './ppgFixtures';

const FS = 30;
const N = 300;

function realFingerInput(bpm: number, t: number): CvsiInput {
  return {
    filtered: generatePpg(bpm, FS, N, 0.05),
    fs: FS,
    timestampMs: t,
    rrIntervalsMs: regularRr(bpm, 12, 10),
    bpm,
    perfusionIndex: 0.012,
    skewness: 0.4,
    periodicity: 0.8,
    motionScore: 0.05,
    spo2Channels: { acRed: 0.02, dcRed: 1.0, acGreen: 0.024, dcGreen: 1.0 },
  };
}

function objectInput(t: number): CvsiInput {
  return {
    filtered: generateFlatObject(N),
    fs: FS,
    timestampMs: t,
    rrIntervalsMs: [],
    bpm: 0,
    perfusionIndex: 0.0001,
    skewness: 0.0,
    periodicity: 0.03,
    motionScore: 0.05,
    spo2Channels: { acRed: 0.00002, dcRed: 1.0, acGreen: 0.00002, dcGreen: 1.0 },
  };
}

describe('CardiovascularStateInference (end-to-end)', () => {
  it('infiere pulso real: SINUS_NORMAL, alta perfusión, HR convergido cerca de la verdad', () => {
    const engine = new CardiovascularStateInference();
    let state = engine.update(realFingerInput(72, 0));
    for (let i = 1; i <= 20; i++) state = engine.update(realFingerInput(72, i * 333));
    expect(state.mostLikelyRegime).toBe('SINUS_NORMAL');
    expect(state.perfusionProbability).toBeGreaterThan(0.6);
    expect(state.heartRate.bpm).toBeGreaterThan(66);
    expect(state.heartRate.bpm).toBeLessThan(78);
    expect(state.heartRate.converged).toBe(true);
    expect(state.narrative).toContain('bpm');
  });

  it('infiere objeto inerte: NO_PERFUSION, baja perfusión, sin HR', () => {
    const engine = new CardiovascularStateInference();
    let state = engine.update(objectInput(0));
    for (let i = 1; i <= 20; i++) state = engine.update(objectInput(i * 333));
    expect(state.mostLikelyRegime).toBe('NO_PERFUSION');
    expect(state.perfusionProbability).toBeLessThan(0.35);
    expect(state.narrative).toContain('no se detecta un latido real');
  });

  it('infiere taquicardia con pulso real a 140 bpm', () => {
    const engine = new CardiovascularStateInference();
    let state = engine.update(realFingerInput(140, 0));
    for (let i = 1; i <= 20; i++) state = engine.update(realFingerInput(140, i * 214));
    expect(state.mostLikelyRegime).toBe('TACHYCARDIA');
    expect(state.perfusionProbability).toBeGreaterThan(0.6);
  });

  it('reacciona a retirar el dedo: colapsa a NO_PERFUSION', () => {
    const engine = new CardiovascularStateInference();
    for (let i = 0; i <= 20; i++) engine.update(realFingerInput(72, i * 333));
    let state = engine.update(objectInput(21 * 333));
    for (let i = 22; i <= 40; i++) state = engine.update(objectInput(i * 333));
    expect(state.mostLikelyRegime).toBe('NO_PERFUSION');
    expect(state.perfusionProbability).toBeLessThan(0.35);
  });

  it('no colapsa por un único frame de ruido (inercia temporal)', () => {
    const engine = new CardiovascularStateInference();
    for (let i = 0; i <= 20; i++) engine.update(realFingerInput(72, i * 333));
    // un frame de ruido aislado
    const noisy: CvsiInput = { ...realFingerInput(72, 21 * 333), filtered: generateNoise(N), bpm: 0, periodicity: 0.1 };
    const state = engine.update(noisy);
    // la creencia no debe volcarse por completo en un frame
    expect(state.perfusionProbability).toBeGreaterThan(0.4);
  });
});
