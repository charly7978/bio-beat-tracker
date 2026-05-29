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
    // Refractario fijo 300 ms; 430 ms > 300 ms → se emite.
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

  it('emite latido con RR irregular (arritmia) — sin gate de regularidad ni stall', () => {
    // Tras ritmo ~1000 ms, un latido prematuro a 600 ms del último DEBE emitirse.
    // (Antes, la plausibilidad RR lo rechazaba → bloqueo permanente y se perdían
    // las arritmias.) Ahora solo aplica el refractario fijo (600 ms > 300 ms).
    const ens = buildTestPeakResult([5600], [0.55]);
    const d = decidePeakEmit({
      ens,
      lastEmittedPeakMs: 5000,
      minPeakConf: 0.1,
      sampleRateHz: 30,
      windowSamples: 90,
      fingerContactConfirmed: true,
      nowMs: 5650,
      emittedPeakCount: 8,
      recentRrMs: [1000, 1000, 1000],
      sqi: 50,
      perfusionIndex: 0.005,
    });
    expect(d.emit).toBe(true);
    expect(d.peakTimeMs).toBe(5600);
  });

  it('no se bloquea tras un latido perdido (re-sincroniza con RR largo ~2x)', () => {
    // Un latido perdido produce un RR ≈ 2× la mediana. No debe rechazarse
    // (no hay gate de regularidad) → la detección se re-sincroniza sola.
    const ens = buildTestPeakResult([6000], [0.55]);
    const d = decidePeakEmit({
      ens,
      lastEmittedPeakMs: 5000,
      minPeakConf: 0.1,
      sampleRateHz: 30,
      windowSamples: 90,
      fingerContactConfirmed: true,
      nowMs: 6050,
      emittedPeakCount: 8,
      recentRrMs: [500, 500, 500],
      sqi: 50,
      perfusionIndex: 0.005,
    });
    expect(d.emit).toBe(true);
    expect(d.peakTimeMs).toBe(6000);
  });

  it('rechaza pico imposiblemente temprano (<45% del RR mediano) — anti dícrota a HR baja', () => {
    // Ritmo ~1000 ms; un pico a 380 ms del último supera el refractario (300 ms)
    // pero es < 0.45×1000 = 450 ms → probable muesca dícrota → se rechaza.
    const ens = buildTestPeakResult([5380], [0.7]);
    const d = decidePeakEmit({
      ens,
      lastEmittedPeakMs: 5000,
      minPeakConf: 0.1,
      sampleRateHz: 30,
      windowSamples: 90,
      fingerContactConfirmed: true,
      nowMs: 5430,
      recentRrMs: [1000, 1000, 1000],
      sqi: 50,
      perfusionIndex: 0.005,
    });
    expect(d.emit).toBe(false);
  });

  it('bpmFromEmittedRr usa mediana RR', () => {
    expect(bpmFromEmittedRr([800, 820, 810])).toBeCloseTo(74.07, 0);
  });

  // ── Anti-arranque-errático (Elgendi 2016 skewness + NeuroKit2 ho2025 concordance)
  describe('warm-up anti errático', () => {
    it('rechaza emisión en warm-up si skewness < umbral (señal corrupta)', () => {
      const ens = buildTestPeakResult([5000], [0.65]);
      const d = decidePeakEmit({
        ens,
        lastEmittedPeakMs: 0,
        minPeakConf: 0.1,
        sampleRateHz: 30,
        windowSamples: 90,
        fingerContactConfirmed: true,
        nowMs: 5100,
        emittedPeakCount: 1, // warm-up
        signalSkewness: 0.05, // muy baja → corrupta
      });
      expect(d.emit).toBe(false);
      expect(d.reason).toBe('LOW_SKEWNESS');
    });

    it('rechaza emisión en warm-up si acuerdo Elgendi < umbral', () => {
      const ens = buildTestPeakResult([5000], [0.65]);
      const d = decidePeakEmit({
        ens,
        lastEmittedPeakMs: 0,
        minPeakConf: 0.1,
        sampleRateHz: 30,
        windowSamples: 90,
        fingerContactConfirmed: true,
        nowMs: 5100,
        emittedPeakCount: 0, // warm-up
        signalSkewness: 0.6, // limpia
        elgendiAgreement: 0.3, // bajo → detector no firme
      });
      expect(d.emit).toBe(false);
      expect(d.reason).toBe('LOW_AGREEMENT');
    });

    it('rechaza emisión en warm-up si weightedScore < umbral', () => {
      const ens = buildTestPeakResult([5000], [0.10]); // score muy bajo
      const d = decidePeakEmit({
        ens,
        lastEmittedPeakMs: 0,
        minPeakConf: 0.05,
        sampleRateHz: 30,
        windowSamples: 90,
        fingerContactConfirmed: true,
        nowMs: 5100,
        emittedPeakCount: 1, // warm-up
        signalSkewness: 0.6,
        elgendiAgreement: 0.8,
      });
      expect(d.emit).toBe(false);
      expect(d.reason).toBe('WARMUP_LOW_SCORE');
    });

    it('post-warm-up acepta con métricas más laxas (no aplica gating)', () => {
      const ens = buildTestPeakResult([5000], [0.30]); // score moderado
      const d = decidePeakEmit({
        ens,
        lastEmittedPeakMs: 0,
        minPeakConf: 0.1,
        sampleRateHz: 30,
        windowSamples: 90,
        fingerContactConfirmed: true,
        nowMs: 5100,
        emittedPeakCount: 10, // fuera de warm-up
        signalSkewness: 0.05, // baja, pero no debe gatear ya
        elgendiAgreement: 0.3, // bajo, idem
      });
      expect(d.emit).toBe(true);
      expect(d.peakTimeMs).toBe(5000);
    });

    it('warm-up con skewness alta + agreement alto + score alto: emite', () => {
      const ens = buildTestPeakResult([5000], [0.65]);
      const d = decidePeakEmit({
        ens,
        lastEmittedPeakMs: 0,
        minPeakConf: 0.1,
        sampleRateHz: 30,
        windowSamples: 90,
        fingerContactConfirmed: true,
        nowMs: 5100,
        emittedPeakCount: 2, // warm-up
        signalSkewness: 0.5,
        elgendiAgreement: 0.8,
      });
      expect(d.emit).toBe(true);
    });
  });
});
