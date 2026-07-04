/**
 * Detector de picos sistólicos PPG — MSPTD / AMPD.
 *
 *   Bishop SM, Ercole A (2018) "Multi-scale peak and trough detection optimised
 *   for systolic blood pressure pulse waveform analysis." — sobre el AMPD de
 *   Scholkmann F, Boss J, Wolf M (2012) "An Efficient Algorithm for Automatic
 *   Peak Detection in Noisy Periodic and Quasi-Periodic Signals", Algorithms 5(4).
 *
 * En el benchmark abierto de Charlton et al. (2022, Physiol. Meas. 43 085007)
 * MSPTD queda entre los mejores detectores de latido PPG (F1 ≈ 96–97 %), junto a
 * Elgendi. Es paramétrico-libre: no usa umbral de amplitud ni de energía, sino un
 * "Local Maxima Scalogram" (LMS) multiescala. Por eso es COMPLEMENTARIO a Elgendi
 * (umbral energético): fusionar ambos capta latidos que uno solo pierde.
 *
 * Algoritmo (idéntico a la implementación de referencia `msptd_beat_detector.m`):
 *   1. Acondicionar señal (Hampel + detrend + banda 0.5–8 Hz + normalización).
 *   2. LMS: m[k][i] = TRUE si x[i] es máximo local a escala k (x[i]>x[i-k] y
 *      x[i]>x[i+k]), para k = 1..L.
 *   3. γ[k] = Σ_i m[k][i] (nº de máximos locales a esa escala).
 *   4. λ = argmax_k γ[k]  (escala de "remodelado" con más máximos locales).
 *   5. Pico = índice que es máximo local en TODAS las escalas 1..λ.
 */
import { PEAK_DETECTION_DEFAULTS } from '../../../config/signalProcessing';
import { VITAL_THRESHOLDS } from '../../../config/vitalThresholds';
import { clamp } from '../../../utils/math';
import {
  bandpassOffline,
  detrendLinear,
  hampel1D,
  prepareUniformPpgWindow,
  robustNormalizeZeroCenter,
} from '../shared/dsp';

export interface MsptdPeakDetectorInput {
  signal: number[];
  timestampsMs: number[];
  samplingRateHz: number;
  sqi?: number;
  minBpm?: number;
}

export interface MsptdPeakDetectorOutput {
  /** Índices de pico referidos a la ventana ORIGINAL (para fusión con Elgendi). */
  peaks: number[];
  peakTimes: number[];
  confidence: number;
  reason: string;
  diagnostics: Record<string, unknown>;
}

const EMPTY = (reason: string, diagnostics: Record<string, unknown> = {}): MsptdPeakDetectorOutput => ({
  peaks: [],
  peakTimes: [],
  confidence: 0,
  reason,
  diagnostics,
});

