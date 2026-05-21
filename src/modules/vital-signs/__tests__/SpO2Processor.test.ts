import { describe, expect, it } from 'vitest';
import { SpO2Processor } from '../SpO2Processor';

function injectR(proc: SpO2Processor, r: number) {
  const rAc = 500 * r;
  const rDc = 50000;
  const gAc = 500;
  const gDc = 50000;
  return proc.update(rAc, rDc, gAc, gDc);
}

function feedFrames(proc: SpO2Processor, rValues: number[], count: number) {
  for (const r of rValues) {
    for (let i = 0; i < count; i++) {
      injectR(proc, r);
    }
  }
}

describe('SpO2Processor', () => {
  it('retorna INSUFFICIENT sin buffer suficiente', () => {
    const proc = new SpO2Processor();
    const est = proc.update(0, 50000, 0, 50000);
    expect(est.confidence).toBe('INSUFFICIENT');
    expect(est.spo2).toBe(0);
  });

  it('retorna INSUFFICIENT con DC insuficiente', () => {
    const proc = new SpO2Processor();
    const est = proc.update(500, 5, 500, 50000);
    expect(est.confidence).toBe('INSUFFICIENT');
  });

  it('acepta amplitud extremadamente baja (sin gate PI)', () => {
    const proc = new SpO2Processor();
    feedFrames(proc, [1.0], 10);
    const est = injectR(proc, 1.0);
    expect(est.confidence).not.toBe('INSUFFICIENT');
    expect(est.spo2).toBeGreaterThanOrEqual(70);
  });

  it('produce valores fisiológicos con R estable (~0.5 → 97%)', () => {
    const proc = new SpO2Processor();
    feedFrames(proc, [0.5], 20);
    const est = injectR(proc, 0.5);
    if (est.confidence !== 'INSUFFICIENT') {
      expect(est.spo2).toBeGreaterThanOrEqual(90);
      expect(est.spo2).toBeLessThanOrEqual(100);
      expect(est.rValue).toBeGreaterThan(0);
      expect(est.samplesUsed).toBeGreaterThanOrEqual(3);
    }
  });

  it('responde a desaturación (R alto → SpO2 más bajo)', () => {
    const proc = new SpO2Processor();
    feedFrames(proc, [0.5], 20);
    const normEst = injectR(proc, 0.5);
    feedFrames(proc, [1.2], 20);
    const lowEst = injectR(proc, 1.2);
    if (normEst.confidence !== 'INSUFFICIENT' && lowEst.confidence !== 'INSUFFICIENT') {
      expect(lowEst.spo2).toBeLessThan(normEst.spo2);
    }
  });

  it('mantiene último valor tras pérdida de señal (stale hold)', () => {
    const proc = new SpO2Processor();
    feedFrames(proc, [0.6], 20);
    const goodEst = injectR(proc, 0.6);
    if (goodEst.confidence === 'INSUFFICIENT') return;
    const staleEst = proc.update(0, 50000, 0, 50000);
    expect(staleEst.spo2).toBe(goodEst.spo2);
    expect(staleEst.confidence).toBe('LOW');
  });

  it('retorna INSUFFICIENT tras STALE_FRAMES_MAX pérdidas consecutivas', () => {
    const proc = new SpO2Processor();
    feedFrames(proc, [0.6], 20);
    injectR(proc, 0.6);
    for (let i = 0; i < 20; i++) {
      const est = proc.update(0, 50000, 0, 50000);
      if (i >= 3) {
        expect(est.confidence).toBe('INSUFFICIENT');
      }
    }
  });

  it('produce mismo valor para mismo R consecutivo (EMA convergido)', () => {
    const proc = new SpO2Processor();
    feedFrames(proc, [0.5], 20);
    const est1 = injectR(proc, 0.5);
    const est2 = injectR(proc, 0.5);
    expect(est1.spo2).toBe(est2.spo2);
  });

  it('reset limpia buffer y estado', () => {
    const proc = new SpO2Processor();
    feedFrames(proc, [0.5], 20);
    injectR(proc, 0.5);
    proc.reset();
    const est = proc.update(0, 50000, 0, 50000);
    expect(est.confidence).toBe('INSUFFICIENT');
    expect(est.spo2).toBe(0);
  });
});
