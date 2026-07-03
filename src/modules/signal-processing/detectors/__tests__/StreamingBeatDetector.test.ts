import { describe, it, expect } from 'vitest';
import { StreamingBeatDetector } from '../StreamingBeatDetector';

/** Genera una onda tipo PPG (sistólico agudo) ya "filtrada" (zero-centrada). */
function synthPpg(bpm: number, fs: number, seconds: number, amp = 1, noise = 0): {
  x: number[];
  t: number[];
} {
  const x: number[] = [];
  const t: number[] = [];
  const n = Math.round(fs * seconds);
  const hrHz = bpm / 60;
  const t0 = 1000;
  for (let i = 0; i < n; i++) {
    const phase = ((i / fs) * hrHz) % 1;
    // Pulso asimétrico: subida rápida, bajada lenta + muesca dícrota pequeña.
    const systolic = Math.exp(-Math.pow((phase - 0.15) / 0.08, 2));
    const dicrotic = 0.25 * Math.exp(-Math.pow((phase - 0.4) / 0.08, 2));
    const raw = systolic + dicrotic - 0.35; // centrar aprox
    const nz = noise ? (Math.sin(i * 12.9898) * 43758.5453 % 1) * noise : 0;
    x.push(amp * raw + nz);
    t.push(t0 + (i / fs) * 1000);
  }
  return { x, t };
}

function runDetector(bpm: number, fs: number, seconds: number, opts: { amp?: number; noise?: number } = {}) {
  const det = new StreamingBeatDetector();
  const { x, t } = synthPpg(bpm, fs, seconds, opts.amp ?? 1, opts.noise ?? 0);
  const peakTimes: number[] = [];
  for (let i = 0; i < x.length; i++) {
    const r = det.process(x[i], t[i], fs);
    if (r.isPeak) peakTimes.push(r.peakTimeMs);
  }
  return { det, peakTimes, durationMs: seconds * 1000 };
}

describe('StreamingBeatDetector', () => {
  it('detecta ~la cantidad correcta de latidos en señal limpia 72 BPM', () => {
    const { peakTimes } = runDetector(72, 30, 12);
    // 12 s a 72 BPM ≈ 14.4 latidos; toleramos warm-up de las medias móviles.
    expect(peakTimes.length).toBeGreaterThanOrEqual(11);
    expect(peakTimes.length).toBeLessThanOrEqual(15);
  });

  it('NO produce latidos pegados (cada RR ≥ refractario)', () => {
    const { peakTimes } = runDetector(72, 30, 15);
    for (let i = 1; i < peakTimes.length; i++) {
      const rr = peakTimes[i] - peakTimes[i - 1];
      expect(rr).toBeGreaterThanOrEqual(300);
    }
  });

  it('NO produce silencios grandes (ningún RR > 1.6× el mediano)', () => {
    const { peakTimes } = runDetector(72, 30, 15);
    const rrs = peakTimes.slice(1).map((t, i) => t - peakTimes[i]);
    const sorted = [...rrs].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    for (const rr of rrs) {
      expect(rr).toBeLessThanOrEqual(med * 1.6);
    }
  });

  it('rechaza la muesca dícrota (no la cuenta como latido)', () => {
    // Si contara la dícrota, saldrían ~2× los latidos reales.
    const { peakTimes } = runDetector(60, 30, 12);
    expect(peakTimes.length).toBeLessThanOrEqual(13);
    expect(peakTimes.length).toBeGreaterThanOrEqual(9);
  });

  it('la mediana RR corresponde al BPM real', () => {
    const { det } = runDetector(90, 30, 15);
    const medRr = det.getMedianRrMs();
    const bpm = 60000 / medRr;
    expect(bpm).toBeGreaterThan(80);
    expect(bpm).toBeLessThan(100);
  });

  it('es robusto a la amplitud (escala-invariante): misma cuenta con amp 0.1 y 5', () => {
    const a = runDetector(75, 30, 12, { amp: 0.1 });
    const b = runDetector(75, 30, 12, { amp: 5 });
    expect(Math.abs(a.peakTimes.length - b.peakTimes.length)).toBeLessThanOrEqual(2);
  });

  it('reset limpia el estado', () => {
    const { det } = runDetector(72, 30, 8);
    expect(det.getMedianRrMs()).toBeGreaterThan(0);
    det.reset();
    expect(det.getMedianRrMs()).toBe(0);
    expect(det.getLastEmitTime()).toBe(0);
  });

  it('tolera bradicardia (45 BPM) sin perder latidos', () => {
    const { peakTimes } = runDetector(45, 30, 20);
    // 20 s a 45 BPM = 15 latidos.
    expect(peakTimes.length).toBeGreaterThanOrEqual(12);
    expect(peakTimes.length).toBeLessThanOrEqual(17);
  });
});
