import { describe, it, expect } from 'vitest';
import {
  estimateRespRateFromSeries,
  extractRiavEnvelope,
  buildRifvSeries,
  smartFuseRespiration,
  estimateRespiratorySmartFusion,
  type RespModalityEstimate,
} from '../respiratorySmartFusion';

const TWO_PI = Math.PI * 2;

/** Onda respiratoria pura a `respHz` muestreada a `fs` durante `seconds`. */
function respWave(respHz: number, fs: number, seconds: number, amp = 1): number[] {
  const n = Math.round(fs * seconds);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin(TWO_PI * respHz * (i / fs));
  return out;
}

/** PPG pulsátil a `pulseHz` con amplitud modulada por la respiración a `respHz`. */
function amModulatedPulse(pulseHz: number, respHz: number, fs: number, seconds: number): number[] {
  const n = Math.round(fs * seconds);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    const envelope = 1 + 0.35 * Math.sin(TWO_PI * respHz * t);
    out[i] = envelope * Math.sin(TWO_PI * pulseHz * t);
  }
  return out;
}

/** Intervalos RR (ms) con arritmia sinusal respiratoria a `respHz`. */
function rsaRrIntervals(meanRrMs: number, respHz: number, count: number): number[] {
  const rr: number[] = [];
  let tMs = 0;
  for (let i = 0; i < count; i++) {
    const interval = meanRrMs + 70 * Math.sin(TWO_PI * respHz * (tMs / 1000));
    rr.push(interval);
    tMs += interval;
  }
  return rr;
}

describe('estimateRespRateFromSeries (RIIV directa)', () => {
  it('recupera 15 rpm de una onda respiratoria limpia', () => {
    const fs = 10;
    const series = respWave(15 / 60, fs, 24); // 0.25 Hz = 15 rpm
    const est = estimateRespRateFromSeries(series, fs, 6, 40);
    expect(est.available).toBe(true);
    expect(est.rpm).toBeGreaterThan(13.5);
    expect(est.rpm).toBeLessThan(16.5);
    expect(est.quality).toBeGreaterThan(0.5);
  });

  it('recupera 24 rpm (0.4 Hz)', () => {
    const fs = 10;
    const series = respWave(24 / 60, fs, 24);
    const est = estimateRespRateFromSeries(series, fs, 6, 40);
    expect(est.available).toBe(true);
    expect(est.rpm).toBeGreaterThan(22);
    expect(est.rpm).toBeLessThan(26);
  });

  it('marca no-disponible para series demasiado cortas', () => {
    const est = estimateRespRateFromSeries([1, 2, 3, 4], 10, 6, 40);
    expect(est.available).toBe(false);
  });

  it('marca no-disponible para ruido plano (sin periodicidad)', () => {
    const flat = new Array(200).fill(0);
    const est = estimateRespRateFromSeries(flat, 10, 6, 40);
    expect(est.available).toBe(false);
  });
});

describe('extractRiavEnvelope (RIAV)', () => {
  it('la envolvente de un pulso AM recupera la frecuencia respiratoria', () => {
    const fs = 10;
    const pulse = amModulatedPulse(1.2, 15 / 60, fs, 24); // 72 bpm, resp 15 rpm
    const env = extractRiavEnvelope(pulse, fs, 72);
    expect(env.length).toBe(pulse.length);
    const est = estimateRespRateFromSeries(env, fs, 6, 40);
    expect(est.available).toBe(true);
    expect(est.rpm).toBeGreaterThan(13);
    expect(est.rpm).toBeLessThan(17);
  });

  it('devuelve vacío para entrada corta', () => {
    expect(extractRiavEnvelope([1, 2, 3], 10, 72)).toEqual([]);
  });
});

describe('buildRifvSeries (RIFV desde RR)', () => {
  it('serie RR con RSA a 15 rpm produce serie uniforme periódica', () => {
    const rr = rsaRrIntervals(833, 15 / 60, 40); // ~72 bpm, resp 15 rpm
    const { series, fsHz } = buildRifvSeries(rr, 4);
    expect(series.length).toBeGreaterThanOrEqual(24);
    const est = estimateRespRateFromSeries(series, fsHz, 6, 40);
    expect(est.available).toBe(true);
    expect(est.rpm).toBeGreaterThan(12.5);
    expect(est.rpm).toBeLessThan(17.5);
  });

  it('pocos intervalos RR → serie vacía', () => {
    expect(buildRifvSeries([800, 810, 790], 4).series).toEqual([]);
  });
});

