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
  /** Modulación respiratoria de amplitud (0..1): profundidad. */
  respAmpMod?: number;
  /** Jitter de fps (fracción del período de muestreo). */
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
  const respHz = 0.25; // ~15 rpm
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
  const { x, t } = synthPpg(bpm, fs, seconds, o);
  const peakTimes: number[] = [];
  for (let i = 0; i < x.length; i++) {
    const r = det.process(x[i], t[i], fs);
    if (r.isPeak) peakTimes.push(r.peakTimeMs);
  }
  return { det, peakTimes };
}

/** Latidos esperados descontando ~1.5 latidos de warm-up de la envolvente. */
function expectBeatCount(peakTimes: number[], bpm: number, seconds: number, tol = 2) {
  const expected = (bpm / 60) * seconds;
  expect(peakTimes.length).toBeGreaterThanOrEqual(Math.floor(expected - 1.5 - tol));
  expect(peakTimes.length).toBeLessThanOrEqual(Math.ceil(expected + tol));
}

describe('StreamingBeatDetector', () => {
  it('detecta ~la cantidad correcta en señal limpia 72 BPM', () => {
    const { peakTimes } = runDetector(72, 30, 12);
    expectBeatCount(peakTimes, 72, 12);
  });

  it('NO produce latidos pegados (cada RR ≥ refractario)', () => {
    const { peakTimes } = runDetector(72, 30, 15);
    for (let i = 1; i < peakTimes.length; i++) {
      expect(peakTimes[i] - peakTimes[i - 1]).toBeGreaterThanOrEqual(300);
    }
  });

  it('NO produce silencios grandes (ningún RR > 1.6× el mediano)', () => {
    const { peakTimes } = runDetector(72, 30, 15);
    const rrs = peakTimes.slice(1).map((tt, i) => tt - peakTimes[i]);
    const sorted = [...rrs].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    for (const rr of rrs) expect(rr).toBeLessThanOrEqual(med * 1.6);
  });

  it('rechaza la muesca dícrota (no la cuenta como latido)', () => {
    const { peakTimes } = runDetector(60, 30, 12);
    expectBeatCount(peakTimes, 60, 12);
  });

  it('la mediana RR corresponde al BPM real', () => {
    const { det } = runDetector(90, 30, 15);
    const bpm = 60000 / det.getMedianRrMs();
    expect(bpm).toBeGreaterThan(82);
    expect(bpm).toBeLessThan(98);
  });

  it('es escala-invariante: misma cuenta con amp 0.05 y amp 8', () => {
    const a = runDetector(75, 30, 12, { amp: 0.05 });
    const b = runDetector(75, 30, 12, { amp: 8 });
    expect(Math.abs(a.peakTimes.length - b.peakTimes.length)).toBeLessThanOrEqual(2);
  });

  it('ROBUSTO a ruido (SNR bajo): no sub-detecta con noise=0.25', () => {
    const { peakTimes } = runDetector(72, 30, 15, { amp: 1, noise: 0.25, seed: 7 });
    expectBeatCount(peakTimes, 72, 15, 3);
  });

  it('ROBUSTO a modulación respiratoria de amplitud (no pierde latidos débiles)', () => {
    const { peakTimes } = runDetector(66, 30, 18, { respAmpMod: 0.7, seed: 11 });
    expectBeatCount(peakTimes, 66, 18, 3);
  });

  it('ROBUSTO a jitter de fps (frames irregulares)', () => {
    const { peakTimes } = runDetector(78, 30, 15, { fpsJitter: 0.4, noise: 0.1, seed: 3 });
    expectBeatCount(peakTimes, 78, 15, 3);
  });

  it('tolera bradicardia (45 BPM) sin perder latidos', () => {
    const { peakTimes } = runDetector(45, 30, 20);
    expectBeatCount(peakTimes, 45, 20);
  });

  it('tolera taquicardia (140 BPM)', () => {
    const { peakTimes } = runDetector(140, 30, 10);
    expectBeatCount(peakTimes, 140, 10, 3);
  });

  it('reset limpia el estado', () => {
    const { det } = runDetector(72, 30, 8);
    expect(det.getMedianRrMs()).toBeGreaterThan(0);
    det.reset();
    expect(det.getMedianRrMs()).toBe(0);
    expect(det.getLastEmitTime()).toBe(0);
  });
});
