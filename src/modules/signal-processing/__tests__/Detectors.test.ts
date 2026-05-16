import { describe, it, expect } from 'vitest';
import { ElgendiPeakDetector } from '../detectors/ElgendiPeakDetector';
import { PanTompkinsPPGDetector } from '../detectors/PanTompkinsPPGDetector';
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
});

describe('PanTompkinsPPGDetector', () => {
  it('detecta pulsos en señal con pendiente marcada', () => {
    const fs = 30;
    const { y, t } = makeSinePeaks(fs, 12, 70, 0.04);
    const r = PanTompkinsPPGDetector.detect({
      signal: y,
      timestampsMs: t,
      samplingRateHz: fs,
      sqi: 38,
    });
    expect(r.peaks.length).toBeGreaterThanOrEqual(6);
    expect(r.integratedSignal.length).toBe(y.length);
  });

  it('señal plana → pocos o ningún pico', () => {
    const fs = 30;
    const n = 180;
    const y = Array(n).fill(0.001);
    const t = y.map((_, i) => (i / fs) * 1000);
    const r = PanTompkinsPPGDetector.detect({
      signal: y,
      timestampsMs: t,
      samplingRateHz: fs,
      sqi: 40,
    });
    expect(r.peaks.length).toBeLessThanOrEqual(3);
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
    const cal = (r.diagnostics as { detectorCalibration?: { fusionToleranceMs: number } })
      .detectorCalibration;
    expect(cal?.fusionToleranceMs).toBeGreaterThan(150);
  });
});
