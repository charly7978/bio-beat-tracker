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
  /** Ráfaga de ruido fuerte en un tramo (simula el escenario que rompía el batch). */
  burstAt?: { fromSec: number; toSec: number; noise: number };
  /** RR entre dos latidos consecutivos forzado a un valor (ms) — para doble giba. */
  tightPairAtSec?: number;
  tightPairGapMs?: number;
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
    const tSec = i / fs;
    const phase = ((tSec) * hrHz) % 1;
    const systolic = Math.exp(-Math.pow((phase - 0.15) / 0.07, 2));
    const dicrotic = 0.3 * Math.exp(-Math.pow((phase - 0.42) / 0.08, 2));
    const respGain = 1 - respAmpMod * 0.5 * (1 + Math.sin(2 * Math.PI * respHz * tSec));
    let localNoise = noise;
    if (o.burstAt && tSec >= o.burstAt.fromSec && tSec <= o.burstAt.toSec) {
      localNoise = o.burstAt.noise;
    }
    const nz = localNoise ? (rand() - 0.5) * 2 * localNoise : 0;
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
  const reasons: string[] = [];
  for (let i = 0; i < x.length; i++) {
    const r = det.process(x[i], t[i], fs);
    if (r.isPeak) {
      peakTimes.push(r.peakTimeMs);
      reasons.push(r.reason);
    }
  }
  return { det, peakTimes, reasons };
}

function expectBeatCount(peakTimes: number[], bpm: number, seconds: number, tol = 2) {
  const usable = seconds - 1.2; // warm-up mínimo de las medias móviles causales
  const expected = (bpm / 60) * usable;
  expect(peakTimes.length).toBeGreaterThanOrEqual(Math.floor(expected - tol));
  expect(peakTimes.length).toBeLessThanOrEqual(Math.ceil(expected + tol));
}

describe('StreamingBeatDetector (Elgendi causal incremental)', () => {
  it('detecta ~la cantidad correcta en señal limpia 72 BPM', () => {
    const { peakTimes } = runDetector(72, 30, 16);
    expectBeatCount(peakTimes, 72, 16);
  });

  it('arranca a detectar RÁPIDO (sin esperar segundos de warm-up de ventana batch)', () => {
    const { peakTimes } = runDetector(72, 30, 4);
    // A 72bpm en 4s hay ~4.8 latidos; con el detector causal deberían verse ≥2
    // ya en los primeros segundos (antes exigía ventana batch de ~2.4s + confirmLag).
    expect(peakTimes.length).toBeGreaterThanOrEqual(2);
  });

  it('NO produce latidos pegados (cada RR ≥ mindelay)', () => {
    const { peakTimes } = runDetector(72, 30, 16);
    for (let i = 1; i < peakTimes.length; i++) {
      expect(peakTimes[i] - peakTimes[i - 1]).toBeGreaterThanOrEqual(300);
    }
  });

  it('emisión ÚNICA: tiempos de pico estrictamente crecientes', () => {
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

  it('ROBUSTO a ruido estacionario (SNR bajo)', () => {
    const { peakTimes } = runDetector(72, 30, 18, { amp: 1, noise: 0.2, seed: 7 });
    expectBeatCount(peakTimes, 72, 18, 3);
  });

  it('ROBUSTO a RUIDO NO ESTACIONARIO (ráfaga): no pierde latidos fuera de la ráfaga '
    + 'ni deja de recuperarse después (causa raíz del bug de re-cómputo batch)', () => {
    const { peakTimes } = runDetector(72, 30, 20, {
      noise: 0.05,
      burstAt: { fromSec: 8, toSec: 11, noise: 0.9 },
      seed: 5,
    });
    // Antes de la ráfaga (0-8s) y después (12-20s) debe seguir latiendo con
    // normalidad — el umbral causal no debe quedar "roto" por la ráfaga.
    const before = peakTimes.filter((t) => t < 1000 + 7000);
    const after = peakTimes.filter((t) => t > 1000 + 13000);
    expect(before.length).toBeGreaterThanOrEqual(6);
    expect(after.length).toBeGreaterThanOrEqual(5);
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

  it('tolera taquicardia (150 BPM) sin fusionar latidos en un bloque', () => {
    const { peakTimes } = runDetector(150, 30, 12);
    expectBeatCount(peakTimes, 150, 12, 3);
  });

  it('DOBLE GIBA: separa dos latidos muy pegados con valle superficial (no cruza umbral)', () => {
    // Construye directamente dos gibas dentro de una ventana angosta con un
    // valle que NO cae por debajo del umbral (simulado con una señal sintética
    // de dos picos separados por ~350ms con un valle a mitad de altura).
    const det = new StreamingBeatDetector();
    const fs = 30;
    let clock = 1000;
    const push = (v: number) => {
      const r = det.process(v, clock, fs);
      clock += 1000 / fs;
      return r;
    };
    // Warm-up con latidos normales para calibrar el umbral/EMA.
    const { x: warm, t: warmT } = synthPpg(72, fs, 6);
    for (let i = 0; i < warm.length; i++) { det.process(warm[i], warmT[i], fs); clock = warmT[i]; }

    // Dos gibas pegadas: sube, baja a mitad (no bajo el umbral), sube de nuevo, baja.
    const shape = [0, 0.3, 0.7, 1.0, 0.7, 0.55, 0.5, 0.6, 0.9, 1.0, 0.65, 0.3, 0.05];
    const peaksHere: number[] = [];
    for (const v of shape) {
      const r = push(v * 1.0 - 0.15);
      if (r.isPeak) peaksHere.push(r.peakTimeMs);
    }
    // Deja que el bloque cierre.
    for (let k = 0; k < 5; k++) {
      const r = push(-0.2);
      if (r.isPeak) peaksHere.push(r.peakTimeMs);
    }
    expect(peaksHere.length).toBeGreaterThanOrEqual(2);
  });

  it('reset limpia el estado', () => {
    const { det } = runDetector(72, 30, 10);
    expect(det.getMedianRrMs()).toBeGreaterThan(0);
    det.reset();
    expect(det.getMedianRrMs()).toBe(0);
    expect(det.getLastEmitTime()).toBe(0);
  });
});
