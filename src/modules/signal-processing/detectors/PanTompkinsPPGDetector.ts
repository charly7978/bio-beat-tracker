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
  prepareUniformPpgWindow,
  robustNormalizeZeroCenter,
} from '../shared/dsp';

export interface PanTompkinsPPGInput {
  signal: number[];
  timestampsMs: number[];
  samplingRateHz: number;
  sqi?: number;
  integrationWindowMs?: number;
  /** Umbral adaptativo (0.32–0.58); menor = más sensible a latidos débiles */
  thresholdFactor?: number;
  searchbackFactor?: number;
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
    const integMs = input.integrationWindowMs ?? PEAK_DETECTION_DEFAULTS.integrationWindowMs;
    const thrFactor = input.thresholdFactor ?? PEAK_DETECTION_DEFAULTS.CALIBRATION.PAN_THRESHOLD_BASE;
    const sbFactor =
      input.searchbackFactor ??
      thrFactor * PEAK_DETECTION_DEFAULTS.CALIBRATION.PAN_SEARCHBACK_RELAXED_FRAC;

    if (input.signal.length !== input.timestampsMs.length || input.signal.length < PEAK_DETECTION_DEFAULTS.minSamplesEnsemble) {
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

    const uniform = prepareUniformPpgWindow(input.signal, input.timestampsMs, input.samplingRateHz);
    const sig = uniform.signal;
    const ts = uniform.timestampsMs;
    const fs = uniform.samplingRateHz;
    const resampled = uniform.resampled;

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
      const span = Math.max(1e-6, signalPeak - noisePeak);
      const thr1 = noisePeak + thrFactor * span;
      thr[i] = thr1;

      const localMax = v >= integrated[i - 1] && v > integrated[i + 1] && v >= integrated[i - 2] && v >= integrated[i + 2];
      if (!localMax) continue;
      if (v < thr1) continue;
      if (i - lastPeakIdx < refractorySamples) {
        rejected.push({ index: i, reason: 'REFRACTORY' });
        continue;
      }

      // Searchback: tras pausa larga, umbral relajado calibrado
      if (i - lastPeakIdx > expectedRR * 2.15 && lastPeakIdx >= 0) {
        const relaxed = noisePeak + sbFactor * span;
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
