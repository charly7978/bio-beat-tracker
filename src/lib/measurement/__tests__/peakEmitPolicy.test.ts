import { describe, expect, it } from 'vitest';
import { decidePeakEmit, bpmFromEmittedRr } from '../peakEmitPolicy';
import type { PeakDetectionResult } from '@/types/measurements';

function buildTestPeakResult(
  peakTimes: number[],
  peakScores?: number[],
): PeakDetectionResult {
  return {
    peaks: peakTimes.map((_, i) => 80 + i),
    peakTimes,
    peakScores:
      peakScores ?? peakTimes.map(() => 0.5),
    rrIntervalsMs: [],
    bpmInstant: 72,
    bpmStable: 72,
    confidence: 0.35,
    agreement: { elgendi: 0.4 },
    rejectedPeaks: [],
    diagnostics: { elgendiConfidence: 0.35 },
  };
}

describe('peakEmitPolicy', () => {
  it('emite pico en borde vivo con dedo confirmado', () => {
    const ens = buildTestPeakResult([5000], [0.65]);
    const d = decidePeakEmit({
      ens,
      lastEmittedPeakMs: 0,
      minPeakConf: 0.1,
      sampleRateHz: 30,
      windowSamples: 90,
      fingerContactConfirmed: true,
      nowMs: 5100,
      emittedPeakCount: 2,
      sqi: 50,
      perfusionIndex: 0.005,
    });
    expect(d.emit).toBe(true);
    expect(d.peakTimeMs).toBe(5000);
  });

  it('no emite sin dedo confirmado', () => {
    const ens = buildTestPeakResult([5000]);
    const d = decidePeakEmit({
      ens,
      lastEmittedPeakMs: 0,
      minPeakConf: 0.17,
      sampleRateHz: 30,
      windowSamples: 90,
      fingerContactConfirmed: false,
    });
    expect(d.emit).toBe(false);
  });

  it('prefiere el pico más reciente en la ventana viva', () => {
    const ens = buildTestPeakResult([4900, 5050], [0.65, 0.66]);
    const d = decidePeakEmit({
      ens,
      lastEmittedPeakMs: 0,
      minPeakConf: 0.1,
      sampleRateHz: 30,
      windowSamples: 90,
      fingerContactConfirmed: true,
      nowMs: 5100,
      emittedPeakCount: 2,
    });
    expect(d.emit).toBe(true);
    expect(d.peakTimeMs).toBe(5050);
  });

  it('no emite dos picos dentro del refractario fisiológico', () => {
    const ens = buildTestPeakResult([5000, 5120], [0.65, 0.66]);
    const first = decidePeakEmit({
      ens,
      lastEmittedPeakMs: 0,
      minPeakConf: 0.1,
      sampleRateHz: 30,
      windowSamples: 90,
      fingerContactConfirmed: true,
      nowMs: 5100,
      emittedPeakCount: 2,
    });
    expect(first.emit).toBe(true);
    const second = decidePeakEmit({
      ens,
      lastEmittedPeakMs: first.peakTimeMs,
      minPeakConf: 0.14,
      sampleRateHz: 30,
      windowSamples: 90,
      fingerContactConfirmed: true,
    });
    expect(second.emit).toBe(false);
  });

  it('no re-emite el mismo pico', () => {
    const ens = buildTestPeakResult([5000]);
    const d = decidePeakEmit({
      ens,
      lastEmittedPeakMs: 5000,
      minPeakConf: 0.14,
      sampleRateHz: 30,
      windowSamples: 90,
    });
    expect(d.emit).toBe(false);
  });

  it('refractario de arranque (300 ms) bloquea un segundo pico demasiado cercano', () => {
    // Sin RR previo el refractario es 300 ms; un pico a 220 ms (típico de muesca
    // dícrota / ruido) debe rechazarse. (Antes, con 216 ms, se emitía → falso positivo.)
    const ens = buildTestPeakResult([5220], [0.7]);
    const d = decidePeakEmit({
      ens,
      lastEmittedPeakMs: 5000,
      minPeakConf: 0.1,
      sampleRateHz: 30,
      windowSamples: 90,
      fingerContactConfirmed: true,
      nowMs: 5260,
      emittedPeakCount: 1,
      recentRrMs: [],
    });
    expect(d.emit).toBe(false);
  });

  it('acepta latido a HR alta (~140 bpm, RR 430 ms) fuera del refractario', () => {
    // Refractario = max(300, 0.5·430) = 300 ms; 430 ms > 300 ms → se emite.
    const ens = buildTestPeakResult([5430], [0.7]);
    const d = decidePeakEmit({
      ens,
      lastEmittedPeakMs: 5000,
      minPeakConf: 0.1,
      sampleRateHz: 30,
      windowSamples: 90,
      fingerContactConfirmed: true,
      nowMs: 5480,
      emittedPeakCount: 5,
      recentRrMs: [430, 430, 430],
    });
    expect(d.emit).toBe(true);
    expect(d.peakTimeMs).toBe(5430);
  });

  it('bpmFromEmittedRr usa mediana RR', () => {
    expect(bpmFromEmittedRr([800, 820, 810])).toBeCloseTo(74.07, 0);
  });
});
