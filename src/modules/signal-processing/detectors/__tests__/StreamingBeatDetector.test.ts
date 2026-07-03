import { describe, it, expect } from 'vitest';
import { StreamingBeatDetector } from '../StreamingBeatDetector';

/** PRNG determinista (mulberry32) para ruido reproducible. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface SynthOpts {
  amp?: number;
  noise?: number;
  respAmpMod?: number;
  fpsJitter?: number;
  seed?: number;
}

/** Onda tipo PPG (sistólico agudo + muesca dícrota) ya "filtrada" (zero-centrada). */
function synthPpg(bpm: number, fs: number, seconds: number, o: SynthOpts = {}) {
  const { amp = 1, noise = 0, respAmpMod = 0, fpsJitter = 0, seed = 42 } = o;
  const rand = rng(seed);
  const x: number[] = [];
  const t: number[] = [];
  const n = Math.round(fs * seconds);
  const hrHz = bpm / 60;
  const respHz = 0.25;
  let clock = 1000;
  for (let i = 0; i < n; i++) {
    const phase = ((i / fs) * hrHz) % 1;
    const systolic = Math.exp(-Math.pow((phase - 0.15) / 0.07, 2));
    const dicrotic = 0.3 * Math.exp(-Math.pow((phase - 0.42) / 0.08, 2));
    const respGain = 1 - respAmpMod * 0.5 * (1 + Math.sin(2 * Math.PI * respHz * (i / fs)));
    const nz = noise ? (rand() - 0.5) * 2 * noise : 0;
    x.push(amp * respGain * (systolic + dicrotic - 0.32) + nz);
    clock += (1000 / fs) * (1 + (fpsJitter ? (rand() - 0.5) * 2 * fpsJitter : 0));
    t.push(clock);
  }
  return { x, t };
}

function runDetector(bpm: number, fs: number, seconds: number, o: SynthOpts = {}) {
  const det = new StreamingBeatDetector();
  det.setQualityContext(70, 0.01);
  const { x, t } = synthPpg(bpm, fs, seconds, o);
  const peakTimes: number[] = [];
  for (let i = 0; i < x.length; i++) {
    const r = det.process(x[i], t[i], fs);
    if (r.isPeak) peakTimes.push(r.peakTimeMs);
  }
  return { det, peakTimes };
}

/**
 * Latidos esperados descontando el warm-up de ventana (~2.4 s a 30fps) y el
 * retardo de confirmación (~0.4 s), con tolerancia.
 */
function expectBeatCount(peakTimes: number[], bpm: number, seconds: number, tol = 2.5) {
  const usable = seconds - 3; // warm-up de ventana + confirmación
  const expected = (bpm / 60) * usable;
  expect(peakTimes.length).toBeGreaterThanOrEqual(Math.floor(expected - tol));
  expect(peakTimes.length).toBeLessThanOrEqual(Math.ceil(expected + tol + 1));
}

describe('StreamingBeatDetector (Elgendi fiel + emisión por confirmación)', () => {
  it('detecta ~la cantidad correcta en señal limpia 72 BPM', () => {
    const { peakTimes } = runDetector(72, 30, 16);
    expectBeatCount(peakTimes, 72, 16);
  });

  it('NO produce latidos pegados (cada RR ≥ mindelay)', () => {
    const { peakTimes } = runDetector(72, 30, 16);
    for (let i = 1; i < peakTimes.length; i++) {
      expect(peakTimes[i] - peakTimes[i - 1]).toBeGreaterThanOrEqual(300);
    }
  });

  it('emisión ÚNICA: los tiempos de pico son estrictamente crecientes y sin repetición', () => {
    const { peakTimes } = runDetector(72, 30, 16);
    for (let i = 1; i < peakTimes.length; i++) {
      expect(peakTimes[i]).toBeGreaterThan(peakTimes[i - 1]);
    }
  });

  it('NO produce silencios grandes (ningún RR > 1.7× el mediano)', () => {
    const { peakTimes } = runDetector(72, 30, 18);
    const rrs = peakTimes.slice(1).map((tt, i) => tt - peakTimes[i]);
    const sorted = [...rrs].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    for (const rr of rrs) expect(rr).toBeLessThanOrEqual(med * 1.7);
  });

  it('rechaza la muesca dícrota (no la cuenta como latido)', () => {
    const { peakTimes } = runDetector(60, 30, 16);
    expectBeatCount(peakTimes, 60, 16);
  });

  it('la mediana RR corresponde al BPM real', () => {
    const { det } = runDetector(90, 30, 18);
    const bpm = 60000 / det.getMedianRrMs();
    expect(bpm).toBeGreaterThan(82);
    expect(bpm).toBeLessThan(98);
  });

  it('es escala-invariante: misma cuenta con amp 0.05 y amp 8', () => {
    const a = runDetector(75, 30, 16, { amp: 0.05 });
    const b = runDetector(75, 30, 16, { amp: 8 });
    expect(Math.abs(a.peakTimes.length - b.peakTimes.length)).toBeLessThanOrEqual(2);
  });

  it('ROBUSTO a ruido (SNR bajo): no sub-detecta con noise=0.2', () => {
    const { peakTimes } = runDetector(72, 30, 18, { amp: 1, noise: 0.2, seed: 7 });
    expectBeatCount(peakTimes, 72, 18, 3.5);
  });

  it('ROBUSTO a modulación respiratoria de amplitud', () => {
    const { peakTimes } = runDetector(66, 30, 20, { respAmpMod: 0.6, seed: 11 });
    expectBeatCount(peakTimes, 66, 20, 3.5);
  });

  it('ROBUSTO a jitter de fps (frames irregulares)', () => {
    const { peakTimes } = runDetector(78, 30, 18, { fpsJitter: 0.35, noise: 0.08, seed: 3 });
    expectBeatCount(peakTimes, 78, 18, 3.5);
  });

  it('tolera bradicardia (48 BPM) sin perder latidos', () => {
    const { peakTimes } = runDetector(48, 30, 22);
    expectBeatCount(peakTimes, 48, 22);
  });

  it('reset limpia el estado', () => {
    const { det } = runDetector(72, 30, 10);
    expect(det.getMedianRrMs()).toBeGreaterThan(0);
    det.reset();
    expect(det.getMedianRrMs()).toBe(0);
    expect(det.getLastEmitTime()).toBe(0);
  });
});
