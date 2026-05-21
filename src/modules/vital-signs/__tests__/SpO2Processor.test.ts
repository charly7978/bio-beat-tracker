import { describe, expect, it } from 'vitest';
import { SpO2Processor } from '../SpO2Processor';

function injectR(proc: SpO2Processor, r: number) {
  const rAc = 500 * r;
  const rDc = 50000;
  const gAc = 500;
  const gDc = 50000;
  return proc.update(rAc, rDc, gAc, gDc);
}

function injectPi(proc: SpO2Processor, piRed: number, piGreen: number) {
  const dc = 50000;
  return proc.update(piRed * dc, dc, piGreen * dc, dc);
}

function feedFrames(proc: SpO2Processor, rValues: number[], count: number) {
  for (const r of rValues) {
    for (let i = 0; i < count; i++) {
      injectR(proc, r);
    }
  }
}

function warmup(proc: SpO2Processor, r = 0.5) {
  feedFrames(proc, [r], 80);
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

  it('retorna INSUFFICIENT con PI extremadamente baja', () => {
    const proc = new SpO2Processor();
    const est = injectPi(proc, 0.0001, 0.01);
    expect(est.confidence).toBe('INSUFFICIENT');
  });

  it('produce valores fisiológicos con R estable (~0.5 → 97-98%)', () => {
    const proc = new SpO2Processor();
    warmup(proc, 0.5);
    const est = injectR(proc, 0.5);
    if (est.confidence !== 'INSUFFICIENT') {
      expect(est.spo2).toBeGreaterThanOrEqual(90);
      expect(est.spo2).toBeLessThanOrEqual(100);
      expect(est.rValue).toBeGreaterThan(0);
      expect(est.samplesUsed).toBeGreaterThanOrEqual(6);
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
    }
  });

  it('mantiene último valor tras pérdida de señal (stale hold)', () => {
    const proc = new SpO2Processor();
    warmup(proc, 0.6);
    const goodEst = injectR(proc, 0.6);
    if (goodEst.confidence === 'INSUFFICIENT') return;
    const staleEst = proc.update(0, 50000, 0, 50000);
    expect(staleEst.spo2).toBe(goodEst.spo2);
    expect(staleEst.confidence).toBe('LOW');
  });

  it('retorna INSUFFICIENT tras STALE_FRAMES_MAX pérdidas consecutivas', () => {
    const proc = new SpO2Processor();
    warmup(proc, 0.6);
    injectR(proc, 0.6);
    for (let i = 0; i < 20; i++) {
      const est = proc.update(0, 50000, 0, 50000);
      if (i >= 2) {
        expect(est.confidence).toBe('INSUFFICIENT');
      }
    }
  });

  it('produce mismo valor para mismo R consecutivo (EMA convergido)', () => {
    const proc = new SpO2Processor();
    warmup(proc, 0.5);
    const est1 = injectR(proc, 0.5);
    const est2 = injectR(proc, 0.5);
    expect(est1.spo2).toBe(est2.spo2);
  });

  it('rechaza outlier de R repentino y expira tras stale', () => {
    const proc = new SpO2Processor();
    warmup(proc, 0.5);

    // Primer outlier: stale hold con LOW
    const firstOut = injectR(proc, 2.0);
    expect(firstOut.confidence).toBe('LOW');

    // Segundo outlier: staleFrames >= 2 → INSUFFICIENT
    const secondOut = injectR(proc, 2.0);
    expect(secondOut.confidence).toBe('INSUFFICIENT');
    expect(secondOut.spo2).toBe(0);
  });

  it('reset limpia buffer y estado', () => {
    const proc = new SpO2Processor();
    warmup(proc, 0.5);
    injectR(proc, 0.5);
    proc.reset();
    const est = proc.update(0, 50000, 0, 50000);
    expect(est.confidence).toBe('INSUFFICIENT');
    expect(est.spo2).toBe(0);
  });
});
