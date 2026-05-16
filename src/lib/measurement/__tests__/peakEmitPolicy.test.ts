import { describe, expect, it } from 'vitest';
import { decidePeakEmit, bpmFromEmittedRr } from '../peakEmitPolicy';
import type { PeakDetectionResult } from '@/types/measurements';

function mockEns(peakTimes: number[], sources: Array<'dual' | 'solo_elgendi'>): PeakDetectionResult {
  return {
    peaks: peakTimes.map((_, i) => 80 + i),
    peakTimes,
    peakSources: sources,
    rrIntervalsMs: [],
    bpmInstant: 72,
    bpmStable: 72,
    confidence: 0.35,
    agreement: { elgendi: 0.4, panTompkins: 0.35, spectral: 0.3, autocorrelation: 0.25 },
    rejectedPeaks: [],
    diagnostics: { elgendiConfidence: 0.35, panTompkinsConfidence: 0.3 },
  };
}

describe('peakEmitPolicy', () => {
  it('emite pico dual en borde vivo', () => {
    const ens = mockEns([5000], ['dual']);
    const d = decidePeakEmit({
      ens,
      lastEmittedPeakMs: 0,
      minPeakConf: 0.17,
      consensusMin: 0.15,
      allowSoloElgendi: true,
      sampleRateHz: 30,
      windowSamples: 90,
      fingerContactConfirmed: true,
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
      fingerContactConfirmed: true,
    });
    expect(d.emit).toBe(true);
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
