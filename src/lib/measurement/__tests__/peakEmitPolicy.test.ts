import { describe, expect, it } from 'vitest';
import { decidePeakEmit, bpmFromEmittedRr } from '../peakEmitPolicy';
import type { PeakDetectionResult } from '@/types/measurements';

function mockEns(
  peakTimes: number[],
  sources: Array<'dual' | 'solo_elgendi' | 'solo_pan'>,
  peakScores?: number[],
): PeakDetectionResult {
  return {
    peaks: peakTimes.map((_, i) => 80 + i),
    peakTimes,
    peakSources: sources,
    peakScores:
      peakScores ??
      sources.map((s) => (s === 'dual' ? 0.65 : 0.64)),
    rrIntervalsMs: [],
    bpmInstant: 72,
    bpmStable: 72,
    confidence: 0.35,
    agreement: { elgendi: 0.4, panTompkins: 0.35, spectral: 0.55, autocorrelation: 0.25 },
    rejectedPeaks: [],
    diagnostics: { elgendiConfidence: 0.35, panTompkinsConfidence: 0.3 },
  };
}

describe('peakEmitPolicy', () => {
  it('emite pico dual en borde vivo', () => {
    const ens = mockEns([5000], ['dual'], [0.65]);
    const d = decidePeakEmit({
      ens,
      lastEmittedPeakMs: 0,
      minPeakConf: 0.1,
      consensusMin: 0.12,
      allowSoloElgendi: true,
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

  it('no emite solo_elgendi sin dedo confirmado', () => {
    const ens = mockEns([5000], ['solo_elgendi']);
    const d = decidePeakEmit({
      ens,
      lastEmittedPeakMs: 0,
      minPeakConf: 0.17,
      consensusMin: 0.15,
      allowSoloElgendi: true,
      sampleRateHz: 30,
      windowSamples: 90,
      placementMode: 'hybrid',
      fingerContactConfirmed: false,
    });
    expect(d.emit).toBe(false);
  });

  it('emite solo_elgendi en hybrid solo con dedo confirmado y conf alta', () => {
    const ens = mockEns([5000], ['solo_elgendi'], [0.62]);
    const d = decidePeakEmit({
      ens,
      lastEmittedPeakMs: 0,
      minPeakConf: 0.1,
      consensusMin: 0.12,
      allowSoloElgendi: true,
      sampleRateHz: 30,
      windowSamples: 90,
      placementMode: 'hybrid',
      fingerContactConfirmed: true,
      nowMs: 5200,
      emittedPeakCount: 2,
      sqi: 50,
      perfusionIndex: 0.005,
    });
    expect(d.emit).toBe(true);
  });

  it('no emite solo como primer latido (exige dual inicial)', () => {
    const ens = mockEns([5000], ['solo_elgendi'], [0.62]);
    const d = decidePeakEmit({
      ens,
      lastEmittedPeakMs: 0,
      minPeakConf: 0.1,
      consensusMin: 0.12,
      allowSoloElgendi: true,
      sampleRateHz: 30,
      windowSamples: 90,
      fingerContactConfirmed: true,
      nowMs: 5200,
      emittedPeakCount: 0,
    });
    expect(d.emit).toBe(false);
  });

  it('modo reacquire permite solo_elgendi tras stall sin dual', () => {
    const ens = mockEns([5000], ['solo_elgendi'], [0.64]);
    const d = decidePeakEmit({
      ens,
      lastEmittedPeakMs: 2000,
      minPeakConf: 0.1,
      consensusMin: 0.12,
      allowSoloElgendi: true,
      sampleRateHz: 30,
      windowSamples: 90,
      fingerContactConfirmed: true,
      nowMs: 5200,
      emittedPeakCount: 0,
      peakStallMs: 3200,
      reacquireMode: true,
      sqi: 50,
      perfusionIndex: 0.005,
    });
    expect(d.emit).toBe(true);
    expect(d.reason).toBe('SOLO_ELGENDI');
  });

  it('prefiere el pico más reciente en la ventana viva', () => {
    const ens = mockEns([4900, 5050], ['dual', 'dual'], [0.65, 0.66]);
    const d = decidePeakEmit({
      ens,
      lastEmittedPeakMs: 0,
      minPeakConf: 0.1,
      consensusMin: 0.12,
      allowSoloElgendi: true,
      sampleRateHz: 30,
      windowSamples: 90,
      fingerContactConfirmed: true,
      nowMs: 5100,
      emittedPeakCount: 2,
    });
    expect(d.emit).toBe(true);
    expect(d.peakTimeMs).toBe(5050);
  });

  it('sin dedo confirmado solo acepta dual estricto', () => {
    const ens = mockEns([5000], ['solo_elgendi']);
    expect(
      decidePeakEmit({
        ens,
        lastEmittedPeakMs: 0,
        minPeakConf: 0.17,
        consensusMin: 0.15,
        allowSoloElgendi: true,
        sampleRateHz: 30,
        windowSamples: 90,
        placementMode: 'tip',
        fingerContactConfirmed: false,
      }).emit,
    ).toBe(false);
  });

  it('no emite dos picos dentro del refractario fisiológico', () => {
    const ens = mockEns([5000, 5120], ['dual', 'dual'], [0.65, 0.66]);
    const first = decidePeakEmit({
      ens,
      lastEmittedPeakMs: 0,
      minPeakConf: 0.1,
      consensusMin: 0.12,
      allowSoloElgendi: true,
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
      consensusMin: 0.15,
      allowSoloElgendi: true,
      sampleRateHz: 30,
      windowSamples: 90,
      fingerContactConfirmed: true,
    });
    expect(second.emit).toBe(false);
  });

  it('no re-emite el mismo pico', () => {
    const ens = mockEns([5000], ['dual']);
    const d = decidePeakEmit({
      ens,
      lastEmittedPeakMs: 5000,
      minPeakConf: 0.14,
      consensusMin: 0.15,
      allowSoloElgendi: true,
      sampleRateHz: 30,
      windowSamples: 90,
    });
    expect(d.emit).toBe(false);
  });

  it('bpmFromEmittedRr usa mediana RR', () => {
    expect(bpmFromEmittedRr([800, 820, 810])).toBeCloseTo(74.07, 0);
  });
});
