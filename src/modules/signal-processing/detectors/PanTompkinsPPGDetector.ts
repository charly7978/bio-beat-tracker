/**
 * Detector tipo Pan–Tompkins adaptado a PPG (pendiente → energía → integración → umbral adaptativo).
 * No es detección de QRS en ECG: la salida son pulsos PPG sistólicos.
 */
import { PEAK_DETECTION_DEFAULTS } from '../../../config/signalProcessing';
import { VITAL_THRESHOLDS } from '../../../config/vitalThresholds';
import { clamp } from '../../../utils/math';
import {
  bandpassOffline,
  derivativeCentral,
  detrendLinear,
  movingWindowIntegration,
  resampleToUniformTimeline,
  robustNormalizeZeroCenter,
} from '../shared/dsp';

export interface PanTompkinsPPGInput {
  signal: number[];
  timestampsMs: number[];
  samplingRateHz: number;
  sqi?: number;
  integrationWindowMs?: number;
}

export interface PanTompkinsPPGOutput {
  peaks: number[];
  peakTimes: number[];
  integratedSignal: number[];
  derivativeSignal: number[];
  adaptiveThresholds: number[];
  searchbackEvents: number[];
  rejectedCandidates: Array<{ index: number; reason: string }>;
  confidence: number;
  diagnostics: Record<string, unknown>;
}

export class PanTompkinsPPGDetector {
  static detect(input: PanTompkinsPPGInput): PanTompkinsPPGOutput {
    const rejected: Array<{ index: number; reason: string }> = [];
    const searchbackEvents: number[] = [];
    let sig = [...input.signal];
    let ts = [...input.timestampsMs];
    let fs = input.samplingRateHz;
    const integMs = input.integrationWindowMs ?? PEAK_DETECTION_DEFAULTS.integrationWindowMs;

    if (sig.length !== ts.length || sig.length < PEAK_DETECTION_DEFAULTS.minSamplesEnsemble) {
      return {
        peaks: [],
        peakTimes: [],
        integratedSignal: [],
        derivativeSignal: [],
        adaptiveThresholds: [],
        searchbackEvents,
        rejectedCandidates: rejected,
        confidence: 0,
        diagnostics: { stage: 'insufficient_input' },
      };
    }

    const gaps: number[] = [];
    for (let i = 1; i < ts.length; i++) gaps.push(ts[i] - ts[i - 1]);
    const sortedG = [...gaps].sort((a, b) => a - b);
    const med = sortedG[Math.floor(sortedG.length / 2)] ?? 1000 / fs;
    const jitterP95 = sortedG[Math.floor(sortedG.length * 0.95)] ?? med;
    let resampled = false;
    if (jitterP95 > med * 1.45 || med < 5 || med > 120) {
      resampled = true;
      const targetN = clamp(Math.round(((ts[ts.length - 1] - ts[0]) / 1000) * fs), 64, 512);
      const r = resampleToUniformTimeline(sig, ts, targetN);
      sig = r.y;
      fs = r.fs;
      ts = new Array(sig.length);
      for (let i = 0; i < sig.length; i++) ts[i] = r.t0 + (i * (r.t1 - r.t0)) / Math.max(1, sig.length - 1);
    }

    const x = robustNormalizeZeroCenter(bandpassOffline(detrendLinear(sig), fs));
    const dx = derivativeCentral(x, fs);
    const sq = dx.map((v) => v * v);
    const win = Math.max(2, Math.round((integMs / 1000) * fs));
    const integrated = movingWindowIntegration(sq, win);

    const n = integrated.length;
    const thr: number[] = new Array(n).fill(0);
    const refractorySamples = Math.max(2, Math.round((PEAK_DETECTION_DEFAULTS.refractoryMsFromMaxBpm / 1000) * fs));

    let signalPeak = 0;
    let noisePeak = 0;
    const decay = 0.92;
    const peaks: number[] = [];
    const peakTimes: number[] = [];

    let lastPeakIdx = -refractorySamples * 2;
    let expectedRR = refractorySamples * 2;

    for (let i = 2; i < n - 2; i++) {
      const v = integrated[i];
      signalPeak = Math.max(signalPeak * decay, v);
      if (v < signalPeak * 0.4) {
        noisePeak = Math.max(noisePeak * decay, v);
      }
      const thr1 = noisePeak + 0.48 * Math.max(1e-6, signalPeak - noisePeak);
      thr[i] = thr1;

      const localMax = v >= integrated[i - 1] && v > integrated[i + 1] && v >= integrated[i - 2] && v >= integrated[i + 2];
      if (!localMax) continue;
      if (v < thr1) continue;
      if (i - lastPeakIdx < refractorySamples) {
        rejected.push({ index: i, reason: 'REFRACTORY' });
        continue;
      }

      // Searchback conservador: solo tras pausa larga y con umbral menos agresivo
      if (i - lastPeakIdx > expectedRR * 2.15 && lastPeakIdx >= 0) {
        const relaxed = noisePeak + 0.36 * Math.max(1e-6, signalPeak - noisePeak);
        if (v < relaxed) continue;
        searchbackEvents.push(i);
      }

      peaks.push(i);
      peakTimes.push(ts[i] ?? ts[ts.length - 1]);
      lastPeakIdx = i;
      if (peaks.length >= 2) {
        const d = peaks[peaks.length - 1] - peaks[peaks.length - 2];
        expectedRR = clamp(d, refractorySamples, Math.round((60000 / VITAL_THRESHOLDS.HR.MIN / 1000) * fs));
      }
    }

    const rrMs: number[] = [];
    for (let k = 1; k < peakTimes.length; k++) {
      const dt = peakTimes[k] - peakTimes[k - 1];
      if (dt >= VITAL_THRESHOLDS.HR.PHYSIOLOGICAL_RR_MIN_MS && dt <= VITAL_THRESHOLDS.HR.PHYSIOLOGICAL_RR_MAX_MS) {
        rrMs.push(dt);
      }
    }

    let confidence = rrMs.length ? clamp(rrMs.length / 5, 0, 1) * 0.5 + clamp(peaks.length / 8, 0, 1) * 0.5 : 0;
    if (typeof input.sqi === 'number' && input.sqi < PEAK_DETECTION_DEFAULTS.minSQI) confidence *= 0.5;

    return {
      peaks,
      peakTimes,
      integratedSignal: integrated,
      derivativeSignal: dx,
      adaptiveThresholds: thr,
      searchbackEvents,
      rejectedCandidates: rejected,
      confidence,
      diagnostics: {
        fsEffective: fs,
        integrationSamples: win,
        resampled,
        searchbackCount: searchbackEvents.length,
      },
    };
  }
}