export class MsptdPeakDetector {
  static detect(input: MsptdPeakDetectorInput): MsptdPeakDetectorOutput {
    const minBpm = input.minBpm ?? PEAK_DETECTION_DEFAULTS.minBpm;
    const nSig = input.signal.length;

    if (nSig !== input.timestampsMs.length || nSig < PEAK_DETECTION_DEFAULTS.minSamplesEnsemble) {
      return EMPTY('INSUFFICIENT_WINDOW');
    }

    // 1) Remuestreo uniforme (mismo front-end temporal que Elgendi → los dos
    //    detectores difieren SÓLO en la regla de decisión, no en el pre-proceso).
    const uniform = prepareUniformPpgWindow(input.signal, input.timestampsMs, input.samplingRateHz);
    const ts = uniform.timestampsMs;
    const fs = uniform.samplingRateHz;
    const n = uniform.signal.length;

    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(uniform.signal[i])) return EMPTY('NO_VALID_SIGNAL', { nonFinite: true });
    }

    const hampelWin = Math.max(5, Math.round(fs * 0.25) | 1);
    const cleaned = hampel1D(uniform.signal, hampelWin, 3);
    const x = robustNormalizeZeroCenter(bandpassOffline(detrendLinear(cleaned), fs));

    // 2-3) LMS: γ[k] = nº de máximos locales a la escala k. Sin materializar la
    // matriz: se recorre por escala y se acumula el conteo. L se acota a media
    // periodo del RR más lento (la escala de remodelado nunca lo excede) → coste
    // O(n·L) acotado y sin sobre-suavizar.
    const maxHalfPeriodSamples = Math.round((fs * (60 / minBpm)) * 0.5) + 2;
    const L = Math.max(1, Math.min(Math.floor(n / 2) - 1, maxHalfPeriodSamples));

    let lambda = 1;
    let bestGamma = -1;
    for (let k = 1; k <= L; k++) {
      let gamma = 0;
      for (let i = k; i < n - k; i++) {
        if (x[i] > x[i - k] && x[i] > x[i + k]) gamma++;
      }
      // argmax (primer máximo, como MATLAB `max`): la escala con más máximos locales.
      if (gamma > bestGamma) {
        bestGamma = gamma;
        lambda = k;
      }
    }

    // 4-5) Pico = máximo local en TODAS las escalas 1..λ. Los picos a < λ muestras
    // del borde quedan excluidos (como en MSPTD); el rescate opera en el interior.
    const peakIdxUniform: number[] = [];
    for (let i = lambda; i < n - lambda; i++) {
      let isPeak = true;
      const xi = x[i];
      for (let k = 1; k <= lambda; k++) {
        if (!(xi > x[i - k] && xi > x[i + k])) {
          isPeak = false;
          break;
        }
      }
      if (isPeak) peakIdxUniform.push(i);
    }

    // Mapear a la ventana ORIGINAL por timestamp más cercano (los índices de la
    // rejilla remuestreada no coinciden 1:1 con la ventana de entrada).
    const peaks: number[] = [];
    const peakTimes: number[] = [];
    for (const iu of peakIdxUniform) {
      const t = ts[iu] ?? ts[ts.length - 1];
      peakTimes.push(t);
      peaks.push(nearestIndexByTime(input.timestampsMs, t));
    }

    // Confianza: regularidad RR + nº de latidos (misma escala que Elgendi).
    const rr: number[] = [];
    for (let k = 1; k < peakTimes.length; k++) {
      const d = peakTimes[k] - peakTimes[k - 1];
      if (
        d >= VITAL_THRESHOLDS.HR.PHYSIOLOGICAL_RR_MIN_MS &&
        d <= VITAL_THRESHOLDS.HR.PHYSIOLOGICAL_RR_MAX_MS
      ) {
        rr.push(d);
      }
    }
    let rrRegularity = 0;
    if (rr.length >= 3) {
      const m = rr.reduce((a, b) => a + b, 0) / rr.length;
      const v = rr.reduce((a, b) => a + (b - m) ** 2, 0) / rr.length;
      const cv = Math.sqrt(v) / Math.max(1, m);
      rrRegularity = clamp(1 - cv / 0.35, 0, 1);
    }
    let confidence =
      rr.length > 0
        ? clamp(rr.length / 6, 0, 1) * 0.4 +
          clamp(peaks.length / 8, 0, 1) * 0.3 +
          rrRegularity * 0.3
        : 0;
    if (typeof input.sqi === 'number' && input.sqi < PEAK_DETECTION_DEFAULTS.minSQI) {
      confidence *= 0.5;
    }

    return {
      peaks,
      peakTimes,
      confidence,
      reason: peaks.length > 0 ? 'OK' : 'NO_PEAKS',
      diagnostics: { lambda, L, fsEffective: fs, rrCount: rr.length, resampled: uniform.resampled },
    };
  }
}

/** Índice de `timestamps` cuyo valor es más cercano a `t` (búsqueda lineal, n≤512). */
function nearestIndexByTime(timestamps: number[], t: number): number {
  let best = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < timestamps.length; i++) {
    const d = Math.abs(timestamps[i] - t);
    if (d < bestDiff) {
      bestDiff = d;
      best = i;
    }
  }
  return best;
}
