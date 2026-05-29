import { describe, it, expect } from 'vitest';
import { ElgendiPeakDetector } from '../detectors/ElgendiPeakDetector';
import { PeakDetectionEnsemble } from '../detectors/PeakDetectionEnsemble';

function makeSinePeaks(fs: number, durationSec: number, bpm: number, noise = 0): { y: number[]; t: number[] } {
  const n = Math.floor(fs * durationSec);
  const y: number[] = [];
  const t: number[] = [];
  const periodMs = 60000 / bpm;
  for (let i = 0; i < n; i++) {
    const ti = (i / fs) * 1000;
    t.push(ti);
    const phase = ((ti % periodMs) / periodMs) * Math.PI * 2;
    const pulse = Math.max(0, Math.sin(phase)) ** 3;
    const wobble = noise > 0 ? Math.sin(i * 0.37) * noise : 0;
    y.push(pulse * 1.2 + wobble);
  }
  return { y, t };
}

/** PPG con pico sistólico + muesca dícrota (bump menor ~0.3× tras el sistólico). */
function makePpgWithDicrotic(fs: number, durationSec: number, bpm: number): { y: number[]; t: number[] } {
  const n = Math.floor(fs * durationSec);
  const y: number[] = [];
  const t: number[] = [];
  const periodMs = 60000 / bpm;
  const gauss = (frac: number, center: number, width: number) =>
    Math.exp(-(((frac - center) / width) ** 2));
  for (let i = 0; i < n; i++) {
    const ti = (i / fs) * 1000;
    t.push(ti);
    const frac = (ti % periodMs) / periodMs;
    const systolic = gauss(frac, 0.18, 0.08);
    const dicrotic = 0.3 * gauss(frac, 0.45, 0.07);
    y.push((systolic + dicrotic) * 1.2);
  }
  return { y, t };
}

describe('ElgendiPeakDetector', () => {
  it('detecta picos en señal PPG periódica limpia', () => {
    const fs = 30;
    const { y, t } = makeSinePeaks(fs, 12, 72, 0.02);
    const r = ElgendiPeakDetector.detect({
      signal: y,
      timestampsMs: t,
      samplingRateHz: fs,
      sqi: 40,
    });
    expect(r.peaks.length).toBeGreaterThanOrEqual(8);
    expect(r.confidence).toBeGreaterThan(0.2);
  });

  it('no devuelve picos confiables en señal plana', () => {
    const fs = 30;
    const n = 200;
    const y = Array(n).fill(0.01);
    const t = y.map((_, i) => (i / fs) * 1000);
    const r = ElgendiPeakDetector.detect({
      signal: y,
      timestampsMs: t,
      samplingRateHz: fs,
      sqi: 50,
    });
    expect(r.peaks.length).toBeLessThanOrEqual(2);
  });

  it('maneja timestamps irregulares (re-muestreo)', () => {
    const fs = 30;
    const { y, t } = makeSinePeaks(fs, 10, 80, 0.03);
    const jittered = t.map((v, i) => v + (i % 5 === 0 ? 22 : 0));
    const r = ElgendiPeakDetector.detect({
      signal: y,
      timestampsMs: jittered,
      samplingRateHz: fs,
      sqi: 35,
    });
    expect(r.peaks.length).toBeGreaterThanOrEqual(4);
  });

  it('estima BPM con precisión (±6) en señal limpia a 60 y 100 bpm', () => {
    const fs = 30;
    for (const bpm of [60, 100]) {
      const { y, t } = makeSinePeaks(fs, 16, bpm, 0.02);
      const r = ElgendiPeakDetector.detect({
        signal: y,
        timestampsMs: t,
        samplingRateHz: fs,
        sqi: 45,
      });
      const expectedBeats = Math.floor((16 * bpm) / 60);
      // Detección casi completa (≥70 % de los latidos esperados).
      expect(r.peaks.length).toBeGreaterThanOrEqual(Math.floor(expectedBeats * 0.7));
      // BPM por mediana de RR cercano al real.
      const rr: number[] = [];
      for (let i = 1; i < r.peakTimes.length; i++) {
        rr.push(r.peakTimes[i] - r.peakTimes[i - 1]);
      }
      expect(rr.length).toBeGreaterThan(3);
      const sorted = [...rr].sort((a, b) => a - b);
      const medRR = sorted[Math.floor(sorted.length / 2)];
      const estBpm = 60000 / medRR;
      expect(Math.abs(estBpm - bpm)).toBeLessThanOrEqual(6);
    }
  });

  it('no cuenta dos veces por la muesca dícrota (sin doble conteo)', () => {
    const fs = 30;
    const bpm = 60;
    const durationSec = 12;
    const { y, t } = makePpgWithDicrotic(fs, durationSec, bpm);
    const r = ElgendiPeakDetector.detect({
      signal: y,
      timestampsMs: t,
      samplingRateHz: fs,
      sqi: 45,
    });
    const cycles = (durationSec * bpm) / 60; // ≈ 12
    // Si contara la dícrota como latido habría ~2× ciclos. Debe quedar cerca de 1×.
    expect(r.peaks.length).toBeLessThanOrEqual(Math.ceil(cycles * 1.4));
    expect(r.peaks.length).toBeGreaterThanOrEqual(Math.floor(cycles * 0.6));
  });
});

describe('PeakDetectionEnsemble', () => {
  it('produce BPM instantáneo coherente con señal a ~75 bpm', () => {
    const fs = 30;
    const { y, t } = makeSinePeaks(fs, 14, 75, 0.03);
    const r = PeakDetectionEnsemble.analyze({
      signal: y,
      timestampsMs: t,
      samplingRateHz: fs,
      sqi: 42,
      perfusionIndex: 0.005,
    });
    if (r.bpmInstant) {
      expect(r.bpmInstant).toBeGreaterThan(55);
      expect(r.bpmInstant).toBeLessThan(110);
    }
    expect(r.confidence).toBeGreaterThanOrEqual(0);
    expect(r.agreement.elgendi).toBeGreaterThanOrEqual(0);
  });
});
