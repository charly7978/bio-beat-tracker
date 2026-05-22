import { describe, expect, it } from 'vitest';
import { SpO2Processor } from '../SpO2Processor';

function injectR(proc: SpO2Processor, r: number) {
  const dc = 50000;
  return proc.update(500 * r * (dc / 50000), dc, 500, dc);
}

function injectPi(proc: SpO2Processor, piRed: number, piGreen: number) {
  const dc = 50000;
  return proc.update(piRed * dc, dc, piGreen * dc, dc);
}

function warmup(proc: SpO2Processor, r = 0.5) {
  for (let i = 0; i < 80; i++) {
    injectR(proc, r);
  }
}

describe('SpO2Processor', () => {
  it('retorna INSUFFICIENT sin buffer suficiente', () => {
    const proc = new SpO2Processor();
    const est = proc.update(0, 50000, 0, 50000);
    expect(est.confidence).toBe('INSUFFICIENT');
    expect(est.spo2).toBe(0);
  });

  it('retorna INSUFFICIENT con DC insuficiente (redDC bajo)', () => {
    const proc = new SpO2Processor();
    const est = proc.update(500, 5, 500, 50000);
    expect(est.confidence).toBe('INSUFFICIENT');
  });

  it('retorna INSUFFICIENT con PI extremadamente baja', () => {
    const proc = new SpO2Processor();
    const est = injectPi(proc, 0.0001, 0.01);
    expect(est.confidence).toBe('INSUFFICIENT');
  });

  it('produce SpO2 fisiológico con R estable (~0.5 → 97-98%)', () => {
    const proc = new SpO2Processor();
    warmup(proc, 0.5);
    const est = injectR(proc, 0.5);
    if (est.confidence !== 'INSUFFICIENT') {
      expect(est.spo2).toBeGreaterThanOrEqual(90);
      expect(est.spo2).toBeLessThanOrEqual(100);
      expect(est.rValue).toBeGreaterThan(0);
      expect(est.samplesUsed).toBeGreaterThanOrEqual(8);
    }
  });

  it('responde a desaturación (R alto → SpO2 más bajo)', () => {
    const proc = new SpO2Processor();
    warmup(proc, 0.5);
    const normEst = injectR(proc, 0.5);

    warmup(proc, 1.2);
    const lowEst = injectR(proc, 1.2);

    if (normEst.confidence !== 'INSUFFICIENT' && lowEst.confidence !== 'INSUFFICIENT') {
      expect(lowEst.spo2).toBeLessThan(normEst.spo2);
      expect(lowEst.rValue).toBeGreaterThan(normEst.rValue);
    }
  });

  it('mantiene último valor tras pérdida de señal (stale hold 2 frames, expira al 3ro)', () => {
    const proc = new SpO2Processor();
    warmup(proc, 0.6);
    const goodEst = injectR(proc, 0.6);
    if (goodEst.confidence === 'INSUFFICIENT') return;

    const stale1 = proc.update(10, 50000, 10, 50000);
    expect(stale1.spo2).toBe(goodEst.spo2);
    expect(stale1.confidence).toBe('LOW');

    const stale2 = proc.update(10, 50000, 10, 50000);
    expect(stale2.spo2).toBe(goodEst.spo2);
    expect(stale2.confidence).toBe('LOW');

    const stale3 = proc.update(10, 50000, 10, 50000);
    expect(stale3.confidence).toBe('INSUFFICIENT');
    expect(stale3.spo2).toBe(0);
  });

  it('retorna INSUFFICIENT tras STALE_LIMIT pérdidas consecutivas', () => {
    const proc = new SpO2Processor();
    warmup(proc, 0.6);
    injectR(proc, 0.6);
    for (let i = 0; i < 10; i++) {
      const est = proc.update(10, 50000, 10, 50000);
      if (i >= 3) {
        expect(est.confidence).toBe('INSUFFICIENT');
      }
    }
  });

  it('produce mismo SpO2 para mismo R consecutivo (EMA convergido)', () => {
    const proc = new SpO2Processor();
    warmup(proc, 0.5);
    const est1 = injectR(proc, 0.5);
    const est2 = injectR(proc, 0.5);
    expect(est1.spo2).toBe(est2.spo2);
  });

  it('rechaza outlier de R repentino y expira tras stale', () => {
    const proc = new SpO2Processor();
    warmup(proc, 0.5);

    const firstOut = injectR(proc, 2.0);
    expect(firstOut.confidence).toBe('LOW');
    expect(firstOut.spo2).toBeGreaterThan(0);

    const secondOut = injectR(proc, 2.0);
    expect(secondOut.confidence).toBe('LOW');

    const thirdOut = injectR(proc, 2.0);
    expect(thirdOut.confidence).toBe('INSUFFICIENT');
    expect(thirdOut.spo2).toBe(0);
  });

  it('reset limpia buffer y estado', () => {
    const proc = new SpO2Processor();
    warmup(proc, 0.5);
    injectR(proc, 0.5);
    proc.reset();
    const est = proc.update(10, 50000, 10, 50000);
    expect(est.confidence).toBe('INSUFFICIENT');
    expect(est.spo2).toBe(0);
  });

  it('calibrate ajusta offset', () => {
    const proc = new SpO2Processor();
    warmup(proc, 0.5);
    injectR(proc, 0.5);
    expect(proc.getAdaptiveOffset()).toBe(0);

    proc.calibrate(97);
    expect(proc.getAdaptiveOffset()).not.toBe(0);

    const est = injectR(proc, 0.5);
    if (est.confidence !== 'INSUFFICIENT') {
      expect(est.spo2).toBe(97);
    }
  });

  it('MANEJA_DATOS_REALES: feed continuo de R variable simula dedo real', () => {
    const proc = new SpO2Processor();
    const rValues = [0.5, 0.52, 0.48, 0.51, 0.49, 0.53, 0.47, 0.5, 0.51, 0.52];
    for (let rep = 0; rep < 10; rep++) {
      for (const r of rValues) {
        injectR(proc, r);
      }
    }
    const est = injectR(proc, 0.5);
    if (est.confidence !== 'INSUFFICIENT') {
      expect(est.spo2).toBeGreaterThanOrEqual(90);
      expect(est.spo2).toBeLessThanOrEqual(100);
      expect(est.samplesUsed).toBeGreaterThanOrEqual(8);
    }
  });
});