describe('smartFuseRespiration', () => {
  const mod = (rpm: number, quality: number): RespModalityEstimate => ({ available: true, rpm, quality });
  const none: RespModalityEstimate = { available: false, rpm: 0, quality: 0 };

  it('fusiona 3 modalidades ópticas concordantes con alta confianza', () => {
    const res = smartFuseRespiration({
      riav: mod(15.0, 0.7),
      riiv: mod(15.5, 0.6),
      rifv: mod(14.6, 0.65),
      acc: none,
    });
    expect(res.available).toBe(true);
    expect(res.fusedCount).toBe(3);
    expect(res.rpm).toBeGreaterThan(14);
    expect(res.rpm).toBeLessThan(16);
    expect(res.agreement).toBeGreaterThan(0.7);
    expect(res.confidence).toBeGreaterThan(0.5);
  });

  it('4 modalidades (incl. ACC del acelerómetro) concordantes → fusedCount 4', () => {
    const res = smartFuseRespiration({
      riav: mod(15.0, 0.7),
      riiv: mod(15.4, 0.6),
      rifv: mod(14.7, 0.65),
      acc: mod(15.2, 0.55),
    });
    expect(res.available).toBe(true);
    expect(res.fusedCount).toBe(4);
    expect(res.rpm).toBeGreaterThan(14);
    expect(res.rpm).toBeLessThan(16);
    expect(res.confidence).toBeGreaterThan(0.5);
  });

  it('discrepancia → confianza baja (especificidad Karlen)', () => {
    const res = smartFuseRespiration({
      riav: mod(11, 0.7),
      riiv: mod(26, 0.6),
      rifv: mod(18, 0.4),
      acc: none,
    });
    expect(res.available).toBe(true);
    // reporta la de mayor calidad (riav=11) pero con confianza degradada
    expect(res.rpm).toBeCloseTo(11, 1);
    expect(res.confidence).toBeLessThan(0.3);
  });

  it('una sola modalidad → confianza reducida', () => {
    const res = smartFuseRespiration({
      riav: none,
      riiv: mod(16, 0.8),
      rifv: none,
      acc: none,
    });
    expect(res.available).toBe(true);
    expect(res.fusedCount).toBe(1);
    expect(res.rpm).toBe(16);
    expect(res.confidence).toBeLessThan(0.6);
    expect(res.confidence).toBeGreaterThan(0);
  });

  it('solo el acelerómetro (ACC) disponible → estima igual', () => {
    const res = smartFuseRespiration({ riav: none, riiv: none, rifv: none, acc: mod(17, 0.7) });
    expect(res.available).toBe(true);
    expect(res.fusedCount).toBe(1);
    expect(res.rpm).toBe(17);
  });

  it('ninguna modalidad → no disponible', () => {
    const res = smartFuseRespiration({ riav: none, riiv: none, rifv: none, acc: none });
    expect(res.available).toBe(false);
    expect(res.confidence).toBe(0);
  });

  it('2 concordantes dan más confianza que 1 sola', () => {
    const one = smartFuseRespiration({ riav: mod(15, 0.7), riiv: none, rifv: none, acc: none });
    const two = smartFuseRespiration({ riav: mod(15, 0.7), riiv: mod(15.2, 0.7), rifv: none, acc: none });
    expect(two.confidence).toBeGreaterThan(one.confidence);
  });
});

describe('estimateRespiratorySmartFusion (end-to-end)', () => {
  it('recupera 15 rpm fusionando pulso AM + RIIV + RR', () => {
    const fs = 10;
    const respHz = 15 / 60;
    const res = estimateRespiratorySmartFusion({
      pulseSeries: amModulatedPulse(1.2, respHz, fs, 26),
      respBandSeries: respWave(respHz, fs, 26),
      fsHz: fs,
      rrIntervalsMs: rsaRrIntervals(833, respHz, 40),
      approxBpm: 72,
      minRpm: 6,
      maxRpm: 40,
    });
    expect(res.available).toBe(true);
    expect(res.fusedCount).toBeGreaterThanOrEqual(2);
    expect(res.rpm).toBeGreaterThan(13);
    expect(res.rpm).toBeLessThan(17);
    expect(res.confidence).toBeGreaterThan(0.4);
  });

  it('sin señales válidas → no disponible', () => {
    const res = estimateRespiratorySmartFusion({
      pulseSeries: [],
      respBandSeries: [],
      fsHz: 10,
      rrIntervalsMs: [],
      approxBpm: 0,
      minRpm: 6,
      maxRpm: 40,
    });
    expect(res.available).toBe(false);
  });
});
