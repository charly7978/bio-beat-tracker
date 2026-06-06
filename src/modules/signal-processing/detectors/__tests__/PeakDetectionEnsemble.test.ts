import { describe, it, expect } from 'vitest';
import { PeakDetectionEnsemble } from '../PeakDetectionEnsemble';

function sineSignal(fs: number, hrBpm: number, amplitude: number, dc: number, n: number): { signal: number[]; times: number[] } {
  const signal: number[] = [];
  const times: number[] = [];
  const hrHz = hrBpm / 60;
  for (let i = 0; i < n; i++) {
    const t = (i / fs) * 1000;
    signal.push(dc + amplitude * Math.sin(2 * Math.PI * hrHz * (i / fs)));
    times.push(t);
  }
  return { signal, times };
}

describe('PeakDetectionEnsemble', () => {
  it('returns empty result for insufficient samples', () => {
    const r = PeakDetectionEnsemble.analyze({
      signal: [1, 2, 3],
      timestampsMs: [0, 33, 66],
      samplingRateHz: 30,
    });
    expect(r.peaks).toHaveLength(0);
    expect(r.confidence).toBe(0);
    expect(r.bpmInstant).toBeNull();
  });

  it('detects peaks in clean 72 BPM sine signal', () => {
    const { signal, times } = sineSignal(30, 72, 8, 180, 300);
    const r = PeakDetectionEnsemble.analyze({
      signal,
      timestampsMs: times,
      samplingRateHz: 30,
      sqi: 75,
      perfusionIndex: 0.005,
    });
    expect(r.peaks.length).toBeGreaterThanOrEqual(2);
    expect(r.bpmInstant).toBeGreaterThan(60);
    expect(r.bpmInstant).toBeLessThan(85);
    expect(r.confidence).toBeGreaterThan(0.3);
    expect(r.rrIntervalsMs.length).toBeGreaterThanOrEqual(1);
    for (const rr of r.rrIntervalsMs) {
      expect(rr).toBeGreaterThan(600);
      expect(rr).toBeLessThan(1200);
    }
  });

  it('detects peaks in clean 120 BPM sine signal', () => {
    const { signal, times } = sineSignal(30, 120, 8, 180, 300);
    const r = PeakDetectionEnsemble.analyze({
      signal,
      timestampsMs: times,
      samplingRateHz: 30,
      sqi: 80,
      perfusionIndex: 0.008,
    });
    expect(r.peaks.length).toBeGreaterThanOrEqual(3);
    expect(r.bpmInstant).toBeGreaterThan(100);
    expect(r.bpmInstant).toBeLessThan(140);
  });

  it('handles noise-only signal without errors', () => {
    const signal: number[] = [];
    const times: number[] = [];
    for (let i = 0; i < 200; i++) {
      signal.push(150 + (Math.random() - 0.5) * 1.5);
      times.push((i / 30) * 1000);
    }
    const r = PeakDetectionEnsemble.analyze({
      signal,
      timestampsMs: times,
      samplingRateHz: 30,
      sqi: 8,
      perfusionIndex: 0.0001,
    });
    expect(Number.isFinite(r.confidence)).toBe(true);
    expect(r.peaks).toBeDefined();
    expect(r.rrIntervalsMs).toBeDefined();
  });

  it('rejects non-physiological RR intervals', () => {
    const { signal, times } = sineSignal(30, 72, 8, 180, 300);
    const r = PeakDetectionEnsemble.analyze({
      signal,
      timestampsMs: times,
      samplingRateHz: 30,
      sqi: 75,
    });
    for (const rr of r.rrIntervalsMs) {
      expect(rr).toBeGreaterThan(300);
      expect(rr).toBeLessThan(2000);
    }
  });

  it('handles signal with NaN values gracefully', () => {
    const { signal, times } = sineSignal(30, 72, 8, 180, 300);
    signal[50] = NaN;
    signal[100] = NaN;
    const r = PeakDetectionEnsemble.analyze({
      signal,
      timestampsMs: times,
      samplingRateHz: 30,
    });
    expect(r.peaks).toBeDefined();
    expect(Number.isFinite(r.confidence)).toBe(true);
  });

  it('propagates diagnostics metadata', () => {
    const { signal, times } = sineSignal(30, 72, 8, 180, 200);
    const r = PeakDetectionEnsemble.analyze({
      signal,
      timestampsMs: times,
      samplingRateHz: 30,
      sqi: 80,
      perfusionIndex: 0.01,
    });
    expect(r.diagnostics).toBeDefined();
    expect(r.diagnostics.elgendiConfidence).toBeDefined();
    expect(r.diagnostics.fsDeclared).toBe(30);
    expect(r.diagnostics.fsEffective).toBeGreaterThan(0);
    expect(r.diagnostics.fusedCount).toBeGreaterThan(0);
  });

  it('adapts sample rate when timestamps mismatch declared rate', () => {
    const fs = 30;
    const signal: number[] = [];
    const times: number[] = [];
    const jitteredFs = 22;
    for (let i = 0; i < 200; i++) {
      signal.push(180 + 8 * Math.sin(2 * Math.PI * 1.2 * (i / fs)));
      times.push((i / jitteredFs) * 1000);
    }
    const r = PeakDetectionEnsemble.analyze({
      signal,
      timestampsMs: times,
      samplingRateHz: fs,
    });
    expect(r.diagnostics.fsAdapted).toBe(true);
    expect((r.diagnostics.fsEffective as number) - jitteredFs).toBeLessThan(3);
  });
});
